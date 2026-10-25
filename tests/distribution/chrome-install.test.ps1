[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$installer=Join-Path $repo 'scripts\install-chrome.ps1'
. $installer -LibraryOnly
$script:ChromeFixtureAssertions=0
function Assert-ChromeFixture([bool]$Condition,[string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:ChromeFixtureAssertions++
}
function Assert-ChromeFixtureThrows([scriptblock]$Action,[string]$Message) {
    $threw=$false
    try { & $Action | Out-Null } catch { $threw=$true }
    Assert-ChromeFixture $threw $Message
}
$utf8=New-Object Text.UTF8Encoding($false)
$block=New-ChromeBridgeBlock 'chrome_text' 'C:\Synthetic 中文 space\node.exe' 'C:\Synthetic 中文 space\cli.js' 'C:\Synthetic Chrome\chrome.exe' 'omit'
$vision=New-ChromeBridgeBlock 'chrome_vision' 'C:\Synthetic 中文 space\node.exe' 'C:\Synthetic 中文 space\cli.js' 'C:\Synthetic Chrome\chrome.exe' 'allow'
Assert-ChromeFixture ($block.Contains('--isolated') -and $block.Contains('"omit"')) 'Text mode lost its isolated/omit settings.'
Assert-ChromeFixture (-not $block.Contains('chrome_vision')) 'Vision was included in the text-only block.'
Assert-ChromeFixture ($vision.Contains('[mcp_servers.chrome_vision]') -and $vision.Contains('"allow"')) 'Explicit vision block was not generated.'
Assert-ChromeFixture ($block -notmatch '(?i)approval|approve|evaluate|run_code|shell|debugging-port|--user-data-dir|--extension') 'Unexpected permission or execution setting appeared.'
Assert-ChromeFixture ($script:ChromeBridgeToolAllowList.Count -eq 14) 'The reviewed tool allow list changed.'
foreach ($ending in @("`n","`r`n")) {
    $text=@('model = "gpt-synthetic"','[plugins.synthetic]','enabled = true','[mcp_servers.other]','command = "synthetic-command"','') -join $ending
    foreach ($bom in @($false,$true)) {
        $original=$utf8.GetBytes($text)
        if ($bom) { $original=[byte[]](@(0xEF,0xBB,0xBF)+@($original)) }
        $merged=Merge-ChromeBridgeConfig $original @{chrome_text=$block}
        $prefix=New-Object byte[] $original.Length
        [Buffer]::BlockCopy($merged,0,$prefix,0,$prefix.Length)
        Assert-ChromeFixture ((Get-ChromeBridgeHash $original) -ceq (Get-ChromeBridgeHash $prefix)) 'The original configuration bytes changed.'
        $twice=Merge-ChromeBridgeConfig $merged @{chrome_text=$block}
        Assert-ChromeFixture ((Get-ChromeBridgeHash $merged) -ceq (Get-ChromeBridgeHash $twice)) 'Repeated configuration was not idempotent.'
    }
}
$both=Merge-ChromeBridgeConfig $utf8.GetBytes('model = "gpt-synthetic"') @{chrome_text=$block;chrome_vision=$vision}
$bothAgain=Merge-ChromeBridgeConfig $both @{chrome_text=$block;chrome_vision=$vision}
Assert-ChromeFixture ((Get-ChromeBridgeHash $both) -ceq (Get-ChromeBridgeHash $bothAgain)) 'Two-server configuration was not idempotent.'
$textOnlyAgain=Merge-ChromeBridgeConfig $both @{chrome_text=$block}
Assert-ChromeFixture ((Get-ChromeBridgeHash $both) -ceq (Get-ChromeBridgeHash $textOnlyAgain)) 'Rerunning text-only removed an existing vision entry.'
Assert-ChromeFixtureThrows { Merge-ChromeBridgeConfig $utf8.GetBytes('[mcp_servers.chrome_text]'+"`n"+'command = "other-command"') @{chrome_text=$block} } 'A conflicting server entry was accepted.'
Assert-ChromeFixtureThrows { Merge-ChromeBridgeConfig $utf8.GetBytes($block+"`n"+'tool_timeout_sec = 999') @{chrome_text=$block} } 'A changed generated server was accepted.'
Assert-ChromeFixtureThrows { Merge-ChromeBridgeConfig $utf8.GetBytes('[mcp_servers.chrome_text.env]'+"`n"+'SYNTHETIC = "value"') @{chrome_text=$block} } 'A conflicting nested server entry was accepted.'
Assert-ChromeFixtureThrows { Merge-ChromeBridgeConfig $utf8.GetBytes('mcp_servers = { chrome_text = { command = "other" } }') @{chrome_text=$block} } 'A complex inline table was guessed.'
$good=[pscustomobject]@{name='@playwright/mcp';version=$script:ChromeBridgeVersion;repository=@{url=$script:ChromeBridgeRepository};dist=@{integrity=$script:ChromeBridgeIntegrity;tarball=('https://registry.npmjs.org/@playwright/mcp/-/mcp-'+$script:ChromeBridgeVersion+'.tgz')}}
Assert-ChromeBridgeMetadata $good
Assert-ChromeFixture $true 'Pinned package metadata validation failed.'
foreach ($which in @('version','repository','integrity','tarball')) {
    $bad=$good | ConvertTo-Json -Depth 5 | ConvertFrom-Json
    switch ($which) {
        'version' { $bad.version='0.0.0-synthetic' }
        'repository' { $bad.repository.url='https://synthetic.invalid/not-microsoft' }
        'integrity' { $bad.dist.integrity='sha512-synthetic-mismatch' }
        'tarball' { $bad.dist.tarball='https://synthetic.invalid/mcp.tgz' }
    }
    Assert-ChromeFixtureThrows { Assert-ChromeBridgeMetadata $bad } ('Unexpected '+$which+' was accepted.')
}
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('codex-chrome-install-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
Protect-ChromeBridgePath $fixture -Directory
$fixtureSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$protectedDirectory=New-Object IO.DirectoryInfo($fixture)
$directoryBefore=Get-ChromeBridgeAccessControl $protectedDirectory
$directorySecurityHash=Get-ChromeBridgeHash $directoryBefore.GetSecurityDescriptorBinaryForm()
Protect-ChromeBridgePath $fixture -Directory
$directoryAfter=Get-ChromeBridgeAccessControl $protectedDirectory
Assert-ChromeFixture (Test-ChromeBridgePrivateAccess $directoryAfter $fixtureSid $true) 'Repeated protection weakened the current-user-only directory access.'
Assert-ChromeFixture ((Get-ChromeBridgeHash $directoryAfter.GetSecurityDescriptorBinaryForm()) -ceq $directorySecurityHash) 'Repeated directory protection unnecessarily changed its existing owner or DACL.'
$protectedFile=Join-Path $fixture 'synthetic-protected-file.txt'
[IO.File]::WriteAllText($protectedFile,'Synthetic protected fixture.',$utf8)
Protect-ChromeBridgePath $protectedFile
$fileInfo=New-Object IO.FileInfo($protectedFile)
$fileBefore=Get-ChromeBridgeAccessControl $fileInfo
$fileSecurityHash=Get-ChromeBridgeHash $fileBefore.GetSecurityDescriptorBinaryForm()
Protect-ChromeBridgePath $protectedFile
$fileAfter=Get-ChromeBridgeAccessControl $fileInfo
Assert-ChromeFixture (Test-ChromeBridgePrivateAccess $fileAfter $fixtureSid $false) 'Repeated protection weakened the current-user-only file access.'
Assert-ChromeFixture ((Get-ChromeBridgeHash $fileAfter.GetSecurityDescriptorBinaryForm()) -ceq $fileSecurityHash) 'Repeated file protection unnecessarily changed its existing owner or DACL.'
$private=Join-Path $fixture 'private'
New-Item -ItemType Directory -Path $private | Out-Null
$config=Join-Path $fixture 'synthetic-config.toml'
$original=$utf8.GetBytes('model = "gpt-synthetic"'+"`n"+'[plugins.synthetic]'+"`n"+'enabled = true'+"`n")
[IO.File]::WriteAllBytes($config,$original)
$next=Merge-ChromeBridgeConfig $original @{chrome_text=$block}
$backup=Write-ChromeBridgeConfig $config $original $next $private
Assert-ChromeFixture ((Get-ChromeBridgeHash ([IO.File]::ReadAllBytes($backup))) -ceq (Get-ChromeBridgeHash $original)) 'Configuration backup differs from the original.'
Assert-ChromeFixture ((Get-ChromeBridgeHash ([IO.File]::ReadAllBytes($config))) -ceq (Get-ChromeBridgeHash $next)) 'Atomic activation did not write the expected bytes.'
$edited=$utf8.GetBytes($utf8.GetString($next)+"`n"+'# synthetic concurrent edit')
[IO.File]::WriteAllBytes($config,$edited)
Assert-ChromeFixtureThrows { Write-ChromeBridgeConfig $config $next $original $private } 'A concurrent configuration edit was overwritten.'
Assert-ChromeFixture ((Get-ChromeBridgeHash ([IO.File]::ReadAllBytes($config))) -ceq (Get-ChromeBridgeHash $edited)) 'The concurrent edit was not preserved.'
Assert-ChromeFixture (@(Get-ChildItem -LiteralPath $fixture -Filter '*.tmp').Count -eq 0) 'Atomic writer left a temporary configuration file.'
$whatIfConfig=Join-Path $fixture 'whatif-config.toml'
$whatIfInstall=Join-Path $fixture 'whatif-install'
$fakeChrome=Join-Path $fixture 'synthetic-chrome.exe'
$fakeAuth=Join-Path $fixture 'synthetic-auth.json'
[IO.File]::WriteAllBytes($whatIfConfig,$original)
[IO.File]::WriteAllText($fakeChrome,'Synthetic fixture, never executed.',$utf8)
[IO.File]::WriteAllText($fakeAuth,'{"synthetic":"preserve-me"}',$utf8)
$authBefore=Get-ChromeBridgeHash ([IO.File]::ReadAllBytes($fakeAuth))
$npmFixture=Join-Path $fixture 'synthetic-npm-cli.js'
[IO.File]::WriteAllText($npmFixture,'throw new Error("Synthetic npm must not execute during WhatIf.");',$utf8)
& $installer -NodePath (Get-Command node.exe -ErrorAction Stop).Source -NpmCliPath $npmFixture -ChromePath $fakeChrome -InstallDirectory $whatIfInstall -ConfigPath $whatIfConfig -WhatIf | Out-Null
Assert-ChromeFixture ((Get-ChromeBridgeHash ([IO.File]::ReadAllBytes($whatIfConfig))) -ceq (Get-ChromeBridgeHash $original)) 'WhatIf modified the synthetic config.'
Assert-ChromeFixture (-not (Test-Path -LiteralPath $whatIfInstall)) 'WhatIf wrote installation data.'
Assert-ChromeFixture ((Get-ChromeBridgeHash ([IO.File]::ReadAllBytes($fakeAuth))) -ceq $authBefore) 'Synthetic authentication data was modified.'
$owned=[pscustomobject]@{kind='codex-chrome-bridge';schemaVersion=1;installationId=[Guid]::NewGuid().ToString('N');directory=$fixture;configPath=$config;version='0.0.82';state='installed';runtimeRoot=(Join-Path $fixture 'runtimes\playwright-mcp-0.0.82');chromePath=$fakeChrome;vision=$false}
Assert-ChromeBridgeInstallMarker $owned $fixture $config
Assert-ChromeFixture $true 'Valid installation marker was rejected.'
foreach ($field in @('kind','state','installationId','runtimeRoot','configPath')) {
    $badMarker=$owned | ConvertTo-Json | ConvertFrom-Json
    switch ($field) {
        'kind' { $badMarker.kind='synthetic-other-tool' }
        'state' { $badMarker.state='unrecognized' }
        'installationId' { $badMarker.installationId='synthetic-invalid-id' }
        'runtimeRoot' { $badMarker.runtimeRoot=(Join-Path ([IO.Path]::GetTempPath()) 'outside-synthetic-runtime') }
        'configPath' { $badMarker.configPath=(Join-Path $fixture 'another-config.toml') }
    }
    Assert-ChromeFixtureThrows { Assert-ChromeBridgeInstallMarker $badMarker $fixture $config } ('Invalid install marker '+$field+' was accepted.')
}
$previous=New-ChromeBridgeBlock 'chrome_text' (Join-Path $owned.runtimeRoot 'node.exe') (Join-Path $owned.runtimeRoot 'node_modules\@playwright\mcp\cli.js') $fakeChrome 'omit' "`n" $owned.version
$oldConfig=Merge-ChromeBridgeConfig $original @{chrome_text=$previous}
$upgraded=Merge-ChromeBridgeConfig $oldConfig @{chrome_text=$block} @{chrome_text=$previous}
Assert-ChromeFixture ($utf8.GetString($upgraded).Contains($block)) 'An exact previously owned block could not be upgraded.'
Assert-ChromeFixture ($utf8.GetString($upgraded).StartsWith($utf8.GetString($original))) 'Owned upgrade changed unrelated configuration.'
Assert-ChromeFixtureThrows { Merge-ChromeBridgeConfig $utf8.GetBytes($previous+"`n"+'tool_timeout_sec = 999') @{chrome_text=$block} @{chrome_text=$previous} } 'Owned upgrade overwrote an edited block.'
$marker=Join-Path $fixture 'bridge-install.json'
[IO.File]::WriteAllText($marker,($owned | ConvertTo-Json),$utf8)
$markerBefore=Get-ChromeBridgeHash ([IO.File]::ReadAllBytes($marker))
New-Item -ItemType Directory -Path $owned.runtimeRoot -Force | Out-Null
$sentinel=Join-Path $owned.runtimeRoot 'synthetic-current-runtime.txt'
[IO.File]::WriteAllText($sentinel,'Preserve the previous running runtime.',$utf8)
$sentinelBefore=Get-ChromeBridgeHash ([IO.File]::ReadAllBytes($sentinel))
$configBefore=Get-ChromeBridgeHash ([IO.File]::ReadAllBytes($config))
$failingNpm=Join-Path $fixture 'synthetic-failing-npm-cli.js'
[IO.File]::WriteAllText($failingNpm,'process.exit(73);',$utf8)
$beforeDirectory=(Get-Location).Path
Assert-ChromeFixtureThrows { Install-ChromeBridgeRuntime $fixture (Get-Command node.exe -ErrorAction Stop).Source $failingNpm $good } 'Failed runtime preparation was accepted.'
Assert-ChromeFixture ((Get-ChromeBridgeHash ([IO.File]::ReadAllBytes($config))) -ceq $configBefore) 'Failed runtime preparation changed Codex configuration.'
Assert-ChromeFixture ((Get-ChromeBridgeHash ([IO.File]::ReadAllBytes($marker))) -ceq $markerBefore) 'Failed runtime preparation changed the existing installation marker.'
Assert-ChromeFixture ((Get-ChromeBridgeHash ([IO.File]::ReadAllBytes($sentinel))) -ceq $sentinelBefore) 'Failed preparation changed the previous runtime.'
Assert-ChromeFixture ((Get-Location).Path -ceq $beforeDirectory) 'Failed preparation did not restore the working directory.'
Assert-ChromeFixture (-not (Test-Path -LiteralPath (Join-Path $fixture ('runtimes\playwright-mcp-'+$script:ChromeBridgeVersion)))) 'Failed preparation activated a runtime directory.'
Assert-ChromeFixture ((Get-ChromeBridgeHash ([IO.File]::ReadAllBytes($fakeAuth))) -ceq $authBefore) 'Runtime preparation touched authentication data.'
$successfulNpm=Join-Path $fixture 'synthetic-successful-npm-cli.js'
$fakeNpmSource=@'
const fs=require('node:fs');
fs.mkdirSync('node_modules/@playwright/mcp',{recursive:true});
fs.writeFileSync('node_modules/@playwright/mcp/package.json',JSON.stringify({name:'@playwright/mcp',version:'__VERSION__',repository:{url:'git+https://github.com/microsoft/playwright-mcp.git'}}));
fs.writeFileSync('node_modules/@playwright/mcp/cli.js',"if (!process.argv.includes('--help')) process.exit(74);");
fs.writeFileSync('package-lock.json',JSON.stringify({name:'synthetic-chrome-runtime',version:'1.0.0',lockfileVersion:3,packages:{'':{name:'synthetic-chrome-runtime',version:'1.0.0',dependencies:{'@playwright/mcp':'__VERSION__'}},'node_modules/@playwright/mcp':{version:'__VERSION__',integrity:'__INTEGRITY__',resolved:'https://registry.npmjs.org/@playwright/mcp/-/mcp-__VERSION__.tgz'}}}));
console.log('Synthetic dependency preparation completed.');
'@
$fakeNpmSource=$fakeNpmSource.Replace('__VERSION__',$script:ChromeBridgeVersion).Replace('__INTEGRITY__',$script:ChromeBridgeIntegrity)
[IO.File]::WriteAllText($successfulNpm,$fakeNpmSource,$utf8)
$prepared=Install-ChromeBridgeRuntime $fixture (Get-Command node.exe -ErrorAction Stop).Source $successfulNpm $good
$expectedRuntime=Join-Path $fixture ('runtimes\playwright-mcp-'+$script:ChromeBridgeVersion)
Assert-ChromeFixture ($prepared -is [string] -and $prepared -ceq $expectedRuntime) 'Runtime preparation returned mixed command output instead of one path.'
Assert-ChromeFixture ((Test-Path -LiteralPath (Join-Path $prepared 'node.exe')) -and (Test-Path -LiteralPath (Join-Path $prepared 'node_modules\@playwright\mcp\cli.js'))) 'Verified preparation did not promote a complete independent runtime.'
Assert-ChromeFixture ((Get-ChromeBridgeHash ([IO.File]::ReadAllBytes($config))) -ceq $configBefore) 'Preparing a runtime activated configuration prematurely.'
Assert-ChromeFixture ((Get-ChromeBridgeHash ([IO.File]::ReadAllBytes($marker))) -ceq $markerBefore) 'Preparing a runtime replaced the active installation marker prematurely.'
$reused=Install-ChromeBridgeRuntime $fixture (Get-Command node.exe -ErrorAction Stop).Source $failingNpm $good
Assert-ChromeFixture ($reused -ceq $prepared) 'A verified existing runtime was not reused independently of npm.'
Assert-ChromeFixture ((Get-ChromeBridgeHash ([IO.File]::ReadAllBytes($sentinel))) -ceq $sentinelBefore) 'Preparing or reusing a new runtime changed an older runtime.'
$lockPath=Join-Path $prepared 'package-lock.json'
$lockText=[IO.File]::ReadAllText($lockPath,$utf8)
Assert-ChromeFixture ($lockText.Contains('"packages":{"":')) 'The success fixture no longer covers the real npm empty root key that Windows PowerShell 5.1 cannot parse.'
try {
    [IO.File]::WriteAllText($lockPath,$lockText.Replace($script:ChromeBridgeIntegrity,'sha512-synthetic-wrong'),$utf8)
    Assert-ChromeFixtureThrows { Assert-ChromeBridgeRuntime $prepared } 'The Node lock validator accepted an unexpected installed integrity.'
    [IO.File]::WriteAllText($lockPath,$lockText.Replace('https://registry.npmjs.org/','https://synthetic.invalid/'),$utf8)
    Assert-ChromeFixtureThrows { Assert-ChromeBridgeRuntime $prepared } 'The Node lock validator accepted a dependency outside the official registry.'
} finally { [IO.File]::WriteAllText($lockPath,$lockText,$utf8) }
Assert-ChromeBridgeRuntime $prepared
Assert-ChromeFixture ((Get-ChromeBridgeHash ([IO.File]::ReadAllBytes($config))) -ceq $configBefore) 'Failed lock validation changed Codex configuration.'
Write-Output ('PASS: '+$script:ChromeFixtureAssertions+' Chrome installer fixture assertions. No browser, model or network access was used. Synthetic fixture retained: '+$fixture)
