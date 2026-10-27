[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$SourceDirectory,
    [string]$PreviousDirectory,
    [string]$InstallDirectory,
    [string]$ConfigPath,
    [string]$RunStateFile,
    [string]$ShortcutDirectory,
    [switch]$SkipShortcuts,
    [switch]$UseScheduledTasks,
    [switch]$KeepDirectConnection
)
$ErrorActionPreference = 'Stop'
if (-not $PSBoundParameters.ContainsKey('SourceDirectory')) { $SourceDirectory = $PSScriptRoot }
if (-not $PSBoundParameters.ContainsKey('InstallDirectory')) { $InstallDirectory = Join-Path $env:USERPROFILE 'Documents\CodexModelGateway' }
. (Join-Path $PSScriptRoot 'start.ps1') -Directory $PSScriptRoot -LibraryOnly
$useScheduler = $UseScheduledTasks -or -not $RunStateFile

function Assert-GatewayWithin([string]$Path, [string]$Parent) {
    $full = Get-GatewayFullPath $Path
    $root = Get-GatewayFullPath $Parent
    if (-not $full.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'An isolated test path is outside the test directory.' }
}
function Copy-GatewayTree([string]$From, [string]$To, [switch]$Private) {
    New-Item -ItemType Directory -Path $To -Force | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $From -Force) {
        if ($Private -and ($item.Name -eq 'enabled' -or $item.Name -like '*.pid')) { continue }
        $destination = Join-Path $To $item.Name
        if ($item.PSIsContainer) { Copy-GatewayTree $item.FullName $destination -Private:$Private }
        else { Copy-Item -LiteralPath $item.FullName -Destination $destination -Force }
    }
}
function Set-GatewaySetting([object]$Settings, [string]$Name, $Value) {
    $Settings | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
}
function Save-GatewaySettings([object]$Settings, [string]$Root) {
    Write-GatewayUtf8 (Join-Path $Root 'private\settings.json') ($Settings | ConvertTo-Json -Depth 30)
}
function Protect-GatewayPrivate([string]$PrivateDirectory) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $items = @((Get-Item -LiteralPath $PrivateDirectory)) + @(Get-ChildItem -LiteralPath $PrivateDirectory -Recurse -Force)
    foreach ($item in $items) {
        if ($item.PSIsContainer) {
            $security = New-Object Security.AccessControl.DirectorySecurity
            $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
            $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
        } else {
            $security = New-Object Security.AccessControl.FileSecurity
            $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)
        }
        $security.SetAccessRuleProtection($true, $false)
        $security.SetOwner($sid)
        $security.AddAccessRule($rule)
        Set-Acl -LiteralPath $item.FullName -AclObject $security
    }
}
function New-GatewayConfig([string]$Text, [object]$Settings, [string[]]$CatalogPaths) {
    $base = Get-GatewayRootLine $Text 'openai_base_url'
    $wantedBase = 'http://127.0.0.1:' + $Settings.port + '/' + $Settings.routeToken + '/backend-api/codex'
    if ($base -and (Get-GatewayTomlValue $base) -cne $wantedBase -and $base -cne [string]$Settings.previousBaseUrlLine) { throw 'The Codex connection was changed outside this gateway. Deployment left that setting untouched.' }
    $catalog = Get-GatewayRootLine $Text 'model_catalog_json'
    if ($catalog) {
        $catalogValue = Get-GatewayTomlValue $catalog
        $owned = $false
        foreach ($path in $CatalogPaths) { if (Test-GatewaySamePath $catalogValue $path) { $owned = $true; break } }
        if (-not $owned -and $catalog -cne [string]$Settings.previousCatalogLine) { throw 'The model catalog was changed outside this gateway. Deployment left that setting untouched.' }
    }
    $next = Set-GatewayRootLine $Text 'openai_base_url' ('openai_base_url = ' + (ConvertTo-GatewayToml $wantedBase))
    $catalogLine = if ($Settings.catalogSyncEnabled) { $null } else { 'model_catalog_json = ' + (ConvertTo-GatewayToml (Join-Path $InstallDirectory 'combined-models.json')) }
    return (Set-GatewayRootLine $next 'model_catalog_json' $catalogLine)
}
function Save-GatewayShortcut([object]$Shortcut, [string]$TemporaryPath, [string]$FinalPath) {
    # WScript's Save uses the system code page for the filename on some Windows locales.
    # Save an ASCII filename first; .NET's Unicode file APIs install the Chinese name.
    try {
        $Shortcut.Save()
        if (Test-Path -LiteralPath $FinalPath) { [IO.File]::Replace($TemporaryPath, $FinalPath, [System.Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($TemporaryPath, $FinalPath) }
    } finally { if (Test-Path -LiteralPath $TemporaryPath) { Remove-Item -LiteralPath $TemporaryPath -Force } }
}
function New-GatewayShortcuts([string]$Root, [string]$Destination) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    foreach ($pair in @(@('Codex model gateway.lnk','模型网关管理.lnk'), @('Restore original GPT.lnk','恢复 GPT 直连.lnk'))) {
        $legacy = Join-Path $Destination $pair[0]
        $renamed = Join-Path $Destination $pair[1]
        if (Test-Path -LiteralPath $legacy -PathType Leaf) {
            if (-not (Test-Path -LiteralPath $renamed)) { Move-Item -LiteralPath $legacy -Destination $renamed }
            else {
                $backupDirectory = Join-Path $Root 'private\legacy-shortcuts'
                New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
                Move-Item -LiteralPath $legacy -Destination (Join-Path $backupDirectory ([Guid]::NewGuid().ToString('N') + '-' + $pair[0]))
            }
        }
    }
    $shell = New-Object -ComObject WScript.Shell
    $temporaryShortcut = Join-Path $Destination ([Guid]::NewGuid().ToString('N') + '.lnk')
    $manage = $shell.CreateShortcut($temporaryShortcut)
    $manage.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $manage.Arguments = '"' + (Join-Path $Root 'Open-dashboard.vbs') + '"'
    $manage.WorkingDirectory = $Root
    $manage.WindowStyle = 7
    $manage.Description = 'Open the Codex model gateway dashboard'
    Save-GatewayShortcut $manage $temporaryShortcut (Join-Path $Destination '模型网关管理.lnk')
    $temporaryShortcut = Join-Path $Destination ([Guid]::NewGuid().ToString('N') + '.lnk')
    $restore = $shell.CreateShortcut($temporaryShortcut)
    $restore.TargetPath = Get-GatewayPowerShell
    $restore.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $Root 'restore.ps1') + '" -Directory "' + $Root + '" -ShowMessage'
    $restore.WorkingDirectory = $Root
    $restore.WindowStyle = 7
    $restore.Description = 'Restore the original GPT connection, then restart Codex'
    Save-GatewayShortcut $restore $temporaryShortcut (Join-Path $Destination '恢复 GPT 直连.lnk')
    $temporaryShortcut = Join-Path $Destination ([Guid]::NewGuid().ToString('N') + '.lnk')
    $enable = $shell.CreateShortcut($temporaryShortcut)
    $enable.TargetPath = Get-GatewayPowerShell
    $enable.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $Root 'enable.ps1') + '" -Directory "' + $Root + '" -ShowMessage'
    $enable.WorkingDirectory = $Root
    $enable.WindowStyle = 7
    $enable.Description = 'Enable the model gateway after restoring direct GPT access'
    Save-GatewayShortcut $enable $temporaryShortcut (Join-Path $Destination '重新启用模型网关.lnk')
    $temporaryShortcut = Join-Path $Destination ([Guid]::NewGuid().ToString('N') + '.lnk')
    $rescue = $shell.CreateShortcut($temporaryShortcut)
    $rescue.TargetPath = Join-Path $Root 'Emergency-restore-GPT.cmd'
    $rescue.WorkingDirectory = $Root
    $rescue.Description = 'Restore GPT access without PowerShell or VBS'
    Save-GatewayShortcut $rescue $temporaryShortcut (Join-Path $Destination '紧急恢复 GPT.lnk')
}

$SourceDirectory = Get-GatewayPhysicalPath (Get-GatewayFullPath $SourceDirectory)
$InstallDirectory = Get-GatewayPhysicalPath (Get-GatewayFullPath $InstallDirectory)
if (-not $PreviousDirectory) {
    $PreviousDirectory = if (Test-Path -LiteralPath (Join-Path $InstallDirectory 'private\settings.json')) { $InstallDirectory } elseif (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'CodexModelGateway\private\settings.json')) { Join-Path $env:LOCALAPPDATA 'CodexModelGateway' } else { Join-Path (Split-Path -Parent $SourceDirectory) 'codex-model-gateway' }
}
$PreviousDirectory = Get-GatewayPhysicalPath (Get-GatewayFullPath $PreviousDirectory)
if (Test-GatewaySamePath $SourceDirectory $InstallDirectory) { throw 'The source and installation directories must be different.' }
foreach ($required in @('gateway.cjs','gemini-service.cjs','gemini-service.ps1','gemini-updater.cjs','provider-runner.cjs','chat-completions.cjs','provider-store.cjs','socket-router.cjs','reasoning-carriers.cjs','start.ps1','physical-path.ps1','scheduler.ps1','runner.ps1','restart.ps1','restore.ps1','control.ps1','control-launcher.vbs','enable.ps1','launch.vbs','rescue.cjs','Emergency-restore-GPT.cmd','Open-dashboard.ps1','Open-dashboard.vbs','openai-models.json','deepseek-models.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $SourceDirectory $required) -PathType Leaf)) { throw ('The release is incomplete: ' + $required) }
}
if (-not (Test-Path -LiteralPath (Join-Path $PreviousDirectory 'private\settings.json') -PathType Leaf)) { throw 'The previous gateway settings could not be found. Supply -PreviousDirectory to preserve the existing connection and encrypted credential.' }
$settings = Get-GatewaySettings $PreviousDirectory
$ConfigPath = Get-GatewayConfigPath $settings $ConfigPath
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw 'The Codex configuration file was not found.' }
$ConfigPath = Get-GatewayPhysicalPath (Get-GatewayFullPath $ConfigPath)
if ($RunStateFile) {
    $RunStateFile = Get-GatewayFullPath $RunStateFile
    $testRoot = Split-Path -Parent $RunStateFile
    foreach ($path in @($SourceDirectory,$PreviousDirectory,$InstallDirectory,$ConfigPath)) { Assert-GatewayWithin $path $testRoot }
    if ($ShortcutDirectory) { Assert-GatewayWithin $ShortcutDirectory $testRoot } else { $SkipShortcuts = $true }
}
if (-not $ShortcutDirectory) { $ShortcutDirectory = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex model gateway' }
$parent = Split-Path -Parent $InstallDirectory
if (-not $parent -or $InstallDirectory -eq [System.IO.Path]::GetPathRoot($InstallDirectory)) { throw 'Choose a dedicated installation folder.' }
if (-not $PSCmdlet.ShouldProcess($InstallDirectory, 'Validate a staged gateway, migrate the existing private data and local Node runtime, then switch Codex with automatic rollback')) { return }

$mutex = Get-GatewayMutex $InstallDirectory
$locked = $false
$id = [Guid]::NewGuid().ToString('N')
$staging = $InstallDirectory + '.staging-' + $id
$rollback = $InstallDirectory + '.rollback-' + $id
$failed = $InstallDirectory + '.failed-' + $id
foreach ($path in @($staging,$rollback,$failed)) { Assert-GatewayWithin $path $parent }
$beforeConfig = $null
$beforeRun = $null
$newConfig = $null
$runChanged = $false
$configChanged = $false
$oldStopped = $false
$swapped = $false
$hadInstalledDirectory = Test-Path -LiteralPath $InstallDirectory
$previousWasEnabled = Test-Path -LiteralPath (Join-Path $PreviousDirectory 'private\enabled')
$previousWasRunning = $false
$separateInstalledWasRunning = $false
$shortcutSnapshots = @{}
$shortcutsTouched = $false
$taskSnapshot = $null
$taskTouched = $false
try {
    try { $locked = $mutex.WaitOne([TimeSpan]::FromSeconds(60)) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another gateway maintenance operation is in progress.' }
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $SourceDirectory -File -Force) {
        if ($item.Extension -in @('.cjs','.json','.ps1','.vbs','.cmd','.md','.yaml')) { Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $staging $item.Name) -Force }
    }
    # Source releases contain no personal or vendor-cached model catalog.
    foreach ($catalogName in @('openai-models.json','deepseek-models.json')) {
        $seed = Get-Content -LiteralPath (Join-Path $staging $catalogName) -Raw -Encoding UTF8 | ConvertFrom-Json
        $previousCatalog = Join-Path $PreviousDirectory $catalogName
        if (@($seed.models).Count -eq 0 -and (Test-Path -LiteralPath $previousCatalog -PathType Leaf)) {
            $cached = Get-Content -LiteralPath $previousCatalog -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($cached.PSObject.Properties.Name -contains 'models' -and $cached.models -is [Array]) { Copy-Item -LiteralPath $previousCatalog -Destination (Join-Path $staging $catalogName) -Force }
        }
    }
    if (-not (Test-GatewaySamePath (Get-GatewayPhysicalPath (Join-Path $staging 'gateway.cjs')) (Join-Path $staging 'gateway.cjs'))) { throw 'The chosen installation folder is redirected by Windows. Select a physical Documents folder.' }
    Copy-GatewayTree (Join-Path $PreviousDirectory 'private') (Join-Path $staging 'private') -Private
    Protect-GatewayPrivate (Join-Path $staging 'private')
    # DPAPI ciphertext is copied unchanged. It is never decrypted or written to deployment output.
    $wsSource = Join-Path $SourceDirectory 'node_modules\ws'
    if (-not (Test-Path -LiteralPath $wsSource)) { $wsSource = Join-Path $PreviousDirectory 'node_modules\ws' }
    if (-not (Test-Path -LiteralPath (Join-Path $wsSource 'package.json'))) { throw 'The local ws dependency is missing; no network download was attempted.' }
    Copy-GatewayTree $wsSource (Join-Path $staging 'node_modules\ws')
    $nodeSource = [string]$settings.nodePath
    if (-not (Test-Path -LiteralPath $nodeSource -PathType Leaf) -or [System.IO.Path]::GetFileName($nodeSource) -ine 'node.exe') { throw 'The previously configured local Node runtime is missing.' }
    $nodeInfo = (Get-Item -LiteralPath $nodeSource).VersionInfo
    if ($nodeInfo.ProductName -notmatch 'Node\.js') { throw 'The existing runtime could not be identified as Node.js.' }
    New-Item -ItemType Directory -Path (Join-Path $staging 'runtime') -Force | Out-Null
    Copy-Item -LiteralPath $nodeSource -Destination (Join-Path $staging 'runtime\node.exe') -Force
    foreach ($dll in Get-ChildItem -LiteralPath (Split-Path -Parent $nodeSource) -Filter '*.dll' -File) { Copy-Item -LiteralPath $dll.FullName -Destination (Join-Path (Join-Path $staging 'runtime') $dll.Name) -Force }
    foreach ($notice in @('LICENSE','LICENSE.txt','NOTICE','NOTICE.txt')) {
        $noticePath = Join-Path (Split-Path -Parent $nodeSource) $notice
        if (Test-Path -LiteralPath $noticePath -PathType Leaf) { Copy-Item -LiteralPath $noticePath -Destination (Join-Path $staging ('runtime\' + $notice)) -Force }
    }
    if ((Get-FileHash -LiteralPath $nodeSource -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath (Join-Path $staging 'runtime\node.exe') -Algorithm SHA256).Hash) { throw 'The local Node runtime copy did not verify.' }
    $catalogPaths = @((Join-Path $PreviousDirectory 'combined-models.json'), (Join-Path $InstallDirectory 'combined-models.json'), (Join-Path $SourceDirectory 'combined-models.json'))
    if ($settings.lifecycle -and $settings.lifecycle.ownedCatalogPaths) { $catalogPaths += @($settings.lifecycle.ownedCatalogPaths) }
    $ownedDirectories = @($InstallDirectory,$PreviousDirectory,[string]$settings.directory)
    if ($settings.lifecycle -and $settings.lifecycle.ownedDirectories) { $ownedDirectories += @($settings.lifecycle.ownedDirectories) }
    Set-GatewaySetting $settings 'lifecycle' ([pscustomobject]@{ version = 3; startupMode = 'process'; configPath = $ConfigPath; runStateFile = $RunStateFile; ownedDirectories = @($ownedDirectories | Where-Object { $_ } | Select-Object -Unique); ownedCatalogPaths = @($catalogPaths | Select-Object -Unique); installedAt = [DateTime]::UtcNow.ToString('o') })
    $beforeConfig = [System.IO.File]::ReadAllText($ConfigPath, [Text.Encoding]::UTF8)
    $beforeRun = Get-GatewayRunValue $RunStateFile
    $newConfig = if ($KeepDirectConnection) { $beforeConfig } else { New-GatewayConfig $beforeConfig $settings $catalogPaths }
    if (-not (Test-Path -LiteralPath (Join-Path $staging 'private\config.before-gateway.toml'))) { Copy-Item -LiteralPath $ConfigPath -Destination (Join-Path $staging 'private\config.before-gateway.toml') }
    Write-GatewayUtf8 (Join-Path $staging 'private\config.before-deployment.toml') $beforeConfig
    Write-GatewayUtf8 (Join-Path $staging 'private\run.before-deployment.json') (@{ value = $beforeRun } | ConvertTo-Json)
    $realPort = [int]$settings.port
    $realSync = [bool]$settings.catalogSyncEnabled
    $temporaryListener = New-Object System.Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
    $temporaryListener.Start()
    $testPort = $temporaryListener.LocalEndpoint.Port
    $temporaryListener.Stop()
    Set-GatewaySetting $settings 'port' $testPort
    Set-GatewaySetting $settings 'nodePath' (Join-Path $staging 'runtime\node.exe')
    Set-GatewaySetting $settings 'directory' $staging
    Set-GatewaySetting $settings 'catalogSyncEnabled' $false
    Set-GatewaySetting $settings 'stagingValidation' $true
    Save-GatewaySettings $settings $staging
    try { Start-GatewayService $staging 30 } finally { Stop-GatewayService $staging }
    Set-GatewaySetting $settings 'port' $realPort
    Set-GatewaySetting $settings 'nodePath' (Join-Path $InstallDirectory 'runtime\node.exe')
    Set-GatewaySetting $settings 'directory' $InstallDirectory
    Set-GatewaySetting $settings 'catalogSyncEnabled' $realSync
    Set-GatewaySetting $settings 'stagingValidation' $false
    if ($useScheduler) { $settings.lifecycle.startupMode = 'scheduledTask'; $taskSnapshot = Get-GatewayScheduledTaskSnapshot $InstallDirectory }
    Save-GatewaySettings $settings $staging
    if ([System.IO.File]::ReadAllText($ConfigPath, [Text.Encoding]::UTF8) -cne $beforeConfig -or (Get-GatewayRunValue $RunStateFile) -cne $beforeRun) { throw 'Codex settings changed while the new service was being validated. Deployment was cancelled safely.' }
    # Only now interrupt the old same-port service. Keep every old file for rollback.
    $previousWasRunning = @(Get-GatewayOwnedProcesses $PreviousDirectory).Count -gt 0
    $oldStopped = $true
    Stop-GatewayService $PreviousDirectory
    if ($hadInstalledDirectory -and -not (Test-GatewaySamePath $PreviousDirectory $InstallDirectory)) {
        if (Test-Path -LiteralPath (Join-Path $InstallDirectory 'private\settings.json')) {
            $separateInstalledWasRunning = (Test-Path -LiteralPath (Join-Path $InstallDirectory 'private\enabled')) -or @(Get-GatewayOwnedProcesses $InstallDirectory).Count -gt 0
            Stop-GatewayService $InstallDirectory
        }
    }
    if ($hadInstalledDirectory) { Move-Item -LiteralPath $InstallDirectory -Destination $rollback }
    try { Move-Item -LiteralPath $staging -Destination $InstallDirectory; $swapped = $true }
    catch {
        if ($hadInstalledDirectory -and (Test-Path -LiteralPath $rollback) -and -not (Test-Path -LiteralPath $InstallDirectory)) { Move-Item -LiteralPath $rollback -Destination $InstallDirectory }
        throw
    }
    $taskTouched = $useScheduler
    Start-GatewayService $InstallDirectory 45
    if ([System.IO.File]::ReadAllText($ConfigPath, [Text.Encoding]::UTF8) -cne $beforeConfig -or (Get-GatewayRunValue $RunStateFile) -cne $beforeRun) { throw 'Codex settings changed before activation. The old gateway will be restored.' }
    Write-GatewayAtomicUtf8 $ConfigPath $newConfig
    $configChanged = $true
    $runCommand = if ($useScheduler) { $null } else { '"' + (Get-GatewayPowerShell) + '" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $InstallDirectory 'start.ps1') + '" -Directory "' + $InstallDirectory + '"' }
    if ($useScheduler -and $beforeRun -and -not (Test-GatewayOwnedRun $beforeRun $InstallDirectory)) { $runCommand = $beforeRun }
    Set-GatewayRunValue $runCommand $RunStateFile
    $runChanged = $true
    if (-not $SkipShortcuts) {
        foreach ($name in @('模型网关管理.lnk','恢复 GPT 直连.lnk','重新启用模型网关.lnk','紧急恢复 GPT.lnk','Codex model gateway.lnk','Restore original GPT.lnk')) {
            $shortcutPath = Join-Path $ShortcutDirectory $name
            $shortcutSnapshots[$shortcutPath] = if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) { [System.IO.File]::ReadAllBytes($shortcutPath) } else { $null }
        }
        $shortcutsTouched = $true
        New-GatewayShortcuts $InstallDirectory $ShortcutDirectory
    }
    Write-Output ('Gateway installed and healthy at ' + $InstallDirectory + '. Restart Codex to apply the connection settings.')
} catch {
    $failure = $_
    $rollbackFailures = New-Object System.Collections.Generic.List[string]
    if ($shortcutsTouched) {
        foreach ($shortcutPath in $shortcutSnapshots.Keys) {
            try {
                if ($null -ne $shortcutSnapshots[$shortcutPath]) { [System.IO.File]::WriteAllBytes($shortcutPath, $shortcutSnapshots[$shortcutPath]) }
                elseif (Test-Path -LiteralPath $shortcutPath -PathType Leaf) { Remove-Item -LiteralPath $shortcutPath -Force }
            } catch { $rollbackFailures.Add('A previous gateway shortcut could not be restored.') }
        }
    }
    if ($configChanged) {
        try {
            if ([System.IO.File]::ReadAllText($ConfigPath, [Text.Encoding]::UTF8) -ceq $newConfig) { Write-GatewayAtomicUtf8 $ConfigPath $beforeConfig }
            else { $rollbackFailures.Add('Codex settings changed after activation and were preserved.') }
        } catch { $rollbackFailures.Add('The previous Codex settings could not be restored.') }
    }
    if ($runChanged) {
        try { if ((Get-GatewayRunValue $RunStateFile) -ceq $runCommand) { Set-GatewayRunValue $beforeRun $RunStateFile } }
        catch { $rollbackFailures.Add('The previous sign-in startup setting could not be restored.') }
    }
    try {
        if ($swapped) {
            Stop-GatewayService $InstallDirectory
            if ($taskTouched) { Restore-GatewayScheduledTaskSnapshot $InstallDirectory $taskSnapshot | Out-Null }
            Move-Item -LiteralPath $InstallDirectory -Destination $failed
            if ($hadInstalledDirectory) { Move-Item -LiteralPath $rollback -Destination $InstallDirectory }
        } elseif (Test-Path -LiteralPath (Join-Path $staging 'private\settings.json')) { Stop-GatewayService $staging }
    } catch { $rollbackFailures.Add('The previous installation folder could not be restored.') }
    if ($oldStopped -and ($previousWasEnabled -or $previousWasRunning)) {
        try {
            # Old releases may have a start script that returns before health is ready, so use this verified starter.
            Start-GatewayService $PreviousDirectory 45
        } catch { $rollbackFailures.Add('The previous gateway did not recover its health check.') }
    }
    if ($oldStopped -and $separateInstalledWasRunning) {
        try { Start-GatewayService $InstallDirectory 45 }
        catch { $rollbackFailures.Add('The other previously installed gateway did not recover its health check.') }
    }
    if ($rollbackFailures.Count) { throw ('Deployment failed. ' + ($rollbackFailures -join ' ') + ' All installation and rollback folders were retained. Cause: ' + $failure.Exception.Message) }
    throw ('Deployment failed; the previous connection and service were preserved. All staging and rollback files were retained. Cause: ' + $failure.Exception.Message)
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
