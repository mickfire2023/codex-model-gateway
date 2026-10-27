[CmdletBinding(SupportsShouldProcess=$true)]
param([string]$BridgeDirectory,[string]$BinaryPath)
$ErrorActionPreference='Stop'
if (-not $BridgeDirectory) { $BridgeDirectory=Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'CodexGeminiBridge' }
$source=Join-Path (Split-Path -Parent $PSScriptRoot) 'bridge'
# Only release-owned helpers are replaced. An explicitly supplied, pinned
# executable may also be upgraded; account and configuration remain untouched.
$helpers=@('runner.ps1','lifecycle.ps1','start.ps1','stop.ps1','status.ps1','task-launcher.vbs','binary-manifest.json','initialize.cjs','login.cjs','model-catalog-sync.cjs','validate.cjs','register.cjs','enable-automatic-models.cjs')
foreach ($file in $helpers) {
    $path=Join-Path $source $file
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw ('The updated bridge helper is missing: '+$file) }
    if ($file.EndsWith('.ps1')) {
        $parseTokens=$null; $parseErrors=$null
        [Management.Automation.Language.Parser]::ParseFile($path,[ref]$parseTokens,[ref]$parseErrors) | Out-Null
        if (@($parseErrors).Count) { throw ('The updated bridge helper is invalid: '+$file) }
    }
}
. (Join-Path $source 'lifecycle.ps1')
$identity=Get-GeminiBridgeIdentity $BridgeDirectory
$metadata=Get-Content -LiteralPath (Join-Path $identity.Root 'bridge.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($metadata.product -cne 'CodexGeminiBridge' -or [int]$metadata.port -lt 1024 -or [int]$metadata.port -gt 65535) { throw 'The installed bridge metadata is invalid.' }
$binaryEntry=$null
if ($BinaryPath) {
    $BinaryPath=[IO.Path]::GetFullPath($BinaryPath)
    if (-not (Test-Path -LiteralPath $BinaryPath -PathType Leaf) -or ((Get-Item -LiteralPath $BinaryPath).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'The supplied binary is missing or redirected.' }
    $binaryManifest=Get-Content -LiteralPath (Join-Path $source 'binary-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $digest=(Get-FileHash -LiteralPath $BinaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $known=@($binaryManifest.official,$binaryManifest.patched) | Where-Object { $_.sha256 -cmatch '^[a-f0-9]{64}$' -and $_.sha256 -ceq $digest }
    if (@($known).Count -ne 1) { throw 'The supplied binary does not match a reviewed release digest.' }
    $binaryEntry=@($known)[0]
}
if (-not $PSCmdlet.ShouldProcess($identity.Root,'Back up and upgrade the Antigravity bridge helpers, preserving account, credentials, binary, configuration and disabled state')) { return }
$mutex=New-Object Threading.Mutex($false,('Local\'+$identity.Name+'-Repair'))
$locked=$false
function Copy-BridgeUpgradeAsset([string]$From,[string]$To) {
    $target=[IO.Path]::GetFullPath($To)
    if (-not $target.StartsWith($identity.Root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'The upgrade asset target is outside the owned bridge.' }
    $temporary=$target+'.upgrade-'+[Guid]::NewGuid().ToString('N')+'.tmp'
    try {
        [IO.File]::Copy($From,$temporary,$false)
        $stream=[IO.File]::Open($temporary,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read)
        try { $stream.Flush($true) } finally { $stream.Dispose() }
        if ([IO.File]::Exists($target)) { [IO.File]::Replace($temporary,$target,[Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary,$target) }
    } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}
try {
    try { $locked=$mutex.WaitOne([TimeSpan]::FromSeconds(30)) } catch [Threading.AbandonedMutexException] { $locked=$true }
    if (-not $locked) { throw 'Another bridge upgrade is in progress.' }
    $state=Get-GeminiBridgeStatus $identity.Root ([int]$metadata.port)
    if (-not $state.TaskExists -or $state.ForeignListener -or (@($state.OwnedProcessIds).Count -gt 0 -and -not $state.TaskActive)) { throw 'The existing owned service could not be verified; no files were replaced.' }
    $taskBefore=Get-GeminiBridgeTaskSnapshot $identity.Root
    $private=Join-Path $identity.Root 'private'
    if ((Get-Item -LiteralPath $private).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The private directory is redirected; no files were replaced.' }
    $original=@{}
    foreach ($file in $helpers) {
        $target=Join-Path $identity.Root $file
        $original[$file]=Test-Path -LiteralPath $target -PathType Leaf
        if ((Test-Path -LiteralPath $target) -and ((Get-Item -LiteralPath $target).PSIsContainer -or ((Get-Item -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint))) { throw 'A bridge helper is redirected or is not a file; no files were replaced.' }
    }
    foreach ($file in @('bridge.json','cli-proxy-api.exe')) {
        $target=Join-Path $identity.Root $file
        if (-not (Test-Path -LiteralPath $target -PathType Leaf) -or ((Get-Item -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'An installed bridge asset is missing or redirected; no files were replaced.' }
    }
    $backup=Join-Path $private ('helpers-before-repair-'+[Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $backup | Out-Null
    foreach ($file in $helpers) {
        if ($original[$file]) { Copy-Item -LiteralPath (Join-Path $identity.Root $file) -Destination (Join-Path $backup $file) }
    }
    [IO.File]::WriteAllText((Join-Path $backup 'manifest.json'),($original | ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
    [IO.File]::WriteAllText((Join-Path $backup 'task-before.json'),($taskBefore | ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
    Copy-Item -LiteralPath (Join-Path $identity.Root 'bridge.json') -Destination (Join-Path $backup 'bridge.json')
    if ($binaryEntry) { Copy-Item -LiteralPath (Join-Path $identity.Root 'cli-proxy-api.exe') -Destination (Join-Path $backup 'cli-proxy-api.exe') }
    $wasEnabled=[bool]$state.TaskEnabled
    try {
        Stop-GeminiBridge $identity.Root ([int]$metadata.port) | Out-Null
        foreach ($file in $helpers) { Copy-BridgeUpgradeAsset (Join-Path $source $file) (Join-Path $identity.Root $file) }
        if ($binaryEntry) {
            Copy-BridgeUpgradeAsset $BinaryPath (Join-Path $identity.Root 'cli-proxy-api.exe')
            if ((Get-FileHash -LiteralPath (Join-Path $identity.Root 'cli-proxy-api.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -cne $binaryEntry.sha256) { throw 'The installed bridge binary failed integrity verification.' }
            $metadata | Add-Member -NotePropertyName release -NotePropertyValue $binaryEntry.release -Force
            $metadata | Add-Member -NotePropertyName binarySha256 -NotePropertyValue $binaryEntry.sha256 -Force
            $channels=if ($binaryEntry.claudeQ19) { @(18,19) } else { @(18) }
            $metadata | Add-Member -NotePropertyName claudeSignatureChannels -NotePropertyValue $channels -Force
            $nextMetadata=Join-Path $backup 'bridge.after.json'
            [IO.File]::WriteAllText($nextMetadata,($metadata | ConvertTo-Json -Depth 10),(New-Object Text.UTF8Encoding($false)))
            Copy-BridgeUpgradeAsset $nextMetadata (Join-Path $identity.Root 'bridge.json')
        }
        Update-GeminiBridgeTaskLauncher $identity.Root | Out-Null
        if ($wasEnabled) { Start-GeminiBridge $identity.Root ([int]$metadata.port) 30 | Out-Null }
        Write-Output 'Antigravity bridge upgraded. Existing account, credentials, configuration and disabled state were preserved.'
    } catch {
        $failure=$_
        # Stop any newly started child before restoring the complete helper set.
        try { Stop-GeminiBridge $identity.Root ([int]$metadata.port) | Out-Null } catch { }
        foreach ($file in $helpers) {
            $target=Join-Path $identity.Root $file
            if ($original[$file]) { Copy-BridgeUpgradeAsset (Join-Path $backup $file) $target }
            elseif (Test-Path -LiteralPath $target -PathType Leaf) { Remove-Item -LiteralPath $target -Force }
        }
        Copy-BridgeUpgradeAsset (Join-Path $backup 'bridge.json') (Join-Path $identity.Root 'bridge.json')
        if ($binaryEntry) { Copy-BridgeUpgradeAsset (Join-Path $backup 'cli-proxy-api.exe') (Join-Path $identity.Root 'cli-proxy-api.exe') }
        Restore-GeminiBridgeTaskSnapshot $identity.Root $taskBefore | Out-Null
        if ($wasEnabled) { try { Start-GeminiBridge $identity.Root ([int]$metadata.port) 30 | Out-Null } catch { } }
        throw $failure
    }
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
