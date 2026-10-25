[CmdletBinding()]
param([string]$BridgeDirectory,[string]$GatewayDirectory,[switch]$AcceptThirdPartyTerms)
$ErrorActionPreference='Stop'
if (-not $AcceptThirdPartyTerms) { throw 'Read docs/GEMINI.md and explicitly opt in with -AcceptThirdPartyTerms.' }
if (-not $BridgeDirectory) { $BridgeDirectory=Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'CodexGeminiBridge' }
if (-not $GatewayDirectory) { $GatewayDirectory=Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'CodexModelGateway' }
$node=Join-Path $GatewayDirectory 'runtime\node.exe'
if (-not (Test-Path -LiteralPath $node)) { throw 'Install the main gateway first.' }
. (Join-Path $GatewayDirectory 'start.ps1') -Directory $GatewayDirectory -LibraryOnly
$GatewayDirectory=Get-GatewayFullPath $GatewayDirectory
$settings=Get-GatewaySettings $GatewayDirectory
$providerFile=Join-Path $GatewayDirectory 'private\providers\providers.json'
if (Test-Path -LiteralPath $providerFile) {
    $providers=Get-Content -LiteralPath $providerFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if (@($providers.providers | Where-Object id -eq 'gemini-subscription').Count) { throw 'Gemini is already registered. Use the dashboard to refresh or pause discovery; setup will not replace existing model settings.' }
}
if (-not @(Get-ChildItem -LiteralPath (Join-Path $BridgeDirectory 'private\auth') -Filter '*.json' -File).Count) {
    & $node (Join-Path $BridgeDirectory 'login.cjs') $BridgeDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Google login did not complete. The gateway was not changed.' }
}
$scratch=Join-Path $BridgeDirectory 'private\validation-fixtures'
New-Item -ItemType Directory -Path $scratch -Force | Out-Null
# Validation uses synthetic prompts and non-executing mock tools, and consumes some subscription quota.
& $node (Join-Path $BridgeDirectory 'validate.cjs') $BridgeDirectory $GatewayDirectory $scratch
if ($LASTEXITCODE -ne 0) { throw 'Model compatibility validation failed. No provider was registered.' }
$mutex=Get-GatewayMutex $GatewayDirectory
$locked=$false
try {
    try { $locked=$mutex.WaitOne([TimeSpan]::FromSeconds(60)) } catch [Threading.AbandonedMutexException] { $locked=$true }
    if (-not $locked) { throw 'Another gateway maintenance operation is in progress.' }
    # Stop before editing the provider store; always restore the running service afterwards.
    Stop-GatewayService $GatewayDirectory
    try {
        & $node (Join-Path $BridgeDirectory 'register.cjs') $BridgeDirectory $GatewayDirectory
        if ($LASTEXITCODE -ne 0) { throw 'Provider registration failed.' }
        & $node (Join-Path $BridgeDirectory 'enable-automatic-models.cjs') $BridgeDirectory $GatewayDirectory
        if ($LASTEXITCODE -ne 0) { throw 'Models were registered, but automatic discovery could not be enabled. Check the dashboard before retrying setup.' }
    } finally { Start-GatewayService $GatewayDirectory 45 }
} finally { if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
Write-Output 'Gemini subscription models registered. Restart Codex to refresh its selector.'
