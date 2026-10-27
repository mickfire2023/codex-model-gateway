[CmdletBinding()]
param([switch]$SkipFailureRollback)
$ErrorActionPreference = 'Stop'
$release = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\gateway'))
. (Join-Path $release 'start.ps1') -Directory $release -LibraryOnly
$release = Get-GatewayPhysicalPath $release
$logicalFixture = Join-Path ([IO.Path]::GetTempPath()) ('codex scheduled fixture-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $logicalFixture -Force | Out-Null
$fixture = Get-GatewayPhysicalPath $logicalFixture
$fixtureParent = Get-GatewayPhysicalPath ([IO.Path]::GetDirectoryName($fixture))
$source = Join-Path $fixture 'source'
$previous = Join-Path $fixture 'previous'
$installed = Join-Path $fixture 'installed'
$failedInstall = Join-Path $fixture 'installed-failure'
$config = Join-Path $fixture 'config.toml'
$runFile = Join-Path $fixture 'run.json'
$foreignCwd = Join-Path $fixture 'unrelated working directory'
$cleanupRoots = New-Object Collections.Generic.List[string]
$cleanupRoots.Add($installed); $cleanupRoots.Add($failedInstall)
$checks = 0
function Assert-Scheduled([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message }; $script:checks++ }
function New-ScheduledPort {
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0)
    $listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
    return $port
}
function Read-ScheduledHealth([int]$Port) {
    try { return Invoke-RestMethod ('http://127.0.0.1:' + $Port + '/health') -TimeoutSec 1 -UseBasicParsing } catch { return $null }
}
function Get-ScheduledFileHash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Read-ScheduledText([string]$Path) {
    $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
    $stream = New-Object IO.FileStream($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,$share)
    $reader = $null
    try {
        $reader = New-Object IO.StreamReader($stream,[Text.Encoding]::UTF8,$true)
        return $reader.ReadToEnd()
    } finally { if ($reader) { $reader.Dispose() } else { $stream.Dispose() } }
}
function Invoke-ScheduledScript([string]$Script,[string[]]$Arguments = @(),[int]$TimeoutSeconds = 45,[scriptblock]$Monitor) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = Get-GatewayPowerShell
    $info.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $Script + '"'
    foreach ($argument in $Arguments) { $info.Arguments += ' "' + $argument + '"' }
    $info.WorkingDirectory = $foreignCwd
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
    $info.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
    $info.EnvironmentVariables['PSModulePath'] = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\Modules'
    $info.EnvironmentVariables['PSExecutionPolicyPreference'] = 'Bypass'
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    try {
        if (-not $process.Start()) { throw 'The isolated launcher did not start.' }
        $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
        $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
        while (-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
            if ($Monitor) { & $Monitor }
            Start-Sleep -Milliseconds 250
        }
        if (-not $process.HasExited) { $process.Kill(); throw ('The isolated launcher exceeded ' + $TimeoutSeconds + ' seconds.') }
        if ($Monitor) { & $Monitor }
        return [pscustomobject]@{Code=$process.ExitCode;Output=$stdout.Result.Trim();ErrorOutput=$stderr.Result.Trim();PID=$process.Id}
    } finally { $process.Dispose() }
}
function Wait-ScheduledControl([string]$Root,[string]$Action,[int]$Seconds = 25) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    $status = $null
    do {
        $file = Join-Path $Root 'private\control-status.json'
        if (Test-Path -LiteralPath $file) {
            try {
                $status = Read-ScheduledText $file | ConvertFrom-Json
                if ($status.action -eq $Action -and $status.state -ne 'running') { return $status }
            } catch [IO.IOException] { $status = $null }
        }
        Start-Sleep -Milliseconds 300
    } while ([DateTime]::UtcNow -lt $deadline)
    throw ('The isolated ' + $Action + ' controller did not finish.')
}
function New-ScheduledPrevious([string]$Root,[int]$Port,[string]$FakeConfig,[string]$FakeRun) {
    New-Item -ItemType Directory -Path (Join-Path $Root 'private') -Force | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $source -File) { Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $Root $item.Name) }
    $settings = @{port=$Port;routeToken='synthetic_scheduled_route_0123456789';nodePath=(Get-GatewayPhysicalPath (Get-Command node.exe -ErrorAction Stop).Source);catalogSyncEnabled=$false;previousBaseUrlLine=$null;previousCatalogLine=$null;lifecycle=@{configPath=$FakeConfig;runStateFile=$FakeRun}}
    Write-GatewayUtf8 (Join-Path $Root 'private\settings.json') ($settings | ConvertTo-Json -Depth 8)
    Write-GatewayUtf8 (Join-Path $Root 'private\deepseek-key.dpapi') 'synthetic-ciphertext-never-decrypted'
    Write-GatewayUtf8 (Join-Path $Root 'private\config.before-gateway.toml') 'synthetic original backup'
}
$mockGateway = @'
'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const settings=JSON.parse(fs.readFileSync(path.join(__dirname,'private/settings.json'),'utf8').replace(/^\uFEFF/,''));
if(!settings.stagingValidation && fs.existsSync(path.join(__dirname,'fail-stable.json')))process.exit(44);
http.createServer((req,res)=>{
  if(req.url==='/fixture-restart'){
    const windows=process.env.SystemRoot;
    const child=spawn(path.join(windows,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'scheduler.ps1'),'-Directory',__dirname,'-ControlAction','restart'],{env:{...process.env,PSModulePath:path.join(windows,'System32/WindowsPowerShell/v1.0/Modules')},windowsHide:true,detached:false,stdio:'ignore'});
    child.unref();res.writeHead(200,{'content-type':'application/json; charset=utf-8'});return res.end(JSON.stringify({parentPid:process.pid,dispatcherPid:child.pid}));
  }
  const healthy=req.url==='/health';
  if(healthy){const file=settings.lifecycle.configPath;const hash=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');fs.appendFileSync(path.join(__dirname,'fixture-health.ndjson'),JSON.stringify({pid:process.pid,staging:!!settings.stagingValidation,configHash:hash})+'\n');}
  res.writeHead(healthy?200:404,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify({ok:true,service:'codex-local-model-gateway',pid:process.pid,directory:__dirname,build:'scheduled-fixture'}));
}).listen(settings.port,'127.0.0.1');
fs.writeFileSync(path.join(__dirname,'combined-models.json'),'{"models":[]}');
'@
try {
    foreach ($path in @($source,$foreignCwd,(Join-Path $source 'node_modules\ws'))) { New-Item -ItemType Directory -Path $path -Force | Out-Null }
    foreach ($item in Get-ChildItem -LiteralPath $release -File) {
        if ($item.Extension -in @('.cjs','.json','.ps1','.vbs','.cmd','.md','.yaml')) { Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $source $item.Name) }
    }
    Write-GatewayUtf8 (Join-Path $source 'gateway.cjs') $mockGateway
    foreach ($name in @('openai-models.json','deepseek-models.json')) { Write-GatewayUtf8 (Join-Path $source $name) '{"models":[]}' }
    Write-GatewayUtf8 (Join-Path $source 'node_modules\ws\package.json') '{"name":"ws","version":"0.0.0-synthetic"}'
    Assert-Scheduled (Test-GatewaySamePath (Get-GatewayPhysicalPath $source) $source) 'The source fixture is still a virtual path.'
    $port = New-ScheduledPort
    $directConfig = "model = 'synthetic-gpt'`n[plugins.future]`nenabled = true`n"
    Write-GatewayUtf8 $config $directConfig
    Write-GatewayUtf8 $runFile '{"value":null}'
    New-ScheduledPrevious $previous $port $config $runFile
    $beforeHash = Get-ScheduledFileHash $config
    $deploy = Invoke-ScheduledScript (Join-Path $source 'deploy.ps1') @('-SourceDirectory',$source,'-PreviousDirectory',$previous,'-InstallDirectory',$installed,'-ConfigPath',$config,'-RunStateFile',$runFile,'-SkipShortcuts','-UseScheduledTasks','-KeepDirectConnection') 45 {
        Assert-Scheduled ((Read-ScheduledText $config) -ceq $directConfig) 'KeepDirectConnection modified the fake config during staging or activation.'
    }
    Assert-Scheduled ($deploy.Code -eq 0) ('Scheduled deployment failed: ' + $deploy.ErrorOutput)
    Assert-Scheduled (-not (Get-Process -Id $deploy.PID -ErrorAction SilentlyContinue)) 'The temporary deployment launcher is still alive.'
    Assert-Scheduled ((Get-GatewaySettings $installed).lifecycle.startupMode -eq 'scheduledTask') 'Deployment did not persist scheduledTask mode.'
    Assert-Scheduled ((Get-GatewayTaskState $installed).StateCode -eq 4) 'The OS service task is not running.'
    $first = Read-ScheduledHealth $port
    Assert-Scheduled ($first -and $first.ok) 'The service did not survive its temporary deployment launcher.'
    Start-Sleep -Seconds 2
    Assert-Scheduled ((Read-ScheduledHealth $port).pid -eq $first.pid) 'The independently hosted Node died after its launcher exited.'
    Assert-Scheduled ((Get-ScheduledFileHash $config) -eq $beforeHash) 'KeepDirectConnection changed config bytes.'
    $healthEvents = @(Get-Content -LiteralPath (Join-Path $installed 'fixture-health.ndjson') | ForEach-Object { $_ | ConvertFrom-Json })
    Assert-Scheduled (@($healthEvents | Where-Object { $_.configHash -ne $beforeHash }).Count -eq 0) 'The first staging/stable health check saw an altered direct config.'
    Assert-Scheduled ((Get-Content -LiteralPath (Join-Path $installed 'private\deepseek-key.dpapi') -Raw) -ceq 'synthetic-ciphertext-never-decrypted') 'Encrypted fixture data changed during migration.'
    Write-Output 'PASS: independent scheduled deployment and KeepDirectConnection.'

    $launcherIdentity=Get-GatewaySchedulerIdentity $installed 'service'
    $launchers=@(Get-CimInstance Win32_Process -Filter "Name = 'wscript.exe'" | Where-Object {
        $arguments=[regex]::Replace([string]$_.CommandLine,'^(?:"[^"]+"|\S+)\s+','')
        [string]::Equals([string]$_.ExecutablePath,$launcherIdentity.Executable,[StringComparison]::OrdinalIgnoreCase) -and [string]::Equals($arguments,$launcherIdentity.Arguments,[StringComparison]::OrdinalIgnoreCase)
    })
    Assert-Scheduled ($launchers.Count -eq 1) 'The synthetic service did not have one exact GUI launcher.'
    $launcherHandle=[Diagnostics.Process]::GetProcessById([int]$launchers[0].ProcessId)
    try {
        $null=$launcherHandle.Handle
        $fresh=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$launchers[0].ProcessId)
        Assert-Scheduled ($fresh -and $fresh.CreationDate -eq $launchers[0].CreationDate) 'The synthetic GUI launcher identity changed.'
        $launcherHandle.Kill()
        Assert-Scheduled ($launcherHandle.WaitForExit(5000)) 'The terminated synthetic GUI launcher remained alive.'
    } finally { $launcherHandle.Dispose() }
    $deadline=[DateTime]::UtcNow.AddSeconds(8)
    do {
        $remaining=@(Get-GatewayOwnedProcesses $installed)
        if(-not $remaining.Count -and -not (Read-ScheduledHealth $port)){break}
        Start-Sleep -Milliseconds 150
    } while([DateTime]::UtcNow -lt $deadline)
    Assert-Scheduled ($remaining.Count -eq 0 -and -not (Read-ScheduledHealth $port)) 'A killed GUI launcher left an orphan runner or Node.'
    Start-Sleep -Seconds 2
    Assert-Scheduled (@(Get-GatewayOwnedProcesses $installed).Count -eq 0) 'The detached supervisor restarted Node after its GUI launcher exited.'
    Stop-GatewayScheduledService $installed
    Start-GatewayService $installed 30
    Assert-Scheduled ([bool](Read-ScheduledHealth $port)) 'An enabled service did not recover after synthetic launcher termination.'
    Write-Output 'PASS: force-terminated GUI launcher leaves no orphan runner or Node.'

    $restore = Invoke-ScheduledScript (Join-Path $installed 'restore.ps1')
    Assert-Scheduled ($restore.Code -eq 0) ('No-Directory restore failed: ' + $restore.ErrorOutput)
    Assert-Scheduled ((Read-ScheduledText $config) -ceq $directConfig) 'Direct config changed during no-Directory restore.'
    Assert-Scheduled ((Get-GatewayScheduledService $installed).Enabled -eq $false -and (Get-GatewayTaskState $installed).StateCode -ne 4) 'Restore did not disable and stop the owned service task.'
    Assert-Scheduled (-not (Read-ScheduledHealth $port)) 'Restore left the fixture listener running.'
    $healthCount = @(Get-Content -LiteralPath (Join-Path $installed 'fixture-health.ndjson')).Count
    $enable = Invoke-ScheduledScript (Join-Path $installed 'enable.ps1') @() 45 {
        if ((Read-ScheduledText $config) -match '(?m)^openai_base_url\s*=') { Assert-Scheduled ([bool](Read-ScheduledHealth $port)) 'Enable wrote its base URL before a healthy service was available.' }
    }
    Assert-Scheduled ($enable.Code -eq 0) ('No-Directory enable failed: ' + $enable.ErrorOutput)
    Assert-Scheduled ((Read-ScheduledText $config) -match '(?m)^openai_base_url\s*=') 'Enable did not activate the fake gateway config.'
    Assert-Scheduled ((Get-GatewayScheduledService $installed).Enabled -eq $true -and (Get-GatewayTaskState $installed).StateCode -eq 4) 'Enable did not activate the owned OS task.'
    $newHealth = @(Get-Content -LiteralPath (Join-Path $installed 'fixture-health.ndjson') | Select-Object -Skip $healthCount | ForEach-Object { $_ | ConvertFrom-Json })
    Assert-Scheduled ($newHealth.Count -gt 0 -and $newHealth[0].configHash -eq $beforeHash) 'Enable did not validate health while the fake config was still direct.'
    Write-Output 'PASS: no-Directory restore and health-before-enable.'

    $statusFile = Join-Path $installed 'private\control-status.json'
    if (Test-Path -LiteralPath $statusFile) { Remove-Item -LiteralPath $statusFile -Force }
    $oldPid = (Read-ScheduledHealth $port).pid
    $dispatch = Invoke-RestMethod ('http://127.0.0.1:' + $port + '/fixture-restart') -TimeoutSec 3 -UseBasicParsing
    Assert-Scheduled ($dispatch.parentPid -eq $oldPid) 'The mock gateway did not initiate the scheduler dispatcher itself.'
    $status = Wait-ScheduledControl $installed 'restart' 25
    Assert-Scheduled ($status.state -eq 'succeeded') 'The independently scheduled restart did not persist success.'
    $after = Read-ScheduledHealth $port
    Assert-Scheduled ($after -and $after.pid -ne $oldPid) 'Scheduled restart did not replace and recover the Node process.'
    Assert-Scheduled (-not (Get-Process -Id ([int]$oldPid) -ErrorAction SilentlyContinue)) 'The old fixture Node survived restart.'
    Assert-Scheduled (-not (Get-Process -Id ([int]$dispatch.dispatcherPid) -ErrorAction SilentlyContinue)) 'The short scheduler dispatcher remained alive.'
    Assert-Scheduled ((Get-GatewayTaskState $installed 'restart').Exists) 'The owned independent restart task was not created.'
    Write-Output 'PASS: Node initiates independent control; original Node and dispatcher exit; new Node and persistent success survive.'

    $restore = Invoke-ScheduledScript (Join-Path $installed 'restore.ps1') @() 35 {
        if (-not (Read-ScheduledHealth $port)) { Assert-Scheduled ((Read-ScheduledText $config) -notmatch '(?m)^openai_base_url\s*=') 'The service stopped before the fake config recovered direct access.' }
    }
    Assert-Scheduled ($restore.Code -eq 0 -and (Read-ScheduledText $config) -ceq $directConfig) ('Active recovery failed: ' + $restore.ErrorOutput)
    Assert-Scheduled ((Get-GatewayScheduledService $installed).Enabled -eq $false) 'Active recovery did not disable future starts.'
    $again = Invoke-ScheduledScript (Join-Path $installed 'restore.ps1')
    Assert-Scheduled ($again.Code -eq 0) 'Repeated scheduled recovery was not idempotent.'
    $enable = Invoke-ScheduledScript (Join-Path $installed 'enable.ps1')
    Assert-Scheduled ($enable.Code -eq 0) ('Second scheduled enable failed: ' + $enable.ErrorOutput)
    if (Test-Path -LiteralPath $statusFile) { Remove-Item -LiteralPath $statusFile -Force }
    $scheduledRestore = Invoke-ScheduledScript (Join-Path $installed 'scheduler.ps1') @('-ControlAction','restore')
    Assert-Scheduled ($scheduledRestore.Code -eq 0) ('Independent restore dispatcher failed: ' + $scheduledRestore.ErrorOutput)
    $status = Wait-ScheduledControl $installed 'restore' 25
    Assert-Scheduled ($status.state -eq 'succeeded' -and (Read-ScheduledText $config) -ceq $directConfig) 'Independent restore did not finish after stopping the service.'
    Assert-Scheduled ((Get-GatewayTaskState $installed 'restore').Exists -and -not (Read-ScheduledHealth $port)) 'The independent restore task or stopped listener state is incorrect.'
    Write-Output 'PASS: direct-before-stop, repeated recovery, second enable and independent restore.'

    if (-not $SkipFailureRollback) {
        $failurePrevious = Join-Path $fixture 'previous-failure'
        $failureConfig = Join-Path $fixture 'config-failure.toml'
        $failureRun = Join-Path $fixture 'run-failure.json'
        Write-GatewayUtf8 $failureConfig $directConfig
        Write-GatewayUtf8 $failureRun '{"value":"synthetic-preexisting-startup"}'
        Write-GatewayUtf8 (Join-Path $source 'fail-stable.json') '{}'
        New-ScheduledPrevious $failurePrevious (New-ScheduledPort) $failureConfig $failureRun
        $failureConfigBefore = Get-ScheduledFileHash $failureConfig; $failureRunBefore = Get-ScheduledFileHash $failureRun
        # Deployment's stable health timeout is 45 seconds. The outer launcher
        # budget also includes staging and rollback, with no repeated long polling.
        $failure = Invoke-ScheduledScript (Join-Path $source 'deploy.ps1') @('-SourceDirectory',$source,'-PreviousDirectory',$failurePrevious,'-InstallDirectory',$failedInstall,'-ConfigPath',$failureConfig,'-RunStateFile',$failureRun,'-SkipShortcuts','-UseScheduledTasks') 80
        Assert-Scheduled ($failure.Code -ne 0) 'Deliberately unhealthy stable deployment was accepted.'
        Assert-Scheduled ((Get-ScheduledFileHash $failureConfig) -eq $failureConfigBefore -and (Get-ScheduledFileHash $failureRun) -eq $failureRunBefore) 'Failed deployment altered fake connection or startup bytes.'
        Assert-Scheduled (-not (Get-GatewayTaskState $failedInstall).Exists) 'Failed deployment left its newly registered service task behind.'
        Write-Output 'PASS: stable health failure preserves fake config/Run and removes the new owned service task.'
    }
    Write-Output ('PASS: ' + $checks + ' scheduled lifecycle checks. All data, tasks, ports and processes belong to random isolated fixtures.')
} finally {
    $cleanupErrors = New-Object Collections.Generic.List[string]
    foreach ($root in $cleanupRoots) {
        foreach ($kind in @('restart','restore')) {
            try {
                $task = Get-GatewayScheduledControl $root $kind
                if ($task -and [int]$task.State -eq 4) { $task.Stop(0); Start-Sleep -Milliseconds 500 }
                Remove-GatewayScheduledControl $root $kind
            } catch { $cleanupErrors.Add('Owned fixture control cleanup failed: ' + $kind) }
        }
        try {
            if (Test-Path -LiteralPath (Join-Path $root 'private\settings.json')) { Stop-GatewayService $root }
            Remove-GatewayScheduledService $root
        } catch { $cleanupErrors.Add('Owned fixture service cleanup failed.') }
    }
    foreach ($fixtureDirectory in @(Get-ChildItem -LiteralPath $fixture -Directory -ErrorAction SilentlyContinue)) {
        if (Test-Path -LiteralPath (Join-Path $fixtureDirectory.FullName 'private\settings.json')) {
            try { Stop-GatewayService $fixtureDirectory.FullName } catch { $cleanupErrors.Add('Fixture process cleanup failed.') }
        }
    }
    if ($cleanupErrors.Count) { throw ($cleanupErrors -join ' ') }
    $actual = Get-GatewayPhysicalPath $fixture
    if (-not $actual.StartsWith($fixtureParent + '\',[StringComparison]::OrdinalIgnoreCase) -or -not (Test-GatewaySamePath $actual $fixture)) { throw 'Fixture cleanup escaped its physical parent.' }
    if (Test-Path -LiteralPath $actual) { Remove-Item -LiteralPath $actual -Recurse -Force }
}
