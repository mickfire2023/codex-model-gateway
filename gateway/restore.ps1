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
. (Join-Path $PSScriptRoot 'start.ps1') -Directory $Directory -LibraryOnly
$Directory = Get-GatewayFullPath $Directory
$settings = Get-GatewaySettings $Directory
$ConfigPath = Get-GatewayConfigPath $settings $ConfigPath
if (-not $RunStateFile -and $settings.lifecycle -and $settings.lifecycle.runStateFile) { $RunStateFile = [string]$settings.lifecycle.runStateFile }
$mutex = Get-GatewayMutex $Directory
$locked = $false
try {
    try { $locked = $mutex.WaitOne([TimeSpan]::FromSeconds(60)) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another gateway maintenance operation is in progress.' }
    $before = [System.IO.File]::ReadAllText($ConfigPath, [Text.Encoding]::UTF8)
    $current = $before
    $ownedBase = 'http://127.0.0.1:' + $settings.port + '/' + $settings.routeToken + '/backend-api/codex'
    $baseLine = Get-GatewayRootLine $current 'openai_base_url'
    $baseOwned = $baseLine -and (Get-GatewayTomlValue $baseLine) -ceq $ownedBase
    if ($baseOwned) { $current = Set-GatewayRootLine $current 'openai_base_url' $settings.previousBaseUrlLine }
    $catalogLine = Get-GatewayRootLine $current 'model_catalog_json'
    $catalogOwned = $false
    if ($catalogLine) {
        $catalogValue = Get-GatewayTomlValue $catalogLine
        $paths = @((Join-Path $Directory 'combined-models.json'))
        if ($settings.lifecycle -and $settings.lifecycle.ownedCatalogPaths) { $paths += @($settings.lifecycle.ownedCatalogPaths) }
        foreach ($path in $paths) { if (Test-GatewaySamePath $catalogValue $path) { $catalogOwned = $true; break } }
    }
    if ($catalogOwned -or ($baseOwned -and -not $catalogLine -and $settings.previousCatalogLine)) {
        $current = Set-GatewayRootLine $current 'model_catalog_json' $settings.previousCatalogLine
    }
    if ($current -cne $before) {
        if ([System.IO.File]::ReadAllText($ConfigPath, [Text.Encoding]::UTF8) -cne $before) { throw 'Codex settings changed during recovery. Run recovery again.' }
        # Restore direct access before stopping anything, so a failure leaves a usable Codex configuration.
        Write-GatewayAtomicUtf8 $ConfigPath $current
    }
    $runValue = Get-GatewayRunValue $RunStateFile
    if (Test-GatewayOwnedRun $runValue $Directory) { Set-GatewayRunValue $null $RunStateFile }
    if ($settings.lifecycle -and $settings.lifecycle.startupMode -eq 'scheduledTask') { Set-GatewayScheduledServiceEnabled $Directory $false }
    Stop-GatewayService $Directory
    $message = 'Original GPT connection restored. Restart Codex to apply. Saved keys and conversation history were kept.'
    Write-Output $message
    if ($ShowMessage) { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($message, 'Codex connection restored') | Out-Null }
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
