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
$managedLauncher = $null
try {
    $managedLauncher = Get-GatewayScheduledLauncherParent $Directory -RequireManagedLauncher:($settings.lifecycle -and $settings.lifecycle.startupMode -eq 'scheduledTask')
    try { $locked = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { return }
    Write-GatewayUtf8 (Join-Path $Directory 'private\runner.pid') ([string]$PID)
    while ((Test-Path -LiteralPath (Join-Path $Directory 'private\enabled')) -and (-not $managedLauncher -or -not $managedLauncher.HasExited)) {
        $stdoutFile = $null
        $stderrFile = $null
        try {
            # Suppress console allocation before Node starts. WindowStyle alone
            # can still allocate a console through Windows' default terminal.
            $info = New-Object Diagnostics.ProcessStartInfo
            $info.FileName = $settings.nodePath
            $info.Arguments = '"' + (Join-Path $Directory 'gateway.cjs') + '"'
            $info.WorkingDirectory = $Directory
            $info.UseShellExecute = $false
            $info.CreateNoWindow = $true
            $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
            $info.RedirectStandardOutput = $true
            $info.RedirectStandardError = $true
            $stdoutFile = New-Object IO.FileStream((Join-Path $Directory 'runtime.stdout.log'),[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite)
            $stderrFile = New-Object IO.FileStream((Join-Path $Directory 'runtime.stderr.log'),[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite)
            $child = New-Object Diagnostics.Process
            $child.StartInfo = $info
            if (-not $child.Start()) { throw 'The gateway process did not start.' }
            # Drain both pipes concurrently so diagnostic output cannot block
            # the model service. Keep the existing readable log file paths.
            $stdout = $child.StandardOutput.BaseStream.CopyToAsync($stdoutFile)
            $stderr = $child.StandardError.BaseStream.CopyToAsync($stderrFile)
            Write-GatewayUtf8 (Join-Path $Directory 'private\gateway.pid') ([string]$child.Id)
            while (-not $child.WaitForExit(500)) {
                if ($managedLauncher -and $managedLauncher.HasExited) {
                    $child.Kill()
                    $child.WaitForExit()
                    break
                }
            }
            $stdout.GetAwaiter().GetResult() | Out-Null
            $stderr.GetAwaiter().GetResult() | Out-Null
        } catch {
            if ($child) { try { if (-not $child.HasExited) { $child.Kill(); $child.WaitForExit() } } catch { } }
            [System.IO.File]::AppendAllText((Join-Path $Directory 'gateway.log'), ('{"event":"runner_restart","time":"' + [DateTime]::UtcNow.ToString('o') + '"}' + [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))
        } finally {
            if ($stdoutFile) { $stdoutFile.Dispose() }
            if ($stderrFile) { $stderrFile.Dispose() }
            if ($child) { $child.Dispose() }
        }
        $child = $null
        for ($delay = 0; $delay -lt 10 -and (Test-Path -LiteralPath (Join-Path $Directory 'private\enabled')) -and (-not $managedLauncher -or -not $managedLauncher.HasExited); $delay++) { Start-Sleep -Milliseconds 500 }
    }
} finally {
    if ($locked) {
        $pidFile = Join-Path $Directory 'private\runner.pid'
        if ((Test-Path -LiteralPath $pidFile) -and ((Get-Content -LiteralPath $pidFile -Raw -Encoding UTF8).Trim() -eq [string]$PID)) { Remove-Item -LiteralPath $pidFile -Force }
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
    if ($managedLauncher) { $managedLauncher.Dispose() }
}
