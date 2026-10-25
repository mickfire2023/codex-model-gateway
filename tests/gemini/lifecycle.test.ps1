[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\bridge'))
$fixture = Join-Path $PSScriptRoot ('fixture ' + [char]0x6d4b + [char]0x8bd5 + ' ' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
New-Item -ItemType Directory -Path (Join-Path $fixture 'private') | Out-Null
New-Item -ItemType Directory -Path (Join-Path $fixture 'private\auth') | Out-Null
[IO.File]::WriteAllText((Join-Path $fixture 'private\auth\synthetic.json'),'SYNTHETIC_OAUTH_BYTES_MUST_BE_PRESERVED',[Text.Encoding]::UTF8)
foreach($file in @('lifecycle.ps1','start.ps1','stop.ps1','status.ps1','runner.ps1')) { Copy-Item -LiteralPath (Join-Path $source $file) -Destination (Join-Path $fixture $file) }
$listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0)
$listener.Start()
$testPort = [int]$listener.LocalEndpoint.Port
$listener.Stop()
[IO.File]::WriteAllText((Join-Path $fixture 'config.yaml'), ('server:' + "`n" + '  host: "127.0.0.1"' + "`n" + '  port: ' + $testPort + "`n"), [Text.Encoding]::ASCII)
[IO.File]::WriteAllText((Join-Path $fixture 'bridge.json'),(@{product='CodexGeminiBridge';port=$testPort}|ConvertTo-Json -Compress),[Text.Encoding]::ASCII)
$fake = @'
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
class Fixture {
  public static void Main(string[] args) {
    string config = null;
    for (int i=0;i+1<args.Length;i++) if(args[i]=="-config") config=args[i+1];
    if(config==null) Environment.Exit(2);
    string command=Path.Combine(Path.GetDirectoryName(config),"private","fixture-command.txt");
    Console.Out.WriteLine("SYNTHETIC_PROVIDER_OUTPUT_MUST_NOT_BE_LOGGED");
    Console.Error.WriteLine("SYNTHETIC_PROVIDER_ERROR_MUST_NOT_BE_LOGGED");
    int port=Int32.Parse(Regex.Match(File.ReadAllText(config), @"port:\s*(\d+)").Groups[1].Value);
    TcpListener server=new TcpListener(IPAddress.Loopback,port);
    server.Start();
    while(true) {
      if(File.Exists(command)) {
        string value=File.ReadAllText(command).Trim();
        File.Delete(command);
        if(value=="exit0") Environment.Exit(0);
        if(value=="exit17") Environment.Exit(17);
      }
      if(!server.Pending()) { Thread.Sleep(20);continue; }
      using(TcpClient client=server.AcceptTcpClient()) {
        byte[] body=Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"data\":[]}");
        client.GetStream().Write(body,0,body.Length);
      }
    }
  }
}
'@
Add-Type -TypeDefinition $fake -OutputAssembly (Join-Path $fixture 'cli-proxy-api.exe') -OutputType ConsoleApplication
. (Join-Path $source 'lifecycle.ps1')
$identity=Get-GeminiBridgeIdentity $fixture
$assertions=0
function Assert([bool]$Condition,[string]$Message) { if(-not $Condition){throw ('ASSERT: '+$Message)}; $script:assertions++ }
function Read-Lifecycle {
    $file=Join-Path $fixture 'private\lifecycle.jsonl'
    if (-not [IO.File]::Exists($file)) { return @() }
    return @([IO.File]::ReadAllLines($file) | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
}
function Set-FixtureCommand([string]$Value) {
    $file=Join-Path $fixture 'private\fixture-command.txt'
    [IO.File]::WriteAllText(($file+'.tmp'),$Value,[Text.Encoding]::ASCII)
    [IO.File]::Move(($file+'.tmp'),$file)
}
function Wait-Recovered([int]$PreviousPid,[DateTime]$PreviousStart) {
    $deadline=[DateTime]::UtcNow.AddSeconds(20)
    do {
        $candidate=Get-GeminiBridgeStatus $fixture $testPort
        if ($candidate.TaskActive -and $candidate.Listening) {
            $current=Get-Process -Id ([int]$candidate.ProcessIds[0]) -ErrorAction SilentlyContinue
            if ($current -and ($current.Id -ne $PreviousPid -or $current.StartTime -ne $PreviousStart)) { return $candidate }
        }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'The supervised fixture child did not recover.'
}
$ps5=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$recoveryHelper=[IO.Path]::GetFullPath((Join-Path $source '..\gateway\gemini-service.ps1'))
$repairHelper=[IO.Path]::GetFullPath((Join-Path $source '..\scripts\repair-gemini.ps1'))
$preservedPaths=@('config.yaml','bridge.json','private\auth\synthetic.json')
$preservedHashes=@{}
foreach ($relative in $preservedPaths) { $preservedHashes[$relative]=(Get-FileHash -LiteralPath (Join-Path $fixture $relative) -Algorithm SHA256).Hash }
function Assert-Repair([bool]$ExpectedEnabled) {
    $output=& $ps5 -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $repairHelper -BridgeDirectory $fixture 2>&1
    Assert ($LASTEXITCODE -eq 0) 'existing installation repair completes without downloading or generating'
    foreach ($relative in $preservedPaths) {
        Assert ((Get-FileHash -LiteralPath (Join-Path $fixture $relative) -Algorithm SHA256).Hash -ceq $preservedHashes[$relative]) 'repair preserves config metadata and synthetic account bytes'
    }
    $repaired=Get-GeminiBridgeStatus $fixture $testPort
    Assert ($repaired.TaskEnabled -eq $ExpectedEnabled -and $repaired.TaskActive -eq $ExpectedEnabled -and $repaired.Listening -eq $ExpectedEnabled) 'repair preserves enabled or explicitly disabled service state'
    Assert ((Get-FileHash -LiteralPath (Join-Path $fixture 'runner.ps1') -Algorithm SHA256).Hash -ceq (Get-FileHash -LiteralPath (Join-Path $source 'runner.ps1') -Algorithm SHA256).Hash) 'repair installs exact current supervisor'
}
function Invoke-RecoveryHelper {
    $output=& $ps5 -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $recoveryHelper -Directory $fixture -Port $testPort -WaitSeconds 20 2>&1
    return [pscustomobject]@{code=$LASTEXITCODE;text=($output -join "`n")}
}
function Invoke-Entry([string]$Name,[string[]]$Extra) {
    Push-Location $env:SystemRoot
    try {
        $output=& $ps5 -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $fixture $Name) -Port $testPort @Extra 2>&1
        if($LASTEXITCODE -ne 0){throw ('Entry failed: '+$Name+' '+($output -join "`n"))}
        return (($output -join "`n") | ConvertFrom-Json)
    } finally { Pop-Location }
}
try {
    Assert ($identity.Root -ceq $fixture) 'Unicode physical directory unchanged'
    Assert (-not (Get-GeminiBridgeStatus $fixture $testPort).TaskExists) 'starts without task'
    $state=Invoke-Entry 'start.ps1' @()
    Assert ($state.Listening -and $state.TaskActive) 'PS5 omitted Directory starts from different CWD'
    Assert (-not $state.ForeignListener) 'loopback listener belongs to exact binary and config'
    Assert ($state.TaskState -eq 'running') 'task running'
    $firstPid=[int]$state.ProcessIds[0]
    $process=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$firstPid)
    Assert ([int]$process.ParentProcessId -ne $PID) 'listener independent of test launcher'
    $task=Find-GeminiBridgeTask (Get-GeminiBridgeScheduler) $identity
    Assert ([int]$task.Definition.Principal.LogonType -eq 3) 'interactive token no stored password'
    Assert ([int]$task.Definition.Principal.RunLevel -eq 0) 'no elevation'
    Assert ([string]$task.Definition.Settings.ExecutionTimeLimit -eq 'PT0S') 'no automatic timeout'
    Assert ([int]$task.Definition.Triggers.Count -eq 1 -and [int]$task.Definition.Triggers.Item(1).Type -eq 9) 'login trigger'
    Assert ([string]$task.Definition.Actions.Item(1).Arguments -ceq $identity.Arguments) 'exact config and local-model args'
    Assert ($identity.BinaryArguments -ceq ('-config "'+(Join-Path $fixture 'config.yaml')+'" -local-model')) 'fixed upstream arguments'
    Assert ($identity.Arguments -match '-WindowStyle Hidden') 'scheduled runner hidden'
    Assert ([string]$task.Definition.Actions.Item(1).WorkingDirectory -ceq $fixture) 'exact working directory'
    $repeat=Invoke-Entry 'start.ps1' @()
    Assert ([int]$repeat.ProcessIds[0] -eq $firstPid) 'start idempotent no extra listener'
    $parentBefore=[int]$process.ParentProcessId
    foreach ($scenario in @(@{command='exit0';code=0;delay=1},@{command='exit17';code=17;delay=2})) {
        $priorPid=[int]$repeat.ProcessIds[0]
        $priorStart=(Get-Process -Id $priorPid).StartTime
        Set-FixtureCommand $scenario.command
        $repeat=Wait-Recovered $priorPid $priorStart
        $replacement=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$repeat.ProcessIds[0])
        Assert ([int]$replacement.ParentProcessId -eq $parentBefore) 'child exit is recovered by same scheduled parent'
        $record=@(Read-Lifecycle | Where-Object { $_.event -eq 'child_exited' -and $_.exitCode -eq $scenario.code })[-1]
        Assert ($record.exitCode -eq $scenario.code) 'exit code is preserved as metadata'
        Assert ($record.delaySeconds -eq $scenario.delay) 'rapid repeated exits increase recovery backoff'
        Assert ($record.uptimeMs -ge 0 -and $record.restartCount -ge 1) 'recovery records uptime and restart count'
    }
    # Verify actual crash recovery without terminating the parent task.
    $priorPid=[int]$repeat.ProcessIds[0]
    $owned=Get-Process -Id $priorPid -ErrorAction Stop
    $priorStart=$owned.StartTime
    try { $owned.Kill();$owned.WaitForExit() } finally { $owned.Dispose() }
    $repeat=Wait-Recovered $priorPid $priorStart
    Assert ($repeat.TaskActive -and $repeat.Listening) 'unexpected child termination recovers automatically'
    $text=[IO.File]::ReadAllText((Join-Path $fixture 'private\lifecycle.jsonl'))
    Assert ($text -notmatch 'SYNTHETIC_PROVIDER_|fixture-command|server:|config.yaml') 'lifecycle log excludes child output and configuration'
    $allowed=@('time','event','pid','exitCode','uptimeMs','restartCount','delaySeconds','reason')
    foreach ($record in @(Read-Lifecycle)) {
        Assert (@($record.PSObject.Properties.Name | Where-Object { $_ -notin $allowed }).Count -eq 0) 'lifecycle entries contain only metadata fields'
    }
    # A foreign process can claim the port during child backoff. The supervisor
    # must stop without displacing it or repeatedly launching competing children.
    $owned=Get-Process -Id ([int]$repeat.ProcessIds[0]) -ErrorAction Stop
    try { $owned.Kill();$owned.WaitForExit() } finally { $owned.Dispose() }
    $claimed=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,$testPort)
    $claimed.Start()
    try {
        $deadline=[DateTime]::UtcNow.AddSeconds(20)
        do {
            $blockedState=Get-GeminiBridgeStatus $fixture $testPort
            if (-not $blockedState.TaskActive) { break }
            Start-Sleep -Milliseconds 150
        } while ([DateTime]::UtcNow -lt $deadline)
        Assert ($blockedState.ForeignListener -and -not $blockedState.TaskActive -and @($blockedState.OwnedProcessIds).Count -eq 0) 'supervisor stops before relaunch when foreign listener claims port'
        Assert (@(Read-Lifecycle | Where-Object { $_.event -eq 'runner_stopped' -and $_.reason -eq 'foreign_listener' }).Count -eq 1) 'foreign listener block recorded without external data'
    } finally { $claimed.Stop() }
    $recovery=Invoke-RecoveryHelper
    Assert ($recovery.code -eq 0) 'enabled supervisor can recover after foreign listener leaves'
    $repeat=Get-GeminiBridgeStatus $fixture $testPort
    # Rotation is exercised with disposable metadata in the fixture only.
    $oversized=(' ' * 65536)+[Environment]::NewLine
    [IO.File]::WriteAllText((Join-Path $fixture 'private\lifecycle.jsonl'),$oversized,[Text.Encoding]::ASCII)
    $priorPid=[int]$repeat.ProcessIds[0]
    $priorStart=(Get-Process -Id $priorPid).StartTime
    Set-FixtureCommand 'exit0'
    $repeat=Wait-Recovered $priorPid $priorStart
    Assert ([IO.File]::Exists((Join-Path $fixture 'private\lifecycle.jsonl.1'))) 'oversized lifecycle log rotated'
    Assert (([IO.FileInfo](Join-Path $fixture 'private\lifecycle.jsonl')).Length -lt 65536) 'active lifecycle log bounded after rotation'
    Assert-Repair $true
    # Reproduce a terminated scheduled parent without a deliberate user stop:
    # the task remains enabled and must be recoverable without rewriting it.
    $task=Find-GeminiBridgeTask (Get-GeminiBridgeScheduler) $identity
    $definitionBefore=[string]$task.Xml
    $task.Stop(0)
    $deadline=[DateTime]::UtcNow.AddSeconds(15)
    do {
        $interrupted=Get-GeminiBridgeStatus $fixture $testPort
        if (-not $interrupted.TaskActive -and -not $interrupted.Listening -and @($interrupted.OwnedProcessIds).Count -eq 0) { break }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
    Assert ($interrupted.TaskEnabled -and -not $interrupted.TaskActive -and -not $interrupted.Listening) 'interrupted parent leaves enabled idle task'
    $recovery=Invoke-RecoveryHelper
    Assert ($recovery.code -eq 0 -and ($recovery.text | ConvertFrom-Json).ready) 'gateway helper recovers interrupted enabled task'
    $recovered=Get-GeminiBridgeStatus $fixture $testPort
    Assert ($recovered.Listening -and $recovered.TaskActive -and -not $recovered.ForeignListener) 'helper waits for owned listener'
    $task=Find-GeminiBridgeTask (Get-GeminiBridgeScheduler) $identity
    Assert ([string]$task.Xml -ceq $definitionBefore) 'helper preserves existing task definition'
    $state=Invoke-Entry 'stop.ps1' @()
    Assert (-not $state.Listening -and -not $state.TaskActive) 'PS5 omitted Directory stop'
    Assert (-not $state.TaskEnabled) 'stop disables future auto restart'
    Start-Sleep -Seconds 2
    $afterStop=Get-GeminiBridgeStatus $fixture $testPort
    Assert (-not $afterStop.Listening -and -not $afterStop.TaskActive -and @($afterStop.OwnedProcessIds).Count -eq 0) 'supervisor cannot resurrect explicitly stopped task'
    $recovery=Invoke-RecoveryHelper
    Assert ($recovery.code -eq 20) 'gateway helper refuses explicitly disabled task'
    $afterRecovery=Get-GeminiBridgeStatus $fixture $testPort
    Assert (-not $afterRecovery.TaskEnabled -and -not $afterRecovery.TaskActive -and -not $afterRecovery.Listening) 'gateway helper leaves explicit stop in effect'
    Assert-Repair $false
    $state=Invoke-Entry 'stop.ps1' @()
    Assert (-not $state.Listening) 'repeat stop succeeds'
    $state=Invoke-Entry 'status.ps1' @()
    Assert ($state.TaskState -eq 'disabled') 'status no creds from different CWD'
    foreach($bad in @('', '.', 'C:relative', "C:\bad`npath", 'C:\')) {
        $rejected=$false
        try { Get-GeminiBridgeRoot $bad | Out-Null } catch { $rejected=$true }
        Assert $rejected 'invalid installation directory rejected'
    }
    for($n=0;$n -lt 2;$n++) {
        $restartNotBefore=[DateTime]::UtcNow
        $state=Start-GeminiBridge $fixture $testPort 20
        Assert ($state.Listening -and $state.TaskActive) 'restart listener recovered'
        $fresh=Get-Process -Id ([int]$state.ProcessIds[0]) -ErrorAction Stop
        Assert ($fresh.StartTime.ToUniversalTime() -ge $restartNotBefore.AddSeconds(-1)) 'restart has fresh process creation time even when PID is recycled'
        $state=Stop-GeminiBridge $fixture $testPort
        Assert (-not $state.TaskActive -and -not $state.Listening) 'stop settles before next start'
    }
    $occupied=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,$testPort)
    $occupied.Start()
    try {
        $blocked=$false
        try { Start-GeminiBridge $fixture $testPort 2 | Out-Null } catch { $blocked=$true }
        Assert $blocked 'occupied foreign port rejected'
        $state=Get-GeminiBridgeStatus $fixture $testPort
        Assert (-not $state.TaskActive -and $state.ForeignListener) 'foreign listener left running and managed task inactive'
        $recovery=Invoke-RecoveryHelper
        Assert ($recovery.code -eq 22) 'gateway helper rejects foreign listener'
        $preserved=Get-GeminiBridgeStatus $fixture $testPort
        Assert ($preserved.ForeignListener -and -not $preserved.TaskActive) 'gateway helper preserves foreign listener and does not start task'
    } finally { $occupied.Stop() }
    $unready=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0)
    $unready.Start()
    $wrongPort=[int]$unready.LocalEndpoint.Port
    $unready.Stop()
    $failed=$false
    try { Start-GeminiBridge $fixture $wrongPort 2 | Out-Null } catch { $failed=$true }
    Assert $failed 'readiness failure is reported'
    $state=Get-GeminiBridgeStatus $fixture $testPort
    Assert (-not $state.TaskActive -and -not $state.Listening -and -not $state.TaskEnabled -and @($state.OwnedProcessIds).Count -eq 0) 'failed start stops own task and process'
    $wrongState=Get-GeminiBridgeStatus $fixture $wrongPort
    Assert (@($wrongState.OwnedProcessIds).Count -eq 0) 'wrong readiness port cannot hide an owned proxy process'
    $connection=Get-GeminiBridgeScheduler
    $task=Find-GeminiBridgeTask $connection $identity
    $definition=$task.Definition
    $definition.RegistrationInfo.Description='unrelated fixture owner'
    $connection.Folder.RegisterTaskDefinition($identity.Name,$definition,6,$identity.Sid,$null,3,$null)|Out-Null
    $blocked=$false
    try{ Start-GeminiBridge $fixture $testPort 2 | Out-Null }catch{$blocked=$true}
    Assert $blocked 'foreign same-name task cannot be overwritten'
    $blocked=$false
    try{ Stop-GeminiBridge $fixture $testPort | Out-Null }catch{$blocked=$true}
    Assert $blocked 'foreign same-name task cannot be stopped'
    $task=$connection.Folder.GetTask($identity.Name)
    Assert ([string]$task.Definition.RegistrationInfo.Description -eq 'unrelated fixture owner') 'foreign definition preserved'
    # This exact inactive fixture task was intentionally re-labelled above; restore only its test marker.
    $definition=$task.Definition
    $definition.RegistrationInfo.Description=$identity.Marker
    $connection.Folder.RegisterTaskDefinition($identity.Name,$definition,6,$identity.Sid,$null,3,$null)|Out-Null
    $state=Stop-GeminiBridge $fixture $testPort -RemoveTask
    Assert (-not $state.TaskExists) 'owned task removal'
    $recovery=Invoke-RecoveryHelper
    Assert ($recovery.code -eq 21 -and -not (Get-GeminiBridgeStatus $fixture $testPort).TaskExists) 'gateway helper never recreates a missing task'
    [pscustomobject]@{passed=$assertions;fixture=$fixture;port=$testPort;taskRemoved=$true}|ConvertTo-Json -Compress
} finally {
    $connection=Get-GeminiBridgeScheduler
    try {
        $task=$connection.Folder.GetTask($identity.Name)
        $action=$task.Definition.Actions.Item(1)
        if([string]$action.Path -ceq $identity.Executable -and [string]$action.Arguments -ceq $identity.Arguments -and [string]$action.WorkingDirectory -ceq $fixture) {
            $task.Enabled=$false
            try{$task.Stop(0)}catch{}
            $connection.Folder.DeleteTask($identity.Name,0)
        }
    } catch { if(($_.Exception.HResult -band 0xffff) -notin @(2,3)){throw} }
}
