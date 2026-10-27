# The sidecar task is independent of Codex and never edits Codex configuration.
function Get-GeminiBridgeRoot([string]$Directory) {
    if ([string]::IsNullOrWhiteSpace($Directory) -or $Directory -match '[\x00-\x1f"]' -or $Directory -notmatch '^[A-Za-z]:[\\/]') {
        throw 'An absolute local bridge directory is required.'
    }
    $absolute = [IO.Path]::GetFullPath($Directory).TrimEnd([char[]]'\/')
    if ($absolute.Length -le 2) { throw 'A dedicated bridge directory is required.' }
    if (-not [IO.Directory]::Exists($absolute)) { throw 'The bridge directory does not exist.' }
    if (-not ('CodexGeminiBridge.NativePaths' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace CodexGeminiBridge {
  public static class NativePaths {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
  }
}
'@
    }
    $handle = [CodexGeminiBridge.NativePaths]::CreateFile($absolute, 0, 7, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
    if ($handle.IsInvalid) { throw 'The physical bridge directory could not be verified.' }
    try {
        $buffer = New-Object Text.StringBuilder 32768
        $length = [CodexGeminiBridge.NativePaths]::GetFinalPathNameByHandle($handle, $buffer, $buffer.Capacity, 0)
        if ($length -eq 0 -or $length -ge $buffer.Capacity) { throw 'The physical bridge directory could not be resolved.' }
        $physical = $buffer.ToString()
        if ($physical.StartsWith('\\?\')) { $physical = $physical.Substring(4) }
        if (-not [string]::Equals($physical.TrimEnd([char[]]'\/'), $absolute, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'This directory is redirected by Windows. Use the real Documents installation directory.'
        }
    } finally { $handle.Dispose() }
    return $absolute
}

function Get-GeminiBridgeIdentity([string]$Directory) {
    $root = Get-GeminiBridgeRoot $Directory
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant() + [char]0 + $sid))).Replace('-','').ToLowerInvariant().Substring(0,24) }
    finally { $sha.Dispose() }
    return [pscustomobject]@{
        Root = $root
        Sid = $sid
        Name = 'CodexGeminiBridge-Service-' + $hash
        Marker = 'CodexGeminiBridge managed task v1|' + $root.ToLowerInvariant()
        Executable = Join-Path $env:SystemRoot 'System32\wscript.exe'
        Arguments = '//B //NoLogo "' + (Join-Path $root 'task-launcher.vbs') + '" service'
        LegacyExecutable = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        LegacyArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $root 'runner.ps1') + '" -Directory "' + $root + '"'
        Binary = Join-Path $root 'cli-proxy-api.exe'
        BinaryArguments = '-config "' + (Join-Path $root 'config.yaml') + '" -local-model'
    }
}

function Get-GeminiBridgeScheduler {
    $service = New-Object -ComObject Schedule.Service
    $service.Connect()
    return [pscustomobject]@{ Service=$service; Folder=$service.GetFolder('\') }
}

function ConvertTo-GeminiBridgeSid([string]$Identity) {
    try {
        if ($Identity -match '^S-1-') { return (New-Object Security.Principal.SecurityIdentifier($Identity)).Value }
        return (New-Object Security.Principal.NTAccount($Identity)).Translate([Security.Principal.SecurityIdentifier]).Value
    } catch { return $null }
}

function Assert-GeminiBridgeTaskOwned($Definition, $Identity) {
    if ([string]$Definition.RegistrationInfo.Description -cne $Identity.Marker -or
        (ConvertTo-GeminiBridgeSid ([string]$Definition.Principal.UserId)) -ne $Identity.Sid -or
        [int]$Definition.Principal.LogonType -ne 3 -or [int]$Definition.Principal.RunLevel -ne 0 -or
        [int]$Definition.Actions.Count -ne 1) { throw 'The bridge task belongs to another configuration; it was left untouched.' }
    $action = $Definition.Actions.Item(1)
    $current = [string]::Equals([string]$action.Path,$Identity.Executable,[StringComparison]::OrdinalIgnoreCase) -and [string]::Equals([string]$action.Arguments,$Identity.Arguments,[StringComparison]::Ordinal)
    $legacy = [string]::Equals([string]$action.Path,$Identity.LegacyExecutable,[StringComparison]::OrdinalIgnoreCase) -and [string]::Equals([string]$action.Arguments,$Identity.LegacyArguments,[StringComparison]::Ordinal)
    if ([int]$action.Type -ne 0 -or
        -not ($current -or $legacy) -or
        -not [string]::Equals([string]$action.WorkingDirectory,$Identity.Root,[StringComparison]::OrdinalIgnoreCase)) {
        throw 'The bridge task target changed; it was left untouched.'
    }
}
function Test-GeminiBridgeTaskUsesLegacyLauncher($Definition, $Identity) {
    Assert-GeminiBridgeTaskOwned $Definition $Identity
    return [string]::Equals([string]$Definition.Actions.Item(1).Path,$Identity.LegacyExecutable,[StringComparison]::OrdinalIgnoreCase)
}
function Get-GeminiBridgeLauncherParent([string]$Directory) {
    $identity = Get-GeminiBridgeIdentity $Directory
    $task = Find-GeminiBridgeTask (Get-GeminiBridgeScheduler) $identity
    $requiresGui = -not $task -or -not (Test-GeminiBridgeTaskUsesLegacyLauncher $task.Definition $identity)
    $self = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $PID) -ErrorAction Stop
    $parent = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$self.ParentProcessId) -ErrorAction SilentlyContinue
    $arguments = [regex]::Replace([string]$parent.CommandLine,'^(?:"[^"]+"|\S+)\s+','')
    if ($parent -and [string]::Equals([string]$parent.ExecutablePath,$identity.Executable,[StringComparison]::OrdinalIgnoreCase) -and [string]::Equals($arguments,$identity.Arguments,[StringComparison]::OrdinalIgnoreCase)) {
        $process = $null
        try {
            $process = [Diagnostics.Process]::GetProcessById([int]$parent.ProcessId)
            $null = $process.Handle
            $fresh = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$parent.ProcessId) -ErrorAction SilentlyContinue
            if (-not $fresh -or $fresh.CreationDate -ne $parent.CreationDate -or $process.HasExited) { throw 'The managed GUI launcher has exited.' }
            return $process
        } catch { if ($process) { $process.Dispose() }; throw }
    }
    if ($requiresGui) { throw 'The managed GUI launcher is unavailable; the runner will not continue detached.' }
    return $null
}
function Get-GeminiBridgeTaskSnapshot([string]$Directory) {
    $identity = Get-GeminiBridgeIdentity $Directory
    $task = Find-GeminiBridgeTask (Get-GeminiBridgeScheduler) $identity
    return [pscustomobject]@{ Name=$identity.Name;Sid=$identity.Sid;Exists=[bool]$task;Enabled=$(if($task){[bool]$task.Enabled}else{$false});Xml=$(if($task){[string]$task.Xml}else{$null}) }
}
function Restore-GeminiBridgeTaskSnapshot([string]$Directory, $Snapshot) {
    $identity = Get-GeminiBridgeIdentity $Directory
    if (-not $Snapshot -or $Snapshot.Name -cne $identity.Name -or $Snapshot.Sid -cne $identity.Sid) { throw 'The bridge task snapshot belongs to another installation or account.' }
    $connection = Get-GeminiBridgeScheduler
    $current = Find-GeminiBridgeTask $connection $identity
    if (Test-GeminiBridgeTaskActive $current) { throw 'Stop the owned bridge task before restoring its definition.' }
    if (-not $Snapshot.Exists) {
        if ($current) { $connection.Folder.DeleteTask($identity.Name,0) }
        return
    }
    $definition = $connection.Service.NewTask(0)
    $definition.XmlText = [string]$Snapshot.Xml
    Assert-GeminiBridgeTaskOwned $definition $identity
    if ([bool]$definition.Settings.Enabled -ne [bool]$Snapshot.Enabled) { throw 'The bridge task snapshot enabled state is inconsistent.' }
    return $connection.Folder.RegisterTaskDefinition($identity.Name,$definition,6,$identity.Sid,$null,3,$null)
}
function Update-GeminiBridgeTaskLauncher([string]$Directory) {
    $identity = Get-GeminiBridgeIdentity $Directory
    $connection = Get-GeminiBridgeScheduler
    $task = Find-GeminiBridgeTask $connection $identity
    if (-not $task) { throw 'The owned bridge task is missing; no task was recreated.' }
    if (-not (Test-GeminiBridgeTaskUsesLegacyLauncher $task.Definition $identity)) { return $task }
    if (Test-GeminiBridgeTaskActive $task) { throw 'Stop the owned bridge task before upgrading its launcher.' }
    foreach ($file in @($identity.Executable,(Join-Path $identity.Root 'task-launcher.vbs'))) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'The windowless bridge task launcher is missing.' }
    }
    $definition = $task.Definition
    $definition.Settings.Enabled = [bool]$task.Enabled
    $action = $definition.Actions.Item(1)
    $action.Path = $identity.Executable
    $action.Arguments = $identity.Arguments
    Assert-GeminiBridgeTaskOwned $definition $identity
    return $connection.Folder.RegisterTaskDefinition($identity.Name,$definition,6,$identity.Sid,$null,3,$null)
}

function Find-GeminiBridgeTask($Connection, $Identity) {
    try { $task = $Connection.Folder.GetTask($Identity.Name) }
    catch { if (($_.Exception.HResult -band 0xffff) -in @(2,3)) { return $null }; throw }
    Assert-GeminiBridgeTaskOwned $task.Definition $Identity
    return $task
}

function Test-GeminiBridgeTaskActive($Task) {
    return [bool]($Task -and ([int]$Task.State -in @(2,4) -or [int]$Task.GetInstances(0).Count -gt 0))
}

function Register-GeminiBridgeTask([string]$Directory) {
    $identity = Get-GeminiBridgeIdentity $Directory
    foreach ($file in @($identity.Executable,$identity.Binary,(Join-Path $identity.Root 'config.yaml'),(Join-Path $identity.Root 'runner.ps1'),(Join-Path $identity.Root 'task-launcher.vbs'))) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'The bridge executable or configuration is missing.' }
    }
    $connection = Get-GeminiBridgeScheduler
    $existing = Find-GeminiBridgeTask $connection $identity
    if (Test-GeminiBridgeTaskActive $existing) { return $existing }
    if ($existing) {
        if (Test-GeminiBridgeTaskUsesLegacyLauncher $existing.Definition $identity) { return Update-GeminiBridgeTaskLauncher $Directory }
        return $existing
    }
    $definition = $connection.Service.NewTask(0)
    $definition.RegistrationInfo.Description = $identity.Marker
    $definition.RegistrationInfo.Author = 'CodexGeminiBridge/' + $identity.Sid
    $definition.Principal.UserId = $identity.Sid
    $definition.Principal.LogonType = 3
    $definition.Principal.RunLevel = 0
    $definition.Settings.Enabled = $true
    $definition.Settings.Hidden = $true
    $definition.Settings.AllowDemandStart = $true
    $definition.Settings.AllowHardTerminate = $true
    $definition.Settings.DisallowStartIfOnBatteries = $false
    $definition.Settings.StopIfGoingOnBatteries = $false
    $definition.Settings.MultipleInstances = 2
    $definition.Settings.ExecutionTimeLimit = 'PT0S'
    $definition.Settings.RestartInterval = 'PT1M'
    $definition.Settings.RestartCount = 3
    $trigger = $definition.Triggers.Create(9)
    $trigger.Enabled = $true
    $trigger.UserId = $identity.Sid
    $action = $definition.Actions.Create(0)
    $action.Path = $identity.Executable
    $action.Arguments = $identity.Arguments
    $action.WorkingDirectory = $identity.Root
    return $connection.Folder.RegisterTaskDefinition($identity.Name,$definition,6,$identity.Sid,$null,3,$null)
}

function Get-GeminiBridgeListeners([int]$Port) {
    return @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Test-GeminiBridgeProcessOwned($Process, $Identity) {
    if (-not $Process -or -not [string]::Equals([string]$Process.ExecutablePath,$Identity.Binary,[StringComparison]::OrdinalIgnoreCase)) { return $false }
    # No credential values are passed on the command line; inspect only the config path.
    $match = [regex]::Match([string]$Process.CommandLine, '(?:^|\s)-config(?:=|\s+)(?:"([^"]+)"|(\S+))')
    if (-not $match.Success) { return $false }
    $config = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
    return [string]::Equals($config,(Join-Path $Identity.Root 'config.yaml'),[StringComparison]::OrdinalIgnoreCase)
}

function Test-GeminiBridgeListenerOwned($Listener, $Identity) {
    if ($Listener.LocalAddress -notin @('127.0.0.1','::1')) { return $false }
    $process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$Listener.OwningProcess) -ErrorAction SilentlyContinue
    return (Test-GeminiBridgeProcessOwned $process $Identity)
}

function Get-GeminiBridgeStatus([string]$Directory, [int]$Port=8317) {
    $identity = Get-GeminiBridgeIdentity $Directory
    $task = Find-GeminiBridgeTask (Get-GeminiBridgeScheduler) $identity
    $listeners = Get-GeminiBridgeListeners $Port
    $owned = @()
    $foreign = @()
    foreach ($listener in $listeners) {
        if (Test-GeminiBridgeListenerOwned $listener $identity) { $owned += $listener } else { $foreign += $listener }
    }
    $names = @{0='unknown';1='disabled';2='queued';3='ready';4='running'}
    # Readiness can be checked against a mistaken port; process lifetime must
    # still be tracked by exact executable/config ownership, independently.
    $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'cli-proxy-api.exe'" -ErrorAction SilentlyContinue | Where-Object { Test-GeminiBridgeProcessOwned $_ $identity })
    return [pscustomobject]@{
        Directory=$identity.Root; Port=$Port; TaskName=$identity.Name
        TaskExists=[bool]$task; TaskState=$(if($task){$names[[int]$task.State]}else{'missing'})
        TaskEnabled=$(if($task){[bool]$task.Enabled}else{$false})
        TaskActive=(Test-GeminiBridgeTaskActive $task)
        Listening=($owned.Count -gt 0); ForeignListener=($foreign.Count -gt 0)
        ProcessIds=@($owned | ForEach-Object { [int]$_.OwningProcess } | Select-Object -Unique)
        OwnedProcessIds=@($processes | ForEach-Object { [int]$_.ProcessId })
    }
}

function Start-GeminiBridge([string]$Directory, [int]$Port=8317, [int]$WaitSeconds=20) {
    $identity = Get-GeminiBridgeIdentity $Directory
    $state = Get-GeminiBridgeStatus $Directory $Port
    if ($state.ForeignListener) { throw 'The bridge port is occupied by another process or a non-loopback listener; it was left untouched.' }
    if (($state.Listening -or @($state.OwnedProcessIds).Count -gt 0) -and -not $state.TaskActive) { throw 'The bridge is running outside its managed task; it was left untouched.' }
    $task = Register-GeminiBridgeTask $Directory
    $task.Enabled = $true
    $startedHere = -not (Test-GeminiBridgeTaskActive $task)
    if ($startedHere) { $task.Run($null) | Out-Null }
    try {
        $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
        do {
            $state = Get-GeminiBridgeStatus $Directory $Port
            if ($state.ForeignListener) { throw 'An unexpected process is listening on the bridge port.' }
            if ($state.Listening -and $state.TaskActive -and $state.TaskState -eq 'running') { return $state }
            Start-Sleep -Milliseconds 250
        } while ([DateTime]::UtcNow -lt $deadline)
        throw 'The bridge task started but its local listener did not become ready. Existing Codex connections were not changed.'
    } catch {
        $failure = $_
        if ($startedHere) { Stop-GeminiBridge $Directory $Port | Out-Null }
        throw $failure
    }
}

function Stop-GeminiBridge([string]$Directory, [int]$Port=8317, [switch]$RemoveTask) {
    $identity = Get-GeminiBridgeIdentity $Directory
    $connection = Get-GeminiBridgeScheduler
    $task = Find-GeminiBridgeTask $connection $identity
    if (-not $task) { return Get-GeminiBridgeStatus $Directory $Port }
    $task.Enabled = $false
    # Disabled task state can hide a live instance. Stop unconditionally, then settle.
    try { $task.Stop(0) } catch { if ($_.Exception.GetBaseException().HResult -ne -2147216629) { throw } }
    $deadline = [DateTime]::UtcNow.AddSeconds(12)
    $settled = 0
    do {
        Start-Sleep -Milliseconds 150
        $state = Get-GeminiBridgeStatus $Directory $Port
        if (-not $state.TaskActive -and -not $state.Listening -and @($state.OwnedProcessIds).Count -eq 0) { $settled++ } else { $settled=0 }
        if ($settled -ge 3) {
            if ($RemoveTask) {
                $task = Find-GeminiBridgeTask $connection $identity
                if ($task) { $connection.Folder.DeleteTask($identity.Name,0) }
            }
            return Get-GeminiBridgeStatus $Directory $Port
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'The owned bridge task did not stop completely. No unrelated process was terminated.'
}
