[CmdletBinding()]
param(
    [Alias('Directory')][string]$GatewaySchedulerDirectory,
    [Alias('ControlAction')][ValidateSet('restart','restore')][string]$GatewaySchedulerControlAction,
    [Alias('StartService')][switch]$GatewaySchedulerStartService,
    [Alias('LibraryOnly')][switch]$GatewaySchedulerLibraryOnly
)

function Get-GatewaySchedulerRoot([string]$Root) {
    if (-not $Root -or $Root -match '[\x00-\x1f]' -or -not [IO.Path]::IsPathRooted($Root) -or $Root -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))') { throw 'An absolute physical gateway directory is required.' }
    return [IO.Path]::GetFullPath($Root).TrimEnd([char[]]'\/')
}
function Get-GatewaySchedulerSid {
    return [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}
function Get-GatewaySchedulerIdentity([string]$Root, [ValidateSet('service','restart','restore')][string]$Kind = 'service') {
    $rootPath = Get-GatewaySchedulerRoot $Root
    $sid = Get-GatewaySchedulerSid
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($rootPath.ToLowerInvariant() + [char]0 + $sid))).Replace('-','').ToLowerInvariant().Substring(0,24) }
    finally { $sha.Dispose() }
    $name = if ($Kind -eq 'service') { 'CodexModelGateway-Service-' + $hash } else { 'CodexModelGateway-Control-' + $Kind + '-' + $hash }
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $target = Join-Path $rootPath $(if ($Kind -eq 'service') { 'runner.ps1' } else { 'control.ps1' })
    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $target + '" -Directory "' + $rootPath + '"'
    if ($Kind -ne 'service') { $arguments += ' -Action ' + $Kind }
    return [pscustomobject]@{
        Root = $rootPath; Kind = $Kind; Name = $name; Sid = $sid
        Marker = 'CodexModelGateway managed task v3|' + $Kind + '|' + $rootPath.ToLowerInvariant()
        Executable = Join-Path $env:SystemRoot 'System32\wscript.exe'
        Arguments = '//B //NoLogo "' + (Join-Path $rootPath 'task-launcher.vbs') + '" ' + $Kind
        LegacyExecutable = $powershell; LegacyArguments = $arguments
    }
}
function Get-GatewaySchedulerConnection {
    $service = New-Object -ComObject Schedule.Service
    $service.Connect()
    return [pscustomobject]@{ Service = $service; Folder = $service.GetFolder('\') }
}
function ConvertTo-GatewaySchedulerSid([string]$Identity) {
    try {
        if ($Identity -match '^S-1-') { return (New-Object Security.Principal.SecurityIdentifier($Identity)).Value }
        return (New-Object Security.Principal.NTAccount($Identity)).Translate([Security.Principal.SecurityIdentifier]).Value
    } catch { return $null }
}
function Assert-GatewayTaskDefinitionOwned($Definition, $Identity) {
    if (-not [string]::Equals([string]$Definition.RegistrationInfo.Description, [string]$Identity.Marker, [StringComparison]::OrdinalIgnoreCase)) { throw 'A task with the gateway name belongs to another configuration; it was left untouched.' }
    if ((ConvertTo-GatewaySchedulerSid ([string]$Definition.Principal.UserId)) -ne $Identity.Sid -or [int]$Definition.Principal.LogonType -ne 3 -or [int]$Definition.Principal.RunLevel -ne 0) { throw 'The gateway task has a different account or permission level; it was left untouched.' }
    if ([int]$Definition.Actions.Count -ne 1) { throw 'The gateway task has unexpected actions; it was left untouched.' }
    $action = $Definition.Actions.Item(1)
    $current = [string]::Equals([string]$action.Path, [string]$Identity.Executable, [StringComparison]::OrdinalIgnoreCase) -and [string]::Equals([string]$action.Arguments, [string]$Identity.Arguments, [StringComparison]::OrdinalIgnoreCase)
    $legacy = [string]::Equals([string]$action.Path, [string]$Identity.LegacyExecutable, [StringComparison]::OrdinalIgnoreCase) -and [string]::Equals([string]$action.Arguments, [string]$Identity.LegacyArguments, [StringComparison]::OrdinalIgnoreCase)
    if ([int]$action.Type -ne 0 -or -not ($current -or $legacy) -or -not [string]::Equals([string]$action.WorkingDirectory, [string]$Identity.Root, [StringComparison]::OrdinalIgnoreCase)) { throw 'The gateway task target changed; it was left untouched.' }
}
function Test-GatewayTaskUsesLegacyLauncher($Definition, $Identity) {
    Assert-GatewayTaskDefinitionOwned $Definition $Identity
    return [string]::Equals([string]$Definition.Actions.Item(1).Path,[string]$Identity.LegacyExecutable,[StringComparison]::OrdinalIgnoreCase)
}
function Get-GatewayScheduledLauncherParent([string]$Root, [switch]$RequireManagedLauncher) {
    $identity = Get-GatewaySchedulerIdentity $Root 'service'
    $task = Find-GatewayScheduledTask (Get-GatewaySchedulerConnection) $identity
    $requiresGui = ($task -and -not (Test-GatewayTaskUsesLegacyLauncher $task.Definition $identity)) -or ($RequireManagedLauncher -and -not $task)
    $self = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $PID) -ErrorAction Stop
    $parent = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$self.ParentProcessId) -ErrorAction SilentlyContinue
    $arguments = [regex]::Replace([string]$parent.CommandLine,'^(?:"[^"]+"|\S+)\s+','')
    if ($parent -and [string]::Equals([string]$parent.ExecutablePath,$identity.Executable,[StringComparison]::OrdinalIgnoreCase) -and [string]::Equals($arguments,$identity.Arguments,[StringComparison]::OrdinalIgnoreCase)) {
        $process = $null
        try {
            $process = [Diagnostics.Process]::GetProcessById([int]$parent.ProcessId)
            $null = $process.Handle # Hold the process object, not a reusable PID.
            $fresh = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$parent.ProcessId) -ErrorAction SilentlyContinue
            if (-not $fresh -or $fresh.CreationDate -ne $parent.CreationDate -or $process.HasExited) { throw 'The managed GUI launcher has exited.' }
            return $process
        } catch { if ($process) { $process.Dispose() }; throw }
    }
    if ($requiresGui) { throw 'The managed GUI launcher is unavailable; the runner will not continue detached.' }
    return $null # Legacy scheduled actions and isolated process-mode fixtures.
}
function Update-GatewayScheduledTaskLauncher([string]$Root, [ValidateSet('service','restart','restore')][string]$Kind = 'service') {
    $identity = Get-GatewaySchedulerIdentity $Root $Kind
    $connection = Get-GatewaySchedulerConnection
    $task = Find-GatewayScheduledTask $connection $identity
    if (-not $task) { throw 'The owned gateway task is missing; no task was recreated.' }
    if (-not (Test-GatewayTaskUsesLegacyLauncher $task.Definition $identity)) { return $task }
    if (Test-GatewayScheduledTaskActive $task) { throw 'Stop the owned gateway task before upgrading its launcher.' }
    foreach ($file in @($identity.Executable,(Join-Path $identity.Root 'task-launcher.vbs'))) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'The windowless gateway task launcher is missing.' }
    }
    # Preserve the original principal, triggers, settings and enabled state.
    # Only an exact previously owned PowerShell action may be migrated.
    $definition = $task.Definition
    $definition.Settings.Enabled = [bool]$task.Enabled
    $action = $definition.Actions.Item(1)
    $action.Path = $identity.Executable
    $action.Arguments = $identity.Arguments
    Assert-GatewayTaskDefinitionOwned $definition $identity
    return $connection.Folder.RegisterTaskDefinition($identity.Name,$definition,6,$identity.Sid,$null,3,$null)
}
function Find-GatewayScheduledTask($Connection, $Identity) {
    try { $task = $Connection.Folder.GetTask($Identity.Name) }
    catch {
        $code = $_.Exception.HResult -band 0xffff
        if ($code -in @(2,3)) { return $null }
        throw
    }
    Assert-GatewayTaskDefinitionOwned $task.Definition $Identity
    return $task
}
function Test-GatewayScheduledTaskActive($Task) {
    return [bool]($Task -and ([int]$Task.State -in @(2,4) -or [int]$Task.GetInstances(0).Count -gt 0))
}
function New-GatewayScheduledDefinition($Connection, $Identity) {
    $target = Join-Path $Identity.Root $(if ($Identity.Kind -eq 'service') { 'runner.ps1' } else { 'control.ps1' })
    if (-not (Test-Path -LiteralPath $target -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $Identity.Root 'task-launcher.vbs') -PathType Leaf)) { throw 'The gateway task script or windowless launcher is missing.' }
    $definition = $Connection.Service.NewTask(0)
    $definition.RegistrationInfo.Description = $Identity.Marker
    $definition.RegistrationInfo.Author = 'CodexModelGateway/' + $Identity.Sid
    $definition.Principal.UserId = $Identity.Sid
    $definition.Principal.LogonType = 3
    $definition.Principal.RunLevel = 0
    $definition.Settings.Enabled = $true
    $definition.Settings.Hidden = $true
    $definition.Settings.AllowDemandStart = $true
    $definition.Settings.AllowHardTerminate = $true
    $definition.Settings.DisallowStartIfOnBatteries = $false
    $definition.Settings.StopIfGoingOnBatteries = $false
    $definition.Settings.MultipleInstances = 2
    $definition.Settings.ExecutionTimeLimit = if ($Identity.Kind -eq 'service') { 'PT0S' } else { 'PT5M' }
    if ($Identity.Kind -eq 'service') {
        $definition.Settings.RestartInterval = 'PT1M'
        $definition.Settings.RestartCount = 3
        $trigger = $definition.Triggers.Create(9)
        $trigger.Enabled = $true
        $trigger.UserId = $Identity.Sid
    }
    $action = $definition.Actions.Create(0)
    $action.Path = $Identity.Executable
    $action.Arguments = $Identity.Arguments
    $action.WorkingDirectory = $Identity.Root
    return $definition
}
function Register-GatewayScheduledTask([string]$Root, [ValidateSet('service','restart','restore')][string]$Kind) {
    $identity = Get-GatewaySchedulerIdentity $Root $Kind
    $connection = Get-GatewaySchedulerConnection
    $previous = Find-GatewayScheduledTask $connection $identity
    if (Test-GatewayScheduledTaskActive $previous) { return $previous }
    if ($previous) {
        if (Test-GatewayTaskUsesLegacyLauncher $previous.Definition $identity) { return Update-GatewayScheduledTaskLauncher $Root $Kind }
        return $previous
    }
    $definition = New-GatewayScheduledDefinition $connection $identity
    return $connection.Folder.RegisterTaskDefinition($identity.Name, $definition, 6, $identity.Sid, $null, 3, $null)
}
function Register-GatewayScheduledService([string]$Root) { return Register-GatewayScheduledTask $Root 'service' }
function Register-GatewayScheduledControl([string]$Root, [ValidateSet('restart','restore')][string]$Action) { return Register-GatewayScheduledTask $Root $Action }
function Get-GatewayScheduledService([string]$Root) {
    $identity = Get-GatewaySchedulerIdentity $Root 'service'
    return Find-GatewayScheduledTask (Get-GatewaySchedulerConnection) $identity
}
function Get-GatewayScheduledControl([string]$Root, [ValidateSet('restart','restore')][string]$Action) {
    $identity = Get-GatewaySchedulerIdentity $Root $Action
    return Find-GatewayScheduledTask (Get-GatewaySchedulerConnection) $identity
}
function Run-GatewayScheduledService([string]$Root) {
    $task = Get-GatewayScheduledService $Root
    if (-not $task) { throw 'The gateway service task is not registered.' }
    if (Test-GatewayScheduledTaskActive $task) { return $task }
    return $task.Run($null)
}
function Run-GatewayScheduledControl([string]$Root, [ValidateSet('restart','restore')][string]$Action) {
    foreach ($kind in @('restart','restore')) {
        $active = Get-GatewayScheduledControl $Root $kind
        if (Test-GatewayScheduledTaskActive $active) { throw 'A gateway maintenance operation is already running.' }
    }
    $task = Get-GatewayScheduledControl $Root $Action
    if (-not $task) { throw 'The gateway maintenance task is not registered.' }
    return $task.Run($null)
}
function Set-GatewayScheduledServiceEnabled([string]$Root, [bool]$Enabled) {
    $task = Get-GatewayScheduledService $Root
    if (-not $task) { throw 'The gateway service task is not registered.' }
    $task.Enabled = $Enabled
}
function Stop-GatewayScheduledService([string]$Root, [switch]$Disable) {
    $task = Get-GatewayScheduledService $Root
    if ($Disable -and $task) { $task.Enabled = $false }
    if (-not $task) { return }
    # Enabled=false can hide a still-running instance from State/GetInstances.
    # Always ask the scheduler to stop all instances, even when it looks idle.
    try { $task.Stop(0) }
    catch { if ($_.Exception.GetBaseException().HResult -ne -2147216629) { throw } }
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    $settled = 0
    do {
        Start-Sleep -Milliseconds 150
        $task = Get-GatewayScheduledService $Root
        if (-not $task) { return }
        if (-not (Test-GatewayScheduledTaskActive $task)) { $settled++ } else { $settled = 0 }
        # The scheduler can report Ready before it has released the old instance.
        # Require stable quiescence so IgnoreNew cannot discard an immediate restart.
        if ($settled -ge 3) { return }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'The gateway service task did not stop.'
}
function Remove-GatewayScheduledService([string]$Root) {
    $identity = Get-GatewaySchedulerIdentity $Root 'service'
    $connection = Get-GatewaySchedulerConnection
    $task = Find-GatewayScheduledTask $connection $identity
    if (-not $task) { return }
    Stop-GatewayScheduledService $Root
    $task = Find-GatewayScheduledTask $connection $identity
    if ($task) { $connection.Folder.DeleteTask($identity.Name,0) }
}
function Remove-GatewayScheduledControl([string]$Root, [ValidateSet('restart','restore')][string]$Action) {
    $identity = Get-GatewaySchedulerIdentity $Root $Action
    $connection = Get-GatewaySchedulerConnection
    $task = Find-GatewayScheduledTask $connection $identity
    if (-not $task) { return }
    if (Test-GatewayScheduledTaskActive $task) { throw 'A running gateway maintenance task cannot be removed.' }
    $connection.Folder.DeleteTask($identity.Name,0)
}
function Get-GatewayTaskState([string]$Root, [ValidateSet('service','restart','restore')][string]$Kind = 'service') {
    $identity = Get-GatewaySchedulerIdentity $Root $Kind
    $task = Find-GatewayScheduledTask (Get-GatewaySchedulerConnection) $identity
    if (-not $task) { return [pscustomobject]@{ Name = $identity.Name; Kind = $Kind; Exists = $false; State = 'missing'; Root = $identity.Root } }
    $names = @{0='unknown';1='disabled';2='queued';3='ready';4='running'}
    return [pscustomobject]@{ Name = $identity.Name; Kind = $Kind; Exists = $true; State = $names[[int]$task.State]; StateCode = [int]$task.State; LastResult = [int64]$task.LastTaskResult; LastRunTime = $task.LastRunTime; Root = $identity.Root }
}
function GetGatewayTaskState([string]$Root, [ValidateSet('service','restart','restore')][string]$Kind = 'service') { return Get-GatewayTaskState $Root $Kind }
function Get-GatewayScheduledTaskSnapshot([string]$Root, [ValidateSet('service','restart','restore')][string]$Kind = 'service') {
    $identity = Get-GatewaySchedulerIdentity $Root $Kind
    $task = Find-GatewayScheduledTask (Get-GatewaySchedulerConnection) $identity
    return [pscustomobject]@{ Kind = $Kind; Name = $identity.Name; Exists = [bool]$task; Xml = $(if ($task) { [string]$task.Xml } else { $null }) }
}
function Restore-GatewayScheduledTaskSnapshot([string]$Root, $Snapshot) {
    if (-not $Snapshot -or $Snapshot.Kind -notin @('service','restart','restore')) { throw 'Invalid gateway task snapshot.' }
    $identity = Get-GatewaySchedulerIdentity $Root $Snapshot.Kind
    if ($Snapshot.Name -cne $identity.Name) { throw 'The task snapshot belongs to another gateway.' }
    $connection = Get-GatewaySchedulerConnection
    $current = Find-GatewayScheduledTask $connection $identity
    if (Test-GatewayScheduledTaskActive $current) { throw 'Stop the owned task before restoring its definition.' }
    if (-not $Snapshot.Exists) {
        if ($current) { $connection.Folder.DeleteTask($identity.Name,0) }
        return
    }
    $definition = $connection.Service.NewTask(0)
    $definition.XmlText = [string]$Snapshot.Xml
    Assert-GatewayTaskDefinitionOwned $definition $identity
    return $connection.Folder.RegisterTaskDefinition($identity.Name,$definition,6,$identity.Sid,$null,3,$null)
}

if ($PSBoundParameters.ContainsKey('GatewaySchedulerDirectory')) {
    $GatewaySchedulerDirectory=Get-GatewaySchedulerRoot $GatewaySchedulerDirectory
} elseif (-not $GatewaySchedulerLibraryOnly) {
    $GatewaySchedulerDirectory=Get-GatewaySchedulerRoot ([IO.Path]::GetDirectoryName($MyInvocation.MyCommand.Path))
}
if (-not $GatewaySchedulerLibraryOnly -and ($GatewaySchedulerControlAction -or $GatewaySchedulerStartService)) {
    $ErrorActionPreference='Stop'
    if ($GatewaySchedulerControlAction -and $GatewaySchedulerStartService) { throw 'Choose only one gateway task action.' }
    if ($GatewaySchedulerControlAction) {
        Register-GatewayScheduledControl $GatewaySchedulerDirectory $GatewaySchedulerControlAction | Out-Null
        Run-GatewayScheduledControl $GatewaySchedulerDirectory $GatewaySchedulerControlAction | Out-Null
    } else {
        Register-GatewayScheduledService $GatewaySchedulerDirectory | Out-Null
        Run-GatewayScheduledService $GatewaySchedulerDirectory | Out-Null
    }
}
