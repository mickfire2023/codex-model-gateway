[CmdletBinding(SupportsShouldProcess=$true)]
param(
    [Parameter(Mandatory=$true)][string]$BinaryPath,
    [Parameter(Mandatory=$true)][string]$LicensePath,
    [string]$BridgeDirectory,
    [ValidateRange(1024,65535)][int]$Port=8317,
    [switch]$AcceptThirdPartyTerms
)
$ErrorActionPreference='Stop'
if (-not $AcceptThirdPartyTerms) { throw 'Read docs/GEMINI.md. Google restricts third-party subscription OAuth use and may suspend access. This optional adapter is not an official subscription API. Pass -AcceptThirdPartyTerms only if you understand and choose this integration.' }
if (-not $BridgeDirectory) { $BridgeDirectory=Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'CodexGeminiBridge' }
$BridgeDirectory=[IO.Path]::GetFullPath($BridgeDirectory).TrimEnd([char[]]'\/')
if ($BridgeDirectory -notmatch '^[A-Za-z]:[\\/]' -or $BridgeDirectory.Length -le 3) { throw 'Choose a dedicated absolute local bridge directory.' }
$source=Join-Path (Split-Path -Parent $PSScriptRoot) 'bridge'
$manifest=Get-Content -LiteralPath (Join-Path $source 'binary-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.version -ne 1 -or $manifest.product -cne 'CLIProxyAPI' -or [string]$manifest.official.sha256 -cnotmatch '^[a-f0-9]{64}$' -or [string]$manifest.patched.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $manifest.official.sha256 -ceq $manifest.patched.sha256) { throw 'The bridge binary manifest is invalid. No binary was executed.' }
$binaryHash=(Get-FileHash -LiteralPath $BinaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($binaryHash -cne $manifest.official.sha256 -and $binaryHash -cne $manifest.patched.sha256) { throw 'CLIProxyAPI binary hash does not match an explicitly verified Windows x64 build. No binary was executed.' }
if (-not (Test-Path -LiteralPath $LicensePath -PathType Leaf)) { throw 'Provide the LICENSE file from the same upstream release.' }
if (Test-Path -LiteralPath $BridgeDirectory) { throw 'This installer only creates a new bridge directory. It will not overwrite an existing login or adapter installation.' }
if (@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count) { throw 'The bridge port is already in use.' }
$node=(Get-Command node.exe -ErrorAction Stop).Source
if (-not $PSCmdlet.ShouldProcess($BridgeDirectory,'Install and start the verified optional subscription adapter')) { return }
New-Item -ItemType Directory -Path $BridgeDirectory | Out-Null
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false); $acl.SetOwner($sid)
$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$acl.AddAccessRule($rule); Set-Acl -LiteralPath $BridgeDirectory -AclObject $acl
foreach ($file in Get-ChildItem -LiteralPath $source -File) { if ($file.Extension -in @('.cjs','.ps1') -or $file.Name -in @('task-launcher.vbs','binary-manifest.json')) { Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $BridgeDirectory $file.Name) } }
Copy-Item -LiteralPath $BinaryPath -Destination (Join-Path $BridgeDirectory 'cli-proxy-api.exe')
Copy-Item -LiteralPath $LicensePath -Destination (Join-Path $BridgeDirectory 'LICENSE-CLIProxyAPI')
. (Join-Path $BridgeDirectory 'lifecycle.ps1')
$physical=Get-GeminiBridgeRoot $BridgeDirectory
& $node -e 'require(process.argv[1]).initialize(process.argv[2],{port:Number(process.argv[3])})' (Join-Path $physical 'initialize.cjs') $physical $Port
if ($LASTEXITCODE -ne 0) { throw 'Bridge preparation failed. The main gateway was not changed.' }
& (Join-Path $physical 'start.ps1') -Directory $physical -Port $Port
Write-Output 'Optional bridge started. Run connect-gemini.ps1 to sign in, verify models and register the provider.'
