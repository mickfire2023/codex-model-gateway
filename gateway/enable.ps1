[CmdletBinding()]
param([string]$Directory, [string]$ConfigPath, [string]$RunStateFile, [switch]$ShowMessage)
$ErrorActionPreference = 'Stop'
# WinPS 5.1 evaluates advanced-script parameter defaults before PSScriptRoot is
# populated. Resolve an omitted directory here, never against the caller's CWD.
if (-not $PSBoundParameters.ContainsKey('Directory')) { $Directory = $PSScriptRoot }
if ([string]::IsNullOrWhiteSpace($Directory) -or $Directory -match '[\x00-\x1F\x7F]' -or $Directory -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))') {
    throw 'The installation directory must be a non-empty absolute path without control characters.'
}
$Directory = [IO.Path]::GetFullPath($Directory).TrimEnd([char[]]'\/')
$mutex = $null
$locked = $false
$beforeConfig = $null
$beforeRun = $null
$nextConfig = $null
$runCommand = $null
$configChanged = $false
$runChanged = $false
$taskSnapshot = $null
$schedulerStarted = $false
$publicMessage = '模型网关未能重新启用。现有设置已保留，请运行诊断或使用紧急恢复入口。'
try {
    . (Join-Path $PSScriptRoot 'start.ps1') -Directory $Directory -LibraryOnly
    $Directory = Get-GatewayFullPath $Directory
    $settings = Get-GatewaySettings $Directory
    $ConfigPath = Get-GatewayConfigPath $settings $ConfigPath
    if (-not $RunStateFile -and $settings.lifecycle -and $settings.lifecycle.runStateFile) { $RunStateFile = [string]$settings.lifecycle.runStateFile }
    $mutex = Get-GatewayMutex $Directory
    try { $locked = $mutex.WaitOne([TimeSpan]::FromSeconds(60)) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { $publicMessage = '已有网关维护操作正在运行，请等待完成后再启用。'; throw 'Maintenance busy.' }
    $beforeConfig = [System.IO.File]::ReadAllText($ConfigPath, [Text.Encoding]::UTF8)
    $beforeRun = Get-GatewayRunValue $RunStateFile
    $baseLine = Get-GatewayRootLine $beforeConfig 'openai_base_url'
    $baseValue = Get-GatewayTomlValue $baseLine
    $originalBase = Get-GatewayTomlValue ([string]$settings.previousBaseUrlLine)
    $ownedBase = 'http://127.0.0.1:' + $settings.port + '/' + $settings.routeToken + '/backend-api/codex'
    $baseAllowed = ($baseLine -and $baseValue -ceq $ownedBase) -or ($baseLine -and $settings.previousBaseUrlLine -and $baseValue -ceq $originalBase) -or (-not $baseLine -and -not $settings.previousBaseUrlLine)
    if (-not $baseAllowed) { $publicMessage = 'Codex 连接已被其他设置更改，未覆盖。请检查设置后再重新启用。'; throw 'Connection changed.' }
    if ($beforeRun -and -not (Test-GatewayOwnedRun $beforeRun $Directory)) { $publicMessage = '自动启动设置已被其他程序更改，未覆盖。请检查设置后再重新启用。'; throw 'Startup changed.' }
    $nextConfig = Set-GatewayRootLine $beforeConfig 'openai_base_url' ('openai_base_url = ' + (ConvertTo-GatewayToml $ownedBase))
    $catalogLine = Get-GatewayRootLine $beforeConfig 'model_catalog_json'
    $catalogValue = Get-GatewayTomlValue $catalogLine
    $catalogPaths = @((Join-Path $Directory 'combined-models.json'))
    if ($settings.lifecycle -and $settings.lifecycle.ownedCatalogPaths) { $catalogPaths += @($settings.lifecycle.ownedCatalogPaths) }
    $catalogOwned = $false
    if ($catalogLine) { foreach ($path in $catalogPaths) { if (Test-GatewaySamePath $catalogValue $path) { $catalogOwned = $true; break } } }
    if ($settings.catalogSyncEnabled) {
        # External and restored original catalogs belong to the user, including future values.
        if ($catalogOwned) { $nextConfig = Set-GatewayRootLine $nextConfig 'model_catalog_json' $null }
    } else {
        $originalCatalog = Get-GatewayTomlValue ([string]$settings.previousCatalogLine)
        $originalCatalogOwned = $catalogLine -and $settings.previousCatalogLine -and (Test-GatewaySamePath $catalogValue $originalCatalog)
        if ($catalogLine -and -not $catalogOwned -and -not $originalCatalogOwned) { $publicMessage = '模型目录已被其他设置更改，未覆盖。请检查设置后再重新启用。'; throw 'Catalog changed.' }
        $nextConfig = Set-GatewayRootLine $nextConfig 'model_catalog_json' ('model_catalog_json = ' + (ConvertTo-GatewayToml (Join-Path $Directory 'combined-models.json')))
    }
    if ($settings.lifecycle -and $settings.lifecycle.startupMode -eq 'scheduledTask') { $taskSnapshot = Get-GatewayScheduledTaskSnapshot $Directory; $schedulerStarted = $true }
    Start-GatewayService $Directory 45
    if ([System.IO.File]::ReadAllText($ConfigPath, [Text.Encoding]::UTF8) -cne $beforeConfig -or (Get-GatewayRunValue $RunStateFile) -cne $beforeRun) {
        $publicMessage = 'Codex 设置在启用过程中发生变化，已保留新设置。请稍后重试。'
        throw 'Settings changed during validation.'
    }
    # Do not change any connection or login startup setting until the service is healthy.
    Write-GatewayAtomicUtf8 $ConfigPath $nextConfig
    $configChanged = $true
    $runCommand = if ($settings.lifecycle -and $settings.lifecycle.startupMode -eq 'scheduledTask') { $null } else { '"' + (Get-GatewayPowerShell) + '" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $Directory 'start.ps1') + '" -Directory "' + $Directory + '"' }
    Set-GatewayRunValue $runCommand $RunStateFile
    $runChanged = $true
    $message = '模型网关已重新启用，健康检查已通过。请重启 Codex 后选择模型。'
    [Console]::Out.WriteLine($message)
    if ($ShowMessage) { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($message, '模型网关已启用') | Out-Null }
} catch {
    $rollbackFailed = $false
    if ($schedulerStarted) {
        try {
            Stop-GatewayService $Directory
            Restore-GatewayScheduledTaskSnapshot $Directory $taskSnapshot
            if ($taskSnapshot.Exists -and ([xml]$taskSnapshot.Xml).Task.Settings.Enabled -ne 'false') { Start-GatewayService $Directory 45 }
        } catch { $rollbackFailed = $true }
    }
    if ($runChanged) {
        try { if ((Get-GatewayRunValue $RunStateFile) -ceq $runCommand) { Set-GatewayRunValue $beforeRun $RunStateFile } }
        catch { $rollbackFailed = $true }
    }
    if ($configChanged) {
        try { if ([System.IO.File]::ReadAllText($ConfigPath, [Text.Encoding]::UTF8) -ceq $nextConfig) { Write-GatewayAtomicUtf8 $ConfigPath $beforeConfig } }
        catch { $rollbackFailed = $true }
    }
    if ($rollbackFailed) { $publicMessage = '启用未完成，部分设置无法自动恢复。请使用恢复 GPT 直连入口，然后重启 Codex。' }
    if ($ShowMessage) { try { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($publicMessage, '模型网关未启用') | Out-Null } catch {} }
    throw $publicMessage
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
