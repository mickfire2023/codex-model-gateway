[CmdletBinding()]
param([string]$Directory,[ValidateRange(1024,65535)][int]$Port=8317,[switch]$RemoveTask)
$ErrorActionPreference='Stop'
if (-not $PSBoundParameters.ContainsKey('Directory')) { $Directory=$PSScriptRoot }
. (Join-Path $PSScriptRoot 'lifecycle.ps1')
Stop-GeminiBridge $Directory $Port -RemoveTask:$RemoveTask | ConvertTo-Json -Depth 3 -Compress
