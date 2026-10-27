[CmdletBinding(SupportsShouldProcess=$true)]
param([string]$BridgeDirectory)
$ErrorActionPreference='Stop'
if (-not $BridgeDirectory) { $BridgeDirectory=Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'CodexGeminiBridge' }
$source=Join-Path (Split-Path -Parent $PSScriptRoot) 'bridge'
# Only release-owned helpers are replaced. Configuration, OAuth data, binary,
# catalog snapshots and the original task definition are never copied or reset.
$helpers=@('runner.ps1','lifecycle.ps1','start.ps1','stop.ps1','status.ps1','initialize.cjs','login.cjs','model-catalog-sync.cjs','validate.cjs','register.cjs','enable-automatic-models.cjs')
foreach ($file in $helpers) {
    $path=Join-Path $source $file
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw ('The updated bridge helper is missing: '+$file) }
    if ($file.EndsWith('.ps1')) {
        $parseTokens=$null; $parseErrors=$null
        [Management.Automation.Language.Parser]::ParseFile($path,[ref]$parseTokens,[ref]$parseErrors) | Out-Null
        if (@($parseErrors).Count) { throw ('The updated bridge helper is invalid: '+$file) }
    }
}
. (Join-Path $BridgeDirectory 'lifecycle.ps1')
$identity=Get-GeminiBridgeIdentity $BridgeDirectory
$metadata=Get-Content -LiteralPath (Join-Path $identity.Root 'bridge.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($metadata.product -cne 'CodexGeminiBridge' -or [int]$metadata.port -lt 1024 -or [int]$metadata.port -gt 65535) { throw 'The installed bridge metadata is invalid.' }
if (-not $PSCmdlet.ShouldProcess($identity.Root,'Back up and upgrade the Antigravity bridge helpers, preserving account, credentials, binary, configuration and disabled state')) { return }
$mutex=New-Object Threading.Mutex($false,('Local\'+$identity.Name+'-Repair'))
$locked=$false
try {
    try { $locked=$mutex.WaitOne([TimeSpan]::FromSeconds(30)) } catch [Threading.AbandonedMutexException] { $locked=$true }
    if (-not $locked) { throw 'Another bridge upgrade is in progress.' }
    $state=Get-GeminiBridgeStatus $identity.Root ([int]$metadata.port)
    if (-not $state.TaskExists -or $state.ForeignListener -or (@($state.OwnedProcessIds).Count -gt 0 -and -not $state.TaskActive)) { throw 'The existing owned service could not be verified; no files were replaced.' }
    $private=Join-Path $identity.Root 'private'
    if ((Get-Item -LiteralPath $private).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The private directory is redirected; no files were replaced.' }
    $original=@{}
    foreach ($file in $helpers) {
        $target=Join-Path $identity.Root $file
        $original[$file]=Test-Path -LiteralPath $target -PathType Leaf
        if ((Test-Path -LiteralPath $target) -and ((Get-Item -LiteralPath $target).PSIsContainer -or ((Get-Item -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint))) { throw 'A bridge helper is redirected or is not a file; no files were replaced.' }
    }
    $backup=Join-Path $private ('helpers-before-repair-'+[Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $backup | Out-Null
    foreach ($file in $helpers) {
        if ($original[$file]) { Copy-Item -LiteralPath (Join-Path $identity.Root $file) -Destination (Join-Path $backup $file) }
    }
    [IO.File]::WriteAllText((Join-Path $backup 'manifest.json'),($original | ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
    $wasEnabled=[bool]$state.TaskEnabled
    try {
        Stop-GeminiBridge $identity.Root ([int]$metadata.port) | Out-Null
        foreach ($file in $helpers) { Copy-Item -LiteralPath (Join-Path $source $file) -Destination (Join-Path $identity.Root $file) -Force }
        if ($wasEnabled) { Start-GeminiBridge $identity.Root ([int]$metadata.port) 30 | Out-Null }
        Write-Output 'Antigravity bridge helpers upgraded. Existing account, credentials, binary and configuration were preserved.'
    } catch {
        $failure=$_
        # Stop any newly started child before restoring the complete helper set.
        try { Stop-GeminiBridge $identity.Root ([int]$metadata.port) | Out-Null } catch { }
        foreach ($file in $helpers) {
            $target=Join-Path $identity.Root $file
            if ($original[$file]) { Copy-Item -LiteralPath (Join-Path $backup $file) -Destination $target -Force }
            elseif (Test-Path -LiteralPath $target -PathType Leaf) { Remove-Item -LiteralPath $target -Force }
        }
        if ($wasEnabled) { try { Start-GeminiBridge $identity.Root ([int]$metadata.port) 30 | Out-Null } catch { } }
        throw $failure
    }
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
