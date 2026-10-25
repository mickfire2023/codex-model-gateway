[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$release = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\gateway'))
$winps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$temporaryParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$fixture = Join-Path $temporaryParent ('codex-entrypoints ' + [char]0x4E2D + [char]0x6587 + '-' + [Guid]::NewGuid().ToString('N'))
$entries = Join-Path $fixture 'entry scripts'
$foreignCwd = Join-Path $fixture 'different working directory'
$explicit = Join-Path $fixture 'explicit installation'
$restoreRoot = Join-Path $fixture 'restored installation'
$checks = 0
function Assert-Entry([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message }; $script:checks++ }
function Write-Entry([string]$Path,[string]$Text) { [IO.File]::WriteAllText($Path,$Text,(New-Object Text.UTF8Encoding($true))) }
function Invoke-Entry([string]$Script,[string[]]$Arguments = @()) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $winps
    $info.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $Script + '"'
    foreach ($argument in $Arguments) { $info.Arguments += ' "' + $argument + '"' }
    $info.WorkingDirectory = $foreignCwd
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
    $info.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
    $info.EnvironmentVariables['PSModulePath'] = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\Modules'
    $info.EnvironmentVariables['PSExecutionPolicyPreference'] = 'Bypass'
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    try {
        if (-not $process.Start()) { throw 'Unable to start isolated entrypoint.' }
        $output = $process.StandardOutput.ReadToEndAsync()
        $errorOutput = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(40000)) { $process.Kill(); throw 'Isolated entrypoint timed out.' }
        return [pscustomobject]@{ Code = $process.ExitCode; Output = $output.Result.Trim(); ErrorOutput = $errorOutput.Result.Trim() }
    } finally { $process.Dispose() }
}
function New-EntryPort {
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0)
    $listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
    return $port
}
try {
    foreach ($path in @($entries,$foreignCwd,$explicit,(Join-Path $restoreRoot 'private'))) { New-Item -ItemType Directory -Path $path -Force | Out-Null }
    $diagnostic = @'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
[pscustomobject]@{ Directory = $Directory; BodyRoot = $PSScriptRoot; Explicit = $PSBoundParameters.ContainsKey('Directory') } | ConvertTo-Json -Compress
'@
    $repro = Join-Path $entries 'old-default-repro.ps1'
    Write-Entry $repro ('[CmdletBinding()]' + "`n" + 'param([string]$Directory = $PSScriptRoot)' + "`n" + $diagnostic)
    $old = Invoke-Entry $repro
    Assert-Entry ($old.Code -eq 0) 'The old-default reproduction failed to execute.'
    $oldValue = $old.Output | ConvertFrom-Json
    Assert-Entry ([string]::IsNullOrEmpty($oldValue.Directory) -and $oldValue.BodyRoot -ceq $entries) 'The expected WinPS 5.1 advanced-param default bug was not reproduced.'

    # Preserve every production entrypoint's exact parameter block and bootstrap.
    # Replace only operational bodies, so these -File checks never start real services.
    $marker = '$Directory = [IO.Path]::GetFullPath($Directory).TrimEnd([char[]]''\/'')'
    $names = @('start.ps1','runner.ps1','restore.ps1','restart.ps1','enable.ps1','control.ps1','Open-dashboard.ps1')
    foreach ($name in $names) {
        $source = [IO.File]::ReadAllText((Join-Path $release $name))
        $position = $source.IndexOf($marker,[StringComparison]::Ordinal)
        Assert-Entry ($position -ge 0) ('Missing body-time directory bootstrap in ' + $name)
        Write-Entry (Join-Path $entries $name) ($source.Substring(0,$position + $marker.Length) + "`n" + $diagnostic)
    }
    $invalidWrapper = Join-Path $entries 'invoke-invalid.ps1'
    Write-Entry $invalidWrapper @'
param([string]$Target,[string]$Case)
$ErrorActionPreference = 'Stop'
$directory = switch ($Case) {
    'empty' { [string]::Empty }
    'relative' { 'relative-installation' }
    'drive-relative' { 'C:relative-installation' }
    'control' { 'C:\bad' + [char]10 + 'path' }
}
$parameters = @{ Directory = $directory }
if ([IO.Path]::GetFileName($Target) -eq 'control.ps1') { $parameters.Action = 'restart' }
& $Target @parameters
'@
    foreach ($name in $names) {
        $target = Join-Path $entries $name
        $required = if ($name -eq 'control.ps1') { @('-Action','restart') } else { @() }
        $omitted = Invoke-Entry $target $required
        Assert-Entry ($omitted.Code -eq 0) ('Omitted directory did not execute: ' + $name + ' ' + $omitted.ErrorOutput)
        $result = $omitted.Output | ConvertFrom-Json
        Assert-Entry ($result.Directory -ceq $entries -and -not $result.Explicit) ('Omitted directory depended on CWD in ' + $name)
        $specified = Invoke-Entry $target (@('-Directory',$explicit) + $required)
        Assert-Entry ($specified.Code -eq 0) ('Explicit directory did not execute in ' + $name)
        $result = $specified.Output | ConvertFrom-Json
        Assert-Entry ($result.Directory -ceq $explicit -and $result.Explicit) ('Explicit directory was overwritten in ' + $name)
        foreach ($case in @('empty','relative','drive-relative','control')) {
            $invalid = Invoke-Entry $invalidWrapper @('-Target',$target,'-Case',$case)
            Assert-Entry ($invalid.Code -ne 0 -and $invalid.ErrorOutput -match 'non-empty absolute path without control characters') ('Invalid directory was accepted or unclear: ' + $name + ' ' + $case)
        }
    }

    # Execute the real library, not an instrumented prefix. Dot-sourcing from a
    # different script must preserve explicitly selected roots and all path guards.
    Copy-Item -LiteralPath (Join-Path $release 'start.ps1') -Destination (Join-Path $restoreRoot 'start.ps1')
    $libraryProbe = Join-Path $entries 'library-probe.ps1'
    Write-Entry $libraryProbe @'
param([string]$Library,[string]$Expected)
$ErrorActionPreference = 'Stop'
. $Library -Directory $Expected -LibraryOnly
if ($Directory -cne $Expected) { throw 'Dot-source changed the selected installation.' }
if (Test-GatewaySamePath 'relative-unrelated-process.ps1' $Expected) { throw 'An unrelated relative process path matched the installation.' }
foreach ($invalid in @('', 'C:relative', ('C:\bad' + [char]10 + 'path'))) {
    $rejected = $false
    try { Get-GatewayFullPath $invalid | Out-Null } catch { $rejected = $_.Exception.Message -match 'non-empty absolute path' }
    if (-not $rejected) { throw 'The shared path helper accepted invalid input.' }
}
$driveRoot = [IO.Path]::GetPathRoot($Expected)
if ((Get-GatewayFullPath $driveRoot) -cne $driveRoot) { throw 'The drive root was changed to a drive-relative path.' }
'library passed'
'@
    $library = Invoke-Entry $libraryProbe @('-Library',(Join-Path $restoreRoot 'start.ps1'),'-Expected',$explicit)
    Assert-Entry ($library.Code -eq 0 -and $library.Output -match 'library passed') ('Real library invocation failed: ' + $library.ErrorOutput)
    $libraryOnly = Invoke-Entry (Join-Path $restoreRoot 'start.ps1') @('-LibraryOnly')
    Assert-Entry ($libraryOnly.Code -eq 0) ('Real start -LibraryOnly omitted-directory failed: ' + $libraryOnly.ErrorOutput)

    # Run the complete recovery entrypoint twice without Directory. Both config
    # and startup state are fixture files; no live registry or Codex config is used.
    foreach ($name in $names) { Copy-Item -LiteralPath (Join-Path $release $name) -Destination (Join-Path $restoreRoot $name) }
    $config = Join-Path $fixture 'fixture-config.toml'
    $runFile = Join-Path $fixture 'fixture-run.json'
    $settings = @{port = (New-EntryPort); routeToken = 'synthetic_entrypoint_token_0123456789'; nodePath = (Get-Command node.exe -ErrorAction Stop).Source; previousBaseUrlLine = $null; previousCatalogLine = $null; lifecycle = @{configPath = $config; runStateFile = $runFile}}
    Write-Entry (Join-Path $restoreRoot 'private\settings.json') ($settings | ConvertTo-Json -Depth 8)
    Write-Entry $config ("openai_base_url = 'http://127.0.0.1:" + $settings.port + "/synthetic_entrypoint_token_0123456789/backend-api/codex'`nmodel = 'synthetic-gpt'`n[plugins.future]`nenabled = true`n")
    Write-Entry $runFile '{"value":null}'
    Write-Entry (Join-Path $restoreRoot 'private\enabled') 'enabled'
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        $recovery = Invoke-Entry (Join-Path $restoreRoot 'restore.ps1')
        Assert-Entry ($recovery.Code -eq 0) ('Real recovery without Directory failed: ' + $recovery.ErrorOutput)
        $restored = [IO.File]::ReadAllText($config)
        Assert-Entry ($restored -notmatch 'openai_base_url' -and $restored -match 'synthetic-gpt' -and $restored -match '\[plugins.future\]') 'Recovery lost unrelated fixture settings.'
    }
    Assert-Entry (-not (Test-Path -LiteralPath (Join-Path $restoreRoot 'private\enabled'))) 'Recovery left the fixture enabled.'
    $gateway = @'
'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const settings=JSON.parse(fs.readFileSync(path.join(__dirname,'private/settings.json'),'utf8').replace(/^\uFEFF/,''));
http.createServer((req,res)=>{res.writeHead(req.url==='/health'?200:404,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify({ok:true,service:'codex-local-model-gateway',pid:process.pid,directory:__dirname}));}).listen(settings.port,'127.0.0.1');
fs.writeFileSync(path.join(__dirname,'combined-models.json'),'{"models":[]}');
'@
    [IO.File]::WriteAllText((Join-Path $restoreRoot 'gateway.cjs'),$gateway,(New-Object Text.UTF8Encoding($false)))
    $idleRunner = Invoke-Entry (Join-Path $restoreRoot 'runner.ps1')
    Assert-Entry ($idleRunner.Code -eq 0 -and -not (Test-Path -LiteralPath (Join-Path $restoreRoot 'private\runner.pid'))) ('Idle runner without Directory failed: ' + $idleRunner.ErrorOutput)
    $started = Invoke-Entry (Join-Path $restoreRoot 'start.ps1') @('-TimeoutSeconds','15')
    Assert-Entry ($started.Code -eq 0) ('Real start without Directory failed: ' + $started.ErrorOutput)
    $healthUrl = 'http://127.0.0.1:' + $settings.port + '/health'
    $first = Invoke-RestMethod $healthUrl -TimeoutSec 3 -UseBasicParsing
    Assert-Entry ($first.ok -eq $true) 'The default-directory start did not pass health.'
    $restarted = Invoke-Entry (Join-Path $restoreRoot 'restart.ps1') @('-DelaySeconds','0')
    Assert-Entry ($restarted.Code -eq 0) ('Real restart without Directory failed: ' + $restarted.ErrorOutput)
    $second = Invoke-RestMethod $healthUrl -TimeoutSec 3 -UseBasicParsing
    Assert-Entry ($second.pid -ne $first.pid) 'Real default-directory restart did not replace the fixture Node.'
    $control = Invoke-Entry (Join-Path $restoreRoot 'control.ps1') @('-Action','restart')
    Assert-Entry ($control.Code -eq 0) ('Real control without Directory failed: ' + $control.ErrorOutput)
    $controlState = [IO.File]::ReadAllText((Join-Path $restoreRoot 'private\control-status.json')) | ConvertFrom-Json
    Assert-Entry ($controlState.state -eq 'succeeded') 'Real default-directory control did not persist success.'
    $enabled = Invoke-Entry (Join-Path $restoreRoot 'enable.ps1')
    Assert-Entry ($enabled.Code -eq 0) ('Real enable without Directory failed: ' + $enabled.ErrorOutput)
    Assert-Entry ([IO.File]::ReadAllText($config) -match 'openai_base_url') 'Real default-directory enable did not restore the fixture connection.'
    $dashboard = [IO.File]::ReadAllText((Join-Path $restoreRoot 'Open-dashboard.ps1'))
    $browserLine = ($dashboard -split '\r?\n' | Where-Object { $_ -match '^\s*Start-Process -FilePath \(''http' })
    Assert-Entry (@($browserLine).Count -eq 1) 'The dashboard browser-only interception point changed.'
    $dashboard = $dashboard.Replace([string]$browserLine,'    Write-GatewayUtf8 (Join-Path $Directory ''dashboard-opened.fixture'') ''opened''')
    Write-Entry (Join-Path $restoreRoot 'Open-dashboard.ps1') $dashboard
    $opened = Invoke-Entry (Join-Path $restoreRoot 'Open-dashboard.ps1')
    Assert-Entry ($opened.Code -eq 0 -and (Test-Path -LiteralPath (Join-Path $restoreRoot 'dashboard-opened.fixture'))) ('Real dashboard body without Directory failed: ' + $opened.ErrorOutput)
    $recovery = Invoke-Entry (Join-Path $restoreRoot 'restore.ps1')
    Assert-Entry ($recovery.Code -eq 0 -and [IO.File]::ReadAllText($config) -notmatch 'openai_base_url') ('Recovery after real enable failed: ' + $recovery.ErrorOutput)
    Write-Output ('PASS: ' + $checks + ' entrypoint checks; old WinPS default bug reproduced; all seven -File bootstraps and actual recovery verified.')
} finally {
    if (Test-Path -LiteralPath (Join-Path $restoreRoot 'private\settings.json')) {
        . (Join-Path $release 'start.ps1') -Directory $restoreRoot -LibraryOnly
        Stop-GatewayService $restoreRoot
    }
    $actual = [IO.Path]::GetFullPath($fixture)
    if (-not $actual.StartsWith($temporaryParent + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture cleanup path escaped the temporary parent.' }
    if (Test-Path -LiteralPath $actual) { Remove-Item -LiteralPath $actual -Recurse -Force }
}
