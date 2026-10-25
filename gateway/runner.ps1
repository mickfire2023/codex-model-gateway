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
$Directory = Get-GatewayFullPath $Directory
$settings = Get-GatewaySettings $Directory
$mutex = Get-GatewayMutex $Directory 'runner'
$locked = $false
$child = $null
try {
    try { $locked = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { return }
    Write-GatewayUtf8 (Join-Path $Directory 'private\runner.pid') ([string]$PID)
    while (Test-Path -LiteralPath (Join-Path $Directory 'private\enabled')) {
        try {
            $child = Start-Process -FilePath $settings.nodePath -ArgumentList ('"' + (Join-Path $Directory 'gateway.cjs') + '"') -WorkingDirectory $Directory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $Directory 'runtime.stdout.log') -RedirectStandardError (Join-Path $Directory 'runtime.stderr.log')
            Write-GatewayUtf8 (Join-Path $Directory 'private\gateway.pid') ([string]$child.Id)
            $child.WaitForExit()
        } catch {
            [System.IO.File]::AppendAllText((Join-Path $Directory 'gateway.log'), ('{"event":"runner_restart","time":"' + [DateTime]::UtcNow.ToString('o') + '"}' + [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))
        }
        $child = $null
        for ($delay = 0; $delay -lt 10 -and (Test-Path -LiteralPath (Join-Path $Directory 'private\enabled')); $delay++) { Start-Sleep -Milliseconds 500 }
    }
} finally {
    if ($locked) {
        $pidFile = Join-Path $Directory 'private\runner.pid'
        if ((Test-Path -LiteralPath $pidFile) -and ((Get-Content -LiteralPath $pidFile -Raw -Encoding UTF8).Trim() -eq [string]$PID)) { Remove-Item -LiteralPath $pidFile -Force }
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}
