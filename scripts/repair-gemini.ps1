[CmdletBinding(SupportsShouldProcess=$true)]
param([string]$BridgeDirectory)
$ErrorActionPreference='Stop'
if (-not $BridgeDirectory) { $BridgeDirectory=Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'CodexGeminiBridge' }
$source=Join-Path (Split-Path -Parent $PSScriptRoot) 'bridge\runner.ps1'
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'The updated bridge runner is missing.' }
. (Join-Path $BridgeDirectory 'lifecycle.ps1')
$identity=Get-GeminiBridgeIdentity $BridgeDirectory
$metadata=Get-Content -LiteralPath (Join-Path $identity.Root 'bridge.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($metadata.product -cne 'CodexGeminiBridge' -or [int]$metadata.port -lt 1024 -or [int]$metadata.port -gt 65535) { throw 'The installed bridge metadata is invalid.' }
$state=Get-GeminiBridgeStatus $identity.Root ([int]$metadata.port)
if (-not $state.TaskExists -or $state.ForeignListener -or (@($state.OwnedProcessIds).Count -gt 0 -and -not $state.TaskActive)) { throw 'The existing owned service could not be verified; no files were replaced.' }
if (-not $PSCmdlet.ShouldProcess($identity.Root,'Back up and repair the bridge supervisor, preserving account, credentials, model configuration and disabled state')) { return }
$backup=Join-Path $identity.Root ('private\runner-before-repair-'+[Guid]::NewGuid().ToString('N')+'.ps1')
$target=Join-Path $identity.Root 'runner.ps1'
Copy-Item -LiteralPath $target -Destination $backup
$wasEnabled=[bool]$state.TaskEnabled
try {
    Stop-GeminiBridge $identity.Root ([int]$metadata.port) | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Force
    if ($wasEnabled) { Start-GeminiBridge $identity.Root ([int]$metadata.port) 30 | Out-Null }
    Write-Output 'Gemini supervisor repaired. Existing account and credentials were preserved.'
} catch {
    $failure=$_
    Copy-Item -LiteralPath $backup -Destination $target -Force
    if ($wasEnabled) { try { Start-GeminiBridge $identity.Root ([int]$metadata.port) 30 | Out-Null } catch {} }
    throw $failure
}
