[CmdletBinding(SupportsShouldProcess=$true)]
param(
    [string]$InstallDirectory,
    [string]$ConfigPath,
    [ValidateRange(1024,65535)][int]$Port=2156,
    [string]$NodePath,
    [switch]$SkipShortcuts,
    [switch]$KeepDirectConnection
)
$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot 'gateway'
. (Join-Path $source 'start.ps1') -Directory $source -LibraryOnly
if (-not $InstallDirectory) { $InstallDirectory=Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'CodexModelGateway' }
if (-not $ConfigPath) {
    $codexRoot=if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
    $ConfigPath=Join-Path $codexRoot 'config.toml'
}
$InstallDirectory=Get-GatewayFullPath $InstallDirectory
$ConfigPath=Get-GatewayFullPath $ConfigPath
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw 'Open Codex and save its settings first, or pass -ConfigPath to an existing config.toml.' }
if (Test-Path -LiteralPath (Join-Path $InstallDirectory 'private\settings.json')) {
    if ($PSCmdlet.ShouldProcess($InstallDirectory,'Upgrade the gateway, preserving credentials and model settings')) {
        & (Join-Path $source 'deploy.ps1') -SourceDirectory $source -PreviousDirectory $InstallDirectory -InstallDirectory $InstallDirectory -ConfigPath $ConfigPath -SkipShortcuts:$SkipShortcuts -KeepDirectConnection:$KeepDirectConnection
    }
    return
}
if ((Test-Path -LiteralPath $InstallDirectory) -and @(Get-ChildItem -LiteralPath $InstallDirectory -Force).Count) { throw 'Choose an empty dedicated installation directory. Existing files were preserved.' }
if (-not $NodePath) { $NodePath=(Get-Command node.exe -ErrorAction Stop).Source }
$NodePath=Get-GatewayFullPath $NodePath
$version=& $NodePath --version
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) { throw 'Node.js 24 or newer is required. Install it from nodejs.org, then run npm ci in this repository.' }
$ws=Join-Path $PSScriptRoot 'node_modules\ws'
if (-not (Test-Path -LiteralPath (Join-Path $ws 'package.json'))) { throw 'Run npm ci in this repository before installing.' }
$before=[IO.File]::ReadAllText($ConfigPath,[Text.Encoding]::UTF8)
if ((Get-GatewayRootLine $before 'openai_base_url') -or (Get-GatewayRootLine $before 'model_catalog_json')) { throw 'A custom Codex connection or catalog is already configured. Restore the native connection before the first installation; this installer will not replace another gateway.' }
$provider=Get-GatewayTomlValue (Get-GatewayRootLine $before 'model_provider')
if ($provider -and $provider -ne 'openai') { throw 'The first installation requires the native OpenAI provider. Existing provider settings were preserved.' }
if (@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count) { throw 'The selected port is already in use. Choose another -Port.' }
if (-not $PSCmdlet.ShouldProcess($InstallDirectory,'Install a local gateway, validate its service, and connect Codex')) { return }
$parent=Split-Path -Parent $InstallDirectory
if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'The installation parent directory must already exist.' }
$bootstrap=Join-Path $parent ('gateway-bootstrap-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $bootstrap | Out-Null
# Protect the bootstrap before writing configuration backups or local state.
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false); $acl.SetOwner($sid)
$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$acl.AddAccessRule($rule); Set-Acl -LiteralPath $bootstrap -AclObject $acl
New-Item -ItemType Directory -Path (Join-Path $bootstrap 'private') | Out-Null
$rng=[Security.Cryptography.RandomNumberGenerator]::Create()
try { $bytes=New-Object byte[] 32; $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$token=[BitConverter]::ToString($bytes).Replace('-','').ToLowerInvariant()
$settings=[ordered]@{
    port=$Port; routeToken=$token; directory=$bootstrap; nodePath=$NodePath
    codexDirectory=(Split-Path -Parent $ConfigPath); catalogSyncEnabled=$true; catalogRefreshIntervalMs=1800000
    previousBaseUrlLine=$null; previousCatalogLine=$null
    lifecycle=@{startupMode='process';configPath=$ConfigPath}
}
Write-GatewayUtf8 (Join-Path $bootstrap 'private\settings.json') ($settings | ConvertTo-Json -Depth 10)
foreach ($name in @('openai-models.json','deepseek-models.json')) { Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $bootstrap $name) }
$cache=Join-Path (Split-Path -Parent $ConfigPath) 'models_cache.json'
if (Test-Path -LiteralPath $cache) {
    try {
        $cached=Get-Content -LiteralPath $cache -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($cached.models -is [Array] -and $cached.models.Count -gt 0 -and @($cached.models | Where-Object { -not $_.slug }).Count -eq 0) {
            Write-GatewayUtf8 (Join-Path $bootstrap 'openai-models.json') (@{models=$cached.models} | ConvertTo-Json -Depth 80)
        }
    } catch { Write-Verbose 'The optional Codex model cache was not imported.' }
}
New-Item -ItemType Directory -Path (Join-Path $bootstrap 'node_modules') | Out-Null
Copy-Item -LiteralPath $ws -Destination (Join-Path $bootstrap 'node_modules\ws') -Recurse
if ([IO.File]::ReadAllText($ConfigPath,[Text.Encoding]::UTF8) -cne $before) { throw 'Codex settings changed during preparation; installation stopped without changing the connection.' }
& (Join-Path $source 'deploy.ps1') -SourceDirectory $source -PreviousDirectory $bootstrap -InstallDirectory $InstallDirectory -ConfigPath $ConfigPath -SkipShortcuts:$SkipShortcuts -KeepDirectConnection:$KeepDirectConnection
# Retain the protected preparation folder for recovery; no recursive deletion is needed.
Write-Output 'Installation complete. Restart Codex, then open the desktop model gateway shortcut to add API providers.'
