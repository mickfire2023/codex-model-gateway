[CmdletBinding()]
param(
    [string]$Directory,
    [Parameter(Mandatory = $true)][ValidateSet('restart','restore')][string]$Action
)
$ErrorActionPreference = 'Stop'
# WinPS 5.1 evaluates advanced-script parameter defaults before PSScriptRoot is
# populated. Resolve an omitted directory here, never against the caller's CWD.
if (-not $PSBoundParameters.ContainsKey('Directory')) { $Directory = $PSScriptRoot }
if ([string]::IsNullOrWhiteSpace($Directory) -or $Directory -match '[\x00-\x1F\x7F]' -or $Directory -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))') {
    throw 'The installation directory must be a non-empty absolute path without control characters.'
}
$Directory = [IO.Path]::GetFullPath($Directory).TrimEnd([char[]]'\/')
$mutex = $null
$locked = $false
$child = $null
$statusPath = $null
$startedAt = [DateTime]::UtcNow.ToString('o')
$failureMessage = if ($Action -eq 'restore') { '恢复未完成。请使用紧急恢复入口，然后重启 Codex。' } else { '网关重启失败。请运行诊断，或使用紧急恢复入口。' }
try {
    . (Join-Path $PSScriptRoot 'start.ps1') -Directory $Directory -LibraryOnly
    $Directory = Get-GatewayFullPath $Directory
    $privateDirectory = Join-Path $Directory 'private'
    if (-not (Test-Path -LiteralPath $privateDirectory -PathType Container)) { throw 'Private directory unavailable.' }
    $statusPath = Join-Path $privateDirectory 'control-status.json'
    # A distinct lock permits the child restart/restore script to acquire lifecycle.
    $mutex = Get-GatewayMutex $Directory 'control'
    try { $locked = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) {
        [Console]::Error.WriteLine('已有网关维护操作正在运行，请等待完成。')
        exit 1
    }
    $runningMessage = if ($Action -eq 'restore') { '正在恢复原 GPT 连接。' } else { '正在重启本地网关。' }
    $status = [ordered]@{ action = $Action; state = 'running'; startedAt = $startedAt; finishedAt = $null; message = $runningMessage }
    Write-GatewayAtomicUtf8 $statusPath ($status | ConvertTo-Json -Compress)
    $target = Join-Path $Directory ($Action + '.ps1')
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw 'Maintenance script unavailable.' }
    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $target + '" -Directory "' + $Directory + '"'
    if ($Action -eq 'restart') { $arguments += ' -DelaySeconds 2' }
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = Get-GatewayPowerShell
    $info.Arguments = $arguments
    $info.WorkingDirectory = $Directory
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $child = New-Object System.Diagnostics.Process
    $child.StartInfo = $info
    if (-not $child.Start()) { throw 'Maintenance process unavailable.' }
    # Consume and discard both streams. Upstream exception text can contain secrets.
    $child.BeginOutputReadLine()
    $child.BeginErrorReadLine()
    if (-not $child.WaitForExit(180000)) {
        try { $child.Kill() } catch {}
        throw 'Maintenance process timed out.'
    }
    if ($child.ExitCode -ne 0) { throw 'Maintenance did not complete.' }
    $successMessage = if ($Action -eq 'restore') { '已恢复原 GPT 连接。请重启 Codex 后继续使用。密钥与聊天记录已保留。' } else { '网关已重启，本地健康检查已通过。' }
    $status.state = 'succeeded'
    $status.finishedAt = [DateTime]::UtcNow.ToString('o')
    $status.message = $successMessage
    Write-GatewayAtomicUtf8 $statusPath ($status | ConvertTo-Json -Compress)
    [Console]::Out.WriteLine($successMessage)
} catch {
    # Never serialize, log or echo the caught exception or child output.
    if ($locked -and $statusPath) {
        try {
            $failed = [ordered]@{ action = $Action; state = 'failed'; startedAt = $startedAt; finishedAt = [DateTime]::UtcNow.ToString('o'); message = $failureMessage }
            Write-GatewayAtomicUtf8 $statusPath ($failed | ConvertTo-Json -Compress)
        } catch {}
    }
    [Console]::Error.WriteLine($failureMessage)
    exit 1
} finally {
    if ($child) {
        try { $child.CancelOutputRead() } catch {}
        try { $child.CancelErrorRead() } catch {}
        $child.Dispose()
    }
    if ($locked) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
