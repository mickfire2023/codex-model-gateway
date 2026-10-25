[CmdletBinding()]
param([string]$Directory, [ValidateRange(0, 30)][int]$DelaySeconds = 2)
$ErrorActionPreference = 'Stop'
# WinPS 5.1 evaluates advanced-script parameter defaults before PSScriptRoot is
# populated. Resolve an omitted directory here, never against the caller's CWD.
if (-not $PSBoundParameters.ContainsKey('Directory')) { $Directory = $PSScriptRoot }
if ([string]::IsNullOrWhiteSpace($Directory) -or $Directory -match '[\x00-\x1F\x7F]' -or $Directory -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))') {
    throw 'The installation directory must be a non-empty absolute path without control characters.'
}
$Directory = [IO.Path]::GetFullPath($Directory).TrimEnd([char[]]'\/')
. (Join-Path $PSScriptRoot 'start.ps1') -Directory $Directory -LibraryOnly
# The management API starts this script asynchronously; allow its HTTP response to finish first.
if ($DelaySeconds) { Start-Sleep -Seconds $DelaySeconds }
$mutex = Get-GatewayMutex $Directory
$locked = $false
try {
    try { $locked = $mutex.WaitOne([TimeSpan]::FromSeconds(60)) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another gateway maintenance operation is in progress.' }
    Stop-GatewayService $Directory
    Start-GatewayService $Directory 45
    Write-Output 'Gateway restarted and its local health check passed.'
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
