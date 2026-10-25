[CmdletBinding()]
param([string]$Directory,[ValidateRange(1024,65535)][int]$Port=8317)
$ErrorActionPreference='Stop'
if (-not $PSBoundParameters.ContainsKey('Directory')) { $Directory=$PSScriptRoot }
. (Join-Path $PSScriptRoot 'lifecycle.ps1')
Get-GeminiBridgeStatus $Directory $Port | ConvertTo-Json -Depth 3 -Compress
