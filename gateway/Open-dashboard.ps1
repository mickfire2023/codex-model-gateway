[CmdletBinding()]
param([string]$Directory)
$ErrorActionPreference = 'Stop'
# WinPS 5.1 evaluates advanced-script parameter defaults before PSScriptRoot is
# populated. Resolve an omitted directory here, never against the caller's CWD.
if (-not $PSBoundParameters.ContainsKey('Directory')) { $Directory = $PSScriptRoot }
if ([string]::IsNullOrWhiteSpace($Directory) -or $Directory -match '[\x00-\x1F\x7F]' -or $Directory -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))') {
    throw 'The installation directory must be a non-empty absolute path without control characters.'
}
$Directory = [IO.Path]::GetFullPath($Directory).TrimEnd([char[]]'\/')
. (Join-Path $PSScriptRoot 'start.ps1') -Directory $Directory -LibraryOnly
try {
    Start-GatewayService $Directory 45
    $settings = Get-GatewaySettings $Directory
    Start-Process -FilePath ('http://127.0.0.1:' + $settings.port + '/' + $settings.routeToken + '/') -WindowStyle Hidden | Out-Null
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show('The gateway could not start. Use the Restore original GPT shortcut to recover the direct connection, then restart Codex.', 'Codex gateway') | Out-Null
    throw
}
