[CmdletBinding(SupportsShouldProcess=$true)]
param([string]$BuildDirectory,[string]$SourceArchivePath,[string]$GoArchivePath)
$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
$manifestPath=Join-Path $project 'bridge\binary-manifest.json'
$manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.version -ne 1 -or $manifest.product -cne 'CLIProxyAPI') { throw 'The pinned build manifest is invalid.' }
$patch=Join-Path $project 'vendor-patches\cliproxyapi-8.0.43-q19.patch'
function Assert-BuildHash([string]$File,[string]$Expected) {
    if ($Expected -cnotmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Expected) { throw 'A pinned build input or output hash does not match. No unverified binary was executed.' }
}
Assert-BuildHash $patch ([string]$manifest.source.patchSha256)
if (-not $BuildDirectory) { $BuildDirectory=Join-Path ([IO.Path]::GetTempPath()) ('codex-antigravity-build-'+[Guid]::NewGuid().ToString('N')) }
$BuildDirectory=[IO.Path]::GetFullPath($BuildDirectory).TrimEnd([char[]]'\/')
if ($BuildDirectory -notmatch '^[A-Za-z]:[\\/]' -or $BuildDirectory.Length -le 3 -or (Test-Path -LiteralPath $BuildDirectory)) { throw 'Choose a new dedicated absolute local build directory.' }
$git=(Get-Command git.exe -ErrorAction Stop).Source
if (-not $PSCmdlet.ShouldProcess($BuildDirectory,'Download pinned official Go/source archives, verify them, apply the published Q19 patch, test and build a reproducible local executable')) { return }
New-Item -ItemType Directory -Path $BuildDirectory | Out-Null
function Get-BuildArchive([string]$Existing,[string]$Url,[string]$Name,[string]$Sha256) {
    if ($Existing) { $file=[IO.Path]::GetFullPath($Existing) }
    else {
        $file=Join-Path $BuildDirectory $Name
        Invoke-WebRequest -Uri $Url -OutFile $file -UseBasicParsing
    }
    Assert-BuildHash $file $Sha256
    return $file
}
$sourceZip=Get-BuildArchive $SourceArchivePath ([string]$manifest.source.archiveUrl) 'source.zip' ([string]$manifest.source.archiveSha256)
$goZip=Get-BuildArchive $GoArchivePath ([string]$manifest.toolchain.archiveUrl) 'go.zip' ([string]$manifest.toolchain.archiveSha256)
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Expand-BuildArchive([string]$Zip,[string]$Destination) {
    $archive=[IO.Compression.ZipFile]::OpenRead($Zip)
    try {
        $prefix=[IO.Path]::GetFullPath($Destination).TrimEnd([char[]]'\/')+[IO.Path]::DirectorySeparatorChar
        foreach ($entry in $archive.Entries) {
            $target=[IO.Path]::GetFullPath((Join-Path $Destination $entry.FullName))
            if (-not $target.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'An archive entry escapes the dedicated build directory.' }
        }
    } finally { $archive.Dispose() }
    [IO.Compression.ZipFile]::ExtractToDirectory($Zip,$Destination)
}
Expand-BuildArchive $sourceZip (Join-Path $BuildDirectory 'source')
Expand-BuildArchive $goZip (Join-Path $BuildDirectory 'toolchain')
$source=Join-Path $BuildDirectory 'source\CLIProxyAPI-8.0.43'
$go=Join-Path $BuildDirectory 'toolchain\go\bin\go.exe'
& $git -C $source apply --check --whitespace=error-all $patch
if ($LASTEXITCODE -ne 0) { throw 'The pinned source does not accept the exact published patch.' }
& $git -C $source apply --whitespace=error-all $patch
if ($LASTEXITCODE -ne 0) { throw 'The published source patch could not be applied.' }
$buildEnv=@{
    GOMAXPROCS='2'; CGO_ENABLED='0'; GOTOOLCHAIN='local'; GOENV='off'; GOWORK='off'; GOFLAGS=''; GOEXPERIMENT='';
    GOCACHE=(Join-Path $BuildDirectory 'gocache'); GOMODCACHE=(Join-Path $BuildDirectory 'gomodcache'); GOPATH=(Join-Path $BuildDirectory 'gopath');
    GOPROXY='https://proxy.golang.org'; GOSUMDB='sum.golang.org'; GOPRIVATE=''; GONOPROXY='none'; GONOSUMDB='none'; GOINSECURE=''; GOAUTH='off';
    GOOS='windows'; GOARCH='amd64'; GOAMD64='v1'
}
$before=@{}
foreach ($name in $buildEnv.Keys) { $before[$name]=[Environment]::GetEnvironmentVariable($name,'Process'); [Environment]::SetEnvironmentVariable($name,[string]$buildEnv[$name],'Process') }
$previous=Get-Location
try {
    Set-Location -LiteralPath $source
    $version=(& $go version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $version -cne ('go version '+$manifest.toolchain.version+' windows/amd64')) { throw 'The extracted Go toolchain version does not match.' }
    & $go test -p 1 ./internal/signature
    if ($LASTEXITCODE -ne 0) { throw 'The upstream and Q18/Q19/Q20 signature regressions failed.' }
    $output=Join-Path $BuildDirectory 'output'
    New-Item -ItemType Directory -Path $output | Out-Null
    $binary=Join-Path $output 'cli-proxy-api.exe'
    $flags='-s -w -buildid= -X main.Version='+$manifest.patched.release+' -X main.Commit='+$manifest.source.commit+'-gateway-q19 -X main.BuildDate='+$manifest.patched.buildDate
    & $go build -p 1 -trimpath -buildvcs=false -ldflags $flags -o $binary ./cmd/server
    if ($LASTEXITCODE -ne 0) { throw 'The patched bridge build failed.' }
    Assert-BuildHash $binary ([string]$manifest.patched.sha256)
    Copy-Item -LiteralPath (Join-Path $source 'LICENSE') -Destination (Join-Path $output 'LICENSE-CLIProxyAPI')
    Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $output 'binary-manifest.json')
    Write-Output ('Verified patched bridge built at '+$output)
    Write-Output ('SHA-256: '+$manifest.patched.sha256)
} finally {
    Set-Location -LiteralPath $previous.Path
    foreach ($name in $buildEnv.Keys) { [Environment]::SetEnvironmentVariable($name,$before[$name],'Process') }
}
