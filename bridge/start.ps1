[CmdletBinding()]
param([string]$Directory,[ValidateRange(1024,65535)][int]$Port=8317,[ValidateRange(1,120)][int]$WaitSeconds=20)
$ErrorActionPreference='Stop'
if (-not $PSBoundParameters.ContainsKey('Directory')) { $Directory=$PSScriptRoot }
. (Join-Path $PSScriptRoot 'lifecycle.ps1')
Start-GeminiBridge $Directory $Port $WaitSeconds | ConvertTo-Json -Depth 3 -Compress
