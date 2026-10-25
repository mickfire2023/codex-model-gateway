[CmdletBinding()]
param([switch]$IncludeRollback)
$ErrorActionPreference = 'Stop'
$release = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\gateway'))
. (Join-Path $release 'start.ps1') -LibraryOnly
function Assert-Lifecycle([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function New-TestPort {
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    return $port
}
function Invoke-LifecycleControl([string]$Root, [string]$Action, [string]$LogPrefix) {
    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $Root 'control.ps1') + '" -Directory "' + $Root + '" -Action ' + $Action
    $process = Start-Process -FilePath (Get-GatewayPowerShell) -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput ($LogPrefix + '.stdout.log') -RedirectStandardError ($LogPrefix + '.stderr.log')
    try {
        $null = $process.Handle
        if (-not $process.WaitForExit(150000)) { $process.Kill(); throw 'The isolated maintenance process timed out.' }
        return $process.ExitCode
    } finally { $process.Dispose() }
}
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('codex-gateway-lifecycle-' + [Guid]::NewGuid().ToString('N'))
$source = Join-Path $testRoot 'source'
$previous = Join-Path $testRoot 'previous'
$installed = Join-Path $testRoot 'installed'
$config = Join-Path $testRoot 'config.toml'
$runFile = Join-Path $testRoot 'run.json'
$shortcutDirectory = Join-Path $testRoot 'shortcuts'
$unrelatedChild = $null
$node = (Get-Command node.exe -ErrorAction Stop).Source
$fixtureGateway = @'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {spawn} = require('node:child_process');
const settings = JSON.parse(fs.readFileSync(path.join(__dirname,'private','settings.json'),'utf8'));
if (fs.existsSync(path.join(__dirname,'fail-stable.json')) && !settings.stagingValidation) process.exit(44);
http.createServer((req,res)=>{
  if (req.url === '/fixture-control-restart') {
    const launcher=path.join(process.env.SystemRoot,'System32','wscript.exe');
    const child=spawn(launcher,['//B','//NoLogo',path.join(__dirname,'control-launcher.vbs'),'restart'],{detached:true,windowsHide:true,stdio:'ignore'});
    child.unref();
    res.writeHead(200,{'content-type':'application/json; charset=utf-8'});
    return res.end(JSON.stringify({parentPid:process.pid,brokerPid:child.pid}));
  }
  res.writeHead(req.url === '/health' ? 200 : 404, {'content-type':'application/json; charset=utf-8'});
  res.end(JSON.stringify({ok:true,service:'codex-local-model-gateway',pid:process.pid,directory:__dirname,build:'fixture'}));
}).listen(settings.port,'127.0.0.1',()=>fs.writeFileSync(path.join(__dirname,'private','gateway.pid'),String(process.pid)));
fs.writeFileSync(path.join(__dirname,'combined-models.json'),JSON.stringify({models:[]}));
'@
try {
    foreach ($root in @($source,$previous)) {
        New-Item -ItemType Directory -Path (Join-Path $root 'private\history') -Force | Out-Null
        foreach ($name in @('start.ps1','physical-path.ps1','scheduler.ps1','runner.ps1','restart.ps1','restore.ps1','control.ps1','control-launcher.vbs','enable.ps1','launch.vbs','rescue.cjs','Emergency-restore-GPT.cmd','Open-dashboard.ps1','Open-dashboard.vbs','deploy.ps1')) { Copy-Item -LiteralPath (Join-Path $release $name) -Destination (Join-Path $root $name) }
        Write-GatewayUtf8 (Join-Path $root 'gateway.cjs') $fixtureGateway
        foreach ($name in @('openai-models.json','deepseek-models.json')) { Write-GatewayUtf8 (Join-Path $root $name) '{"models":[]}' }
        foreach ($name in @('provider-runner.cjs','chat-completions.cjs','provider-store.cjs','socket-router.cjs')) { Write-GatewayUtf8 (Join-Path $root $name) 'module.exports={};' }
    }
    New-Item -ItemType Directory -Path (Join-Path $source 'node_modules\ws') -Force | Out-Null
    Write-GatewayUtf8 (Join-Path $source 'node_modules\ws\package.json') '{"name":"ws","version":"0.0.0-fixture"}'
    $port = New-TestPort
    $token = 'fixture_route_token_0123456789'
    $settings = @{port = $port; routeToken = $token; nodePath = $node; catalogSyncEnabled = $false; previousBaseUrlLine = $null; previousCatalogLine = $null}
    Write-GatewayUtf8 (Join-Path $previous 'private\settings.json') ($settings | ConvertTo-Json)
    Write-GatewayUtf8 (Join-Path $previous 'private\deepseek-key.dpapi') 'fixture-ciphertext-never-decrypted'
    Write-GatewayUtf8 (Join-Path $previous 'private\history\conversation.json') '{"fixture":true}'
    New-Item -ItemType Directory -Path (Join-Path $previous 'private\providers') -Force | Out-Null
    Write-GatewayUtf8 (Join-Path $previous 'private\providers\fixture.dpapi') 'fixture-provider-ciphertext'
    Write-GatewayUtf8 (Join-Path $previous 'private\config.before-gateway.toml') 'original-fixture-config'
    $pluginSuffix = "[plugins.fixture]`nenabled = true`nmodel_catalog_json = 'plugin-value-must-stay'`n"
    $before = "openai_base_url = 'http://127.0.0.1:$port/$token/backend-api/codex'`nmodel_catalog_json = '" + (Join-Path $previous 'combined-models.json') + "'`nmodel = 'gpt-fixture'`n" + $pluginSuffix
    Write-GatewayUtf8 $config $before
    Write-GatewayUtf8 $runFile (@{value = 'fixture-old-run'} | ConvertTo-Json)
    New-Item -ItemType Directory -Path $shortcutDirectory -Force | Out-Null
    $shortcutShell = New-Object -ComObject WScript.Shell
    foreach ($name in @('Codex model gateway.lnk','Restore original GPT.lnk','恢复 GPT 直连.lnk')) {
        $seedShortcut = Join-Path $shortcutDirectory ([Guid]::NewGuid().ToString('N') + '.lnk')
        $legacyShortcut = $shortcutShell.CreateShortcut($seedShortcut)
        $legacyShortcut.TargetPath = Get-GatewayPowerShell
        $legacyShortcut.Save()
        Move-Item -LiteralPath $seedShortcut -Destination (Join-Path $shortcutDirectory $name)
    }
    # WhatIf may read fixture metadata but must not create an installation or start a process.
    & (Join-Path $release 'deploy.ps1') -SourceDirectory $source -PreviousDirectory $previous -InstallDirectory $installed -ConfigPath $config -RunStateFile $runFile -WhatIf
    Assert-Lifecycle (-not (Test-Path -LiteralPath $installed)) 'WhatIf created an installation.'
    Start-GatewayService $previous 15
    & (Join-Path $release 'deploy.ps1') -SourceDirectory $source -PreviousDirectory $previous -InstallDirectory $installed -ConfigPath $config -RunStateFile $runFile -ShortcutDirectory $shortcutDirectory
    Assert-Lifecycle (Test-GatewayHealth $installed) 'The installed fixture did not pass health.'
    Assert-Lifecycle (-not (Test-GatewayHealth $previous)) 'The previous fixture was left running.'
    $actualSettings = Get-GatewaySettings $installed
    Assert-Lifecycle ($actualSettings.port -eq $port -and $actualSettings.routeToken -ceq $token) 'The port or route token was changed.'
    Assert-Lifecycle ((Get-Content -LiteralPath (Join-Path $installed 'private\deepseek-key.dpapi') -Raw -Encoding UTF8) -ceq 'fixture-ciphertext-never-decrypted') 'The DPAPI ciphertext changed.'
    Assert-Lifecycle ((Get-Content -LiteralPath (Join-Path $installed 'private\config.before-gateway.toml') -Raw -Encoding UTF8) -ceq 'original-fixture-config') 'The original config backup changed.'
    Assert-Lifecycle (Test-Path -LiteralPath (Join-Path $installed 'private\history\conversation.json')) 'Conversation history was lost.'
    Assert-Lifecycle ((Get-Content -LiteralPath (Join-Path $installed 'private\providers\fixture.dpapi') -Raw -Encoding UTF8) -ceq 'fixture-provider-ciphertext') 'Provider credentials were not preserved.'
    $privateAcl = Get-Acl -LiteralPath (Join-Path $installed 'private')
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    Assert-Lifecycle ($privateAcl.AreAccessRulesProtected) 'Private data still inherits access rules.'
    Assert-Lifecycle (@($privateAcl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $currentSid }).Count -eq 0) 'Private data grants access to another identity.'
    Assert-Lifecycle ((Get-Content -LiteralPath $config -Raw -Encoding UTF8).EndsWith($pluginSuffix)) 'A plugin table was changed.'
    Assert-Lifecycle (Test-GatewayOwnedRun (Get-GatewayRunValue $runFile) $installed) 'Startup did not target the stable installation.'
    foreach ($name in @('模型网关管理.lnk','恢复 GPT 直连.lnk','重新启用模型网关.lnk')) { Assert-Lifecycle (Test-Path -LiteralPath (Join-Path $shortcutDirectory $name)) 'A Chinese gateway shortcut was not created.' }
    foreach ($name in @('Codex model gateway.lnk','Restore original GPT.lnk')) { Assert-Lifecycle (-not (Test-Path -LiteralPath (Join-Path $shortcutDirectory $name))) 'A duplicate English gateway shortcut remained in the menu.' }
    $inspectShortcut = Join-Path $testRoot 'inspect-shortcut.lnk'
    Copy-Item -LiteralPath (Join-Path $shortcutDirectory '重新启用模型网关.lnk') -Destination $inspectShortcut
    $enableShortcut = $shortcutShell.CreateShortcut($inspectShortcut)
    Assert-Lifecycle ($enableShortcut.Arguments.Contains((Join-Path $installed 'enable.ps1')) -and $enableShortcut.Arguments.Contains('-WindowStyle Hidden') -and $enableShortcut.Arguments.Contains('-ShowMessage')) 'The enable shortcut does not launch the stable hidden entry point.'
    Assert-Lifecycle ((Get-FileHash -LiteralPath $node).Hash -ceq (Get-FileHash -LiteralPath $actualSettings.nodePath).Hash) 'The stable runtime differs from the existing local runtime.'
    $wrongServiceRejected = $false
    try { Start-GatewayService $previous 3 } catch { $wrongServiceRejected = $true }
    finally { Stop-GatewayService $previous }
    Assert-Lifecycle $wrongServiceRejected 'An unrelated healthy service on the same port was mistaken for a successful start.'
    Write-GatewayUtf8 (Join-Path $previous 'private\runner.pid') ([string]$PID)
    Write-GatewayUtf8 (Join-Path $previous 'private\gateway.pid') ([string]$PID)
    Stop-GatewayService $previous
    Assert-Lifecycle ($null -ne (Get-Process -Id $PID)) 'A stale PID was treated as an owned gateway process.'
    $unrelatedScript = Join-Path $previous 'other.cjs'
    Write-GatewayUtf8 $unrelatedScript 'setInterval(()=>{},1000);'
    $unrelatedChild = Start-Process -FilePath $node -ArgumentList ('"' + $unrelatedScript + '" "' + (Join-Path $previous 'gateway.cjs') + '"') -WindowStyle Hidden -PassThru
    Stop-GatewayService $previous
    $unrelatedChild.Refresh()
    Assert-Lifecycle (-not $unrelatedChild.HasExited) 'A different Node application was stopped because an extra argument mentioned the gateway.'
    $unrelatedChild.Kill()
    $unrelatedChild.WaitForExit()
    $unrelatedChild.Dispose()
    $unrelatedChild = $null
    $restartScript = Join-Path $installed 'restart.ps1'
    $restartBackup = Join-Path $installed 'restart.fixture-backup.ps1'
    Copy-Item -LiteralPath $restartScript -Destination $restartBackup
    Write-GatewayUtf8 $restartScript '$ErrorActionPreference = ''Stop''; [Console]::Out.WriteLine(''fixture-secret-not-public''); throw ''fixture-secret-not-public'''
    $failedControlLog = Join-Path $testRoot 'control-failure'
    $failedControlExit = Invoke-LifecycleControl $installed 'restart' $failedControlLog
    Copy-Item -LiteralPath $restartBackup -Destination $restartScript -Force
    Assert-Lifecycle ($failedControlExit -ne 0) 'Failed maintenance reported success.'
    $controlStatusPath = Join-Path $installed 'private\control-status.json'
    $failedControl = Get-Content -LiteralPath $controlStatusPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-Lifecycle ($failedControl.state -ceq 'failed' -and $failedControl.action -ceq 'restart' -and [bool]$failedControl.finishedAt) 'Failed maintenance status was not persisted.'
    $publicFailureText = (Get-Content -LiteralPath $controlStatusPath -Raw -Encoding UTF8) + (Get-Content -LiteralPath ($failedControlLog + '.stdout.log') -Raw -Encoding UTF8) + (Get-Content -LiteralPath ($failedControlLog + '.stderr.log') -Raw -Encoding UTF8)
    Assert-Lifecycle (-not $publicFailureText.Contains('fixture-secret-not-public')) 'Child maintenance error text leaked into status or output.'
    Assert-Lifecycle ((Invoke-LifecycleControl $installed 'restart' (Join-Path $testRoot 'control-restart')) -eq 0) 'Maintenance restart failed.'
    $controlStatus = Get-Content -LiteralPath $controlStatusPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-Lifecycle ($controlStatus.state -ceq 'succeeded' -and $controlStatus.action -ceq 'restart' -and [bool]$controlStatus.startedAt -and [bool]$controlStatus.finishedAt) 'Restart success status was not persisted.'
    Assert-Lifecycle (Test-GatewayHealth $installed) 'Restart did not wait for health.'
    Move-Item -LiteralPath $controlStatusPath -Destination ($controlStatusPath + '.before-broker')
    $brokerRestart = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/fixture-control-restart') -UseBasicParsing -TimeoutSec 5
    $brokerDeadline = [DateTime]::UtcNow.AddSeconds(60)
    $brokerStatus = $null
    do {
        if (Test-Path -LiteralPath $controlStatusPath) { $brokerStatus = Get-Content -LiteralPath $controlStatusPath -Raw -Encoding UTF8 | ConvertFrom-Json }
        if ($brokerStatus -and $brokerStatus.state -in @('succeeded','failed')) { break }
        Start-Sleep -Milliseconds 300
    } while ([DateTime]::UtcNow -lt $brokerDeadline)
    Assert-Lifecycle ($brokerStatus.state -ceq 'succeeded') 'The detached broker did not persist success after its parent gateway was stopped.'
    $brokerHealth = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/health') -UseBasicParsing -TimeoutSec 5
    Assert-Lifecycle ($brokerHealth.pid -ne $brokerRestart.parentPid) 'The broker did not restart its parent gateway process.'
    Assert-Lifecycle (-not (Get-Process -Id $brokerRestart.parentPid -ErrorAction SilentlyContinue)) 'The original parent gateway was left running.'
    if ($IncludeRollback) {
        Write-GatewayUtf8 (Join-Path $source 'fail-stable.json') '{}'
        $beforeFailureConfig = Get-Content -LiteralPath $config -Raw -Encoding UTF8
        $beforeFailureRun = Get-GatewayRunValue $runFile
        $failedAsExpected = $false
        try { & (Join-Path $release 'deploy.ps1') -SourceDirectory $source -PreviousDirectory $installed -InstallDirectory $installed -ConfigPath $config -RunStateFile $runFile -SkipShortcuts }
        catch { $failedAsExpected = $true }
        Assert-Lifecycle $failedAsExpected 'The failing stable fixture was accepted.'
        Assert-Lifecycle (Test-GatewayHealth $installed) 'Rollback did not restart the previous healthy installation.'
        Assert-Lifecycle ((Get-Content -LiteralPath $config -Raw -Encoding UTF8) -ceq $beforeFailureConfig) 'Rollback changed Codex settings.'
        Assert-Lifecycle ((Get-GatewayRunValue $runFile) -ceq $beforeFailureRun) 'Rollback changed the startup setting.'
        Remove-Item -LiteralPath (Join-Path $source 'fail-stable.json')
        $shortcutBlocker = Join-Path $testRoot 'shortcut-blocker'
        Write-GatewayUtf8 $shortcutBlocker 'fixture file blocks shortcut directory creation'
        $failedAfterActivation = $false
        try { & (Join-Path $release 'deploy.ps1') -SourceDirectory $source -PreviousDirectory $installed -InstallDirectory $installed -ConfigPath $config -RunStateFile $runFile -ShortcutDirectory (Join-Path $shortcutBlocker 'shortcuts') }
        catch { $failedAfterActivation = $true }
        Assert-Lifecycle $failedAfterActivation 'The post-activation failure fixture did not fail.'
        Assert-Lifecycle (Test-GatewayHealth $installed) 'Rollback after configuration activation did not restart the previous service.'
        Assert-Lifecycle ((Get-Content -LiteralPath $config -Raw -Encoding UTF8) -ceq $beforeFailureConfig) 'Rollback after activation changed Codex settings.'
        Assert-Lifecycle ((Get-GatewayRunValue $runFile) -ceq $beforeFailureRun) 'Rollback after activation changed the startup setting.'
    }
    Assert-Lifecycle ((Invoke-LifecycleControl $installed 'restore' (Join-Path $testRoot 'control-restore')) -eq 0) 'Maintenance recovery failed.'
    $restoreControl = Get-Content -LiteralPath $controlStatusPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-Lifecycle ($restoreControl.state -ceq 'succeeded' -and $restoreControl.action -ceq 'restore' -and [bool]$restoreControl.finishedAt) 'Recovery could not write its final status after stopping the gateway.'
    & (Join-Path $installed 'restore.ps1')
    Assert-Lifecycle (-not (Get-GatewayRootLine (Get-Content -LiteralPath $config -Raw -Encoding UTF8) 'openai_base_url')) 'Recovery did not remove its owned connection.'
    Assert-Lifecycle (-not (Get-GatewayRunValue $runFile)) 'Recovery did not remove its owned startup setting.'
    Assert-Lifecycle ((Get-Content -LiteralPath $config -Raw -Encoding UTF8).EndsWith($pluginSuffix)) 'Recovery changed a plugin table.'
    $disabledConfig = Get-Content -LiteralPath $config -Raw -Encoding UTF8
    $settingsPath = Join-Path $installed 'private\settings.json'
    $settingsBeforeEnable = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8
    $failedEnable = $false
    try { & (Join-Path $installed 'enable.ps1') -RunStateFile (Join-Path $testRoot 'missing-parent\run.json') }
    catch { $failedEnable = $true }
    Assert-Lifecycle $failedEnable 'The startup-write failure fixture was accepted.'
    Assert-Lifecycle ((Get-Content -LiteralPath $config -Raw -Encoding UTF8) -ceq $disabledConfig) 'Enable did not roll back its connection after a startup-write failure.'
    Assert-Lifecycle (-not (Get-GatewayRunValue $runFile)) 'Failed enable changed the actual startup setting.'
    & (Join-Path $installed 'enable.ps1')
    Assert-Lifecycle (Test-GatewayHealth $installed) 'Re-enable did not pass health.'
    Assert-Lifecycle ((Get-GatewayTomlValue (Get-GatewayRootLine (Get-Content -LiteralPath $config -Raw -Encoding UTF8) 'openai_base_url')) -ceq ('http://127.0.0.1:' + $port + '/' + $token + '/backend-api/codex')) 'Re-enable did not activate its owned connection.'
    Assert-Lifecycle (Test-GatewayOwnedRun (Get-GatewayRunValue $runFile) $installed) 'Re-enable did not restore stable startup.'
    Assert-Lifecycle ((Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8) -ceq $settingsBeforeEnable) 'Re-enable modified original recovery metadata.'
    & (Join-Path $installed 'restore.ps1')
    Assert-Lifecycle ((Get-Content -LiteralPath $config -Raw -Encoding UTF8) -ceq $disabledConfig) 'Disable-enable-restore did not return to the original direct configuration.'
    $syncSettings = Get-GatewaySettings $installed
    $syncSettings.catalogSyncEnabled = $true
    Write-GatewayUtf8 $settingsPath ($syncSettings | ConvertTo-Json -Depth 30)
    $externalCatalogLine = "model_catalog_json = 'C:\future\external-catalog.json'"
    Write-GatewayUtf8 $config (Set-GatewayRootLine $disabledConfig 'model_catalog_json' $externalCatalogLine)
    & (Join-Path $installed 'enable.ps1')
    Assert-Lifecycle ((Get-GatewayRootLine (Get-Content -LiteralPath $config -Raw -Encoding UTF8) 'model_catalog_json') -ceq $externalCatalogLine) 'Catalog sync enable removed an external future catalog.'
    & (Join-Path $installed 'restore.ps1')
    Assert-Lifecycle ((Get-GatewayRootLine (Get-Content -LiteralPath $config -Raw -Encoding UTF8) 'model_catalog_json') -ceq $externalCatalogLine) 'Restore removed an external future catalog.'
    $syncSettings.previousBaseUrlLine = "openai_base_url = 'https://original.example.test/backend'"
    Write-GatewayUtf8 $settingsPath ($syncSettings | ConvertTo-Json -Depth 30)
    Write-GatewayUtf8 $config (Set-GatewayRootLine (Get-Content -LiteralPath $config -Raw -Encoding UTF8) 'openai_base_url' $syncSettings.previousBaseUrlLine)
    & (Join-Path $installed 'enable.ps1')
    & (Join-Path $installed 'restore.ps1')
    Assert-Lifecycle ((Get-GatewayRootLine (Get-Content -LiteralPath $config -Raw -Encoding UTF8) 'openai_base_url') -ceq $syncSettings.previousBaseUrlLine) 'The original explicit connection was not preserved across enable and restore.'
    $future = "openai_base_url = 'https://future.example.test/backend'`nmodel_catalog_json = 'C:\future\catalog.json'`n" + $pluginSuffix
    Write-GatewayUtf8 $config $future
    Write-GatewayUtf8 $runFile (@{value='future-unrelated-startup'} | ConvertTo-Json)
    $futureEnableRejected = $false
    try { & (Join-Path $installed 'enable.ps1') } catch { $futureEnableRejected = $true }
    Assert-Lifecycle $futureEnableRejected 'Re-enable overwrote a future connection.'
    & (Join-Path $installed 'restore.ps1')
    Assert-Lifecycle ((Get-Content -LiteralPath $config -Raw -Encoding UTF8) -ceq $future) 'Repeated recovery overwrote a future connection.'
    Assert-Lifecycle ((Get-GatewayRunValue $runFile) -ceq 'future-unrelated-startup') 'Repeated recovery removed a future startup setting.'
    Assert-Lifecycle (Test-Path -LiteralPath (Join-Path $installed 'private\deepseek-key.dpapi')) 'Recovery deleted the credential.'
    Write-Output ('PASS: isolated lifecycle checks. Fixture files retained at ' + $testRoot)
} finally {
    if ($unrelatedChild) { try { if (-not $unrelatedChild.HasExited) { $unrelatedChild.Kill(); $unrelatedChild.WaitForExit() } } finally { $unrelatedChild.Dispose() } }
    foreach ($candidate in @($installed,$previous) + @(Get-ChildItem -LiteralPath $testRoot -Directory -Filter 'installed.*' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })) {
        if (Test-Path -LiteralPath (Join-Path $candidate 'private\settings.json')) { try { Stop-GatewayService $candidate } catch {} }
    }
}
