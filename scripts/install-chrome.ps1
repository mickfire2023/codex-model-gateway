[CmdletBinding(SupportsShouldProcess=$true)]
param(
    [string]$InstallDirectory,
    [string]$ConfigPath,
    [string]$NodePath,
    [string]$NpmCliPath,
    [string]$ChromePath,
    [switch]$EnableVision,
    [switch]$LibraryOnly
)
$ErrorActionPreference='Stop'

# Optional installer. It never launches Chrome and never changes approvals.
$script:ChromeBridgeVersion='0.0.83'
$script:ChromeBridgeIntegrity='sha512-oNcl+Ae2/IAjhfPeP46BfIkSakfmprY+aOtkv5MjrQ4lPav4/yNtPhL0iq8SlIM90oApWgBDUxaNKvktazUKOg=='
$script:ChromeBridgeRepository='git+https://github.com/microsoft/playwright-mcp.git'
$script:ChromeBridgeToolAllowList=@(
    'browser_navigate','browser_navigate_back','browser_snapshot','browser_click',
    'browser_type','browser_fill_form','browser_select_option','browser_press_key',
    'browser_hover','browser_tabs','browser_resize','browser_take_screenshot',
    'browser_wait_for','browser_close'
)

function Get-ChromeBridgeHash([byte[]]$Bytes) {
    $algorithm=[Security.Cryptography.SHA256]::Create()
    try { return [Convert]::ToBase64String($algorithm.ComputeHash($Bytes)) }
    finally { $algorithm.Dispose() }
}

function ConvertTo-ChromeBridgeToml([string]$Value) {
    # JSON basic-string escaping is also valid for the paths used in TOML here.
    return (ConvertTo-Json -InputObject $Value -Compress)
}

function Get-ChromeBridgeAccessControl([IO.FileSystemInfo]$Item) {
    # Never request Audit/SACL sections or privilege elevation.
    $sections=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
    if ($Item.PSObject.Methods['GetAccessControl']) { return $Item.GetAccessControl($sections) }
    return [IO.FileSystemAclExtensions]::GetAccessControl($Item,$sections)
}

function Test-ChromeBridgePrivateAccess([object]$Acl,[Security.Principal.SecurityIdentifier]$Sid,[bool]$Directory) {
    if (-not $Acl.GetOwner([Security.Principal.SecurityIdentifier]).Equals($Sid) -or -not $Acl.AreAccessRulesProtected) { return $false }
    $full=[Security.AccessControl.FileSystemRights]::FullControl
    $effective=0; $inheritable=0
    $both=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    foreach ($rule in $Acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if (-not $rule.IdentityReference.Equals($Sid) -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { return $false }
        if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0) { $effective=$effective -bor $rule.FileSystemRights }
        if (($rule.InheritanceFlags -band $both) -eq $both -and ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::NoPropagateInherit) -eq 0) { $inheritable=$inheritable -bor $rule.FileSystemRights }
    }
    return (($effective -band $full) -eq $full -and (-not $Directory -or ($inheritable -band $full) -eq $full))
}

function Protect-ChromeBridgePath([string]$Path,[switch]$Directory) {
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
    $item=if ($Directory) { New-Object IO.DirectoryInfo($Path) } else { New-Object IO.FileInfo($Path) }
    $existing=Get-ChromeBridgeAccessControl $item
    if (-not $existing.GetOwner([Security.Principal.SecurityIdentifier]).Equals($sid)) {
        throw 'The component path is not owned by the current user. Existing permissions were preserved; administrator privileges are not requested.'
    }
    # Idempotence avoids the PowerShell provider's Set-Acl path on an already
    # protected directory. Verify protection instead of blindly rewriting it.
    if (Test-ChromeBridgePrivateAccess $existing $sid ([bool]$Directory)) { return }
    if ($Directory) {
        $acl=New-Object Security.AccessControl.DirectorySecurity
        $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    } else {
        $acl=New-Object Security.AccessControl.FileSecurity
        $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')
    }
    # Owner was already verified. Mark only DACL as modified: do not set owner,
    # load audit rules, or ask Set-Acl to persist other security sections.
    $acl.SetAccessRuleProtection($true,$false); $acl.AddAccessRule($rule)
    if ($item.PSObject.Methods['SetAccessControl']) { $item.SetAccessControl($acl) }
    else { [IO.FileSystemAclExtensions]::SetAccessControl($item,$acl) }
    if (-not (Test-ChromeBridgePrivateAccess (Get-ChromeBridgeAccessControl $item) $sid ([bool]$Directory))) {
        throw 'The component path did not pass the current-user-only permissions check. Codex configuration was not changed.'
    }
}

function New-ChromeBridgeCreationSecurity([bool]$Directory) {
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
    if ($Directory) {
        $acl=New-Object Security.AccessControl.DirectorySecurity
        $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    } else {
        $acl=New-Object Security.AccessControl.FileSecurity
        $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')
    }
    # This security descriptor is used only when creating a new object. An
    # elevated token's default Owner may be Administrators rather than its User.
    # Specify the valid token-user Owner up front, with no SACL or privileges.
    $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $acl.AddAccessRule($rule)
    return $acl
}

function New-ChromeBridgeDirectory([string]$Path) {
    $full=[IO.Path]::GetFullPath($Path)
    if (Test-Path -LiteralPath $full) {
        if (-not (Test-Path -LiteralPath $full -PathType Container)) { throw 'A component directory path is already occupied by a file.' }
        # Existing objects are never assigned a new Owner.
        Protect-ChromeBridgePath $full -Directory
        return
    }
    if (-not (Test-Path -LiteralPath (Split-Path -Parent $full) -PathType Container)) { throw 'The component directory parent must already exist.' }
    $security=New-ChromeBridgeCreationSecurity $true
    if ($PSVersionTable.PSEdition -eq 'Desktop') { [IO.Directory]::CreateDirectory($full,$security) | Out-Null }
    else { [IO.FileSystemAclExtensions]::Create((New-Object IO.DirectoryInfo($full)),$security) }
    Protect-ChromeBridgePath $full -Directory
}

function New-ChromeBridgePrivateFile([string]$Path) {
    $full=[IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath (Split-Path -Parent $full) -PathType Container)) { throw 'The component file parent must already exist.' }
    $security=New-ChromeBridgeCreationSecurity $false
    # CreateNew is atomic: an existing file is never overwritten or re-owned.
    if ($PSVersionTable.PSEdition -eq 'Desktop') {
        return [IO.FileStream]::new($full,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::FullControl,[IO.FileShare]::None,4096,[IO.FileOptions]::None,$security)
    }
    return [IO.FileSystemAclExtensions]::Create((New-Object IO.FileInfo($full)),[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::FullControl,[IO.FileShare]::None,4096,[IO.FileOptions]::None,$security)
}

function Assert-ChromeBridgeMetadata([object]$Metadata) {
    if ($Metadata.name -cne '@playwright/mcp' -or $Metadata.version -cne $script:ChromeBridgeVersion -or
        $Metadata.repository.url -cne $script:ChromeBridgeRepository -or
        $Metadata.dist.integrity -cne $script:ChromeBridgeIntegrity -or
        $Metadata.dist.tarball -cne ('https://registry.npmjs.org/@playwright/mcp/-/mcp-'+$script:ChromeBridgeVersion+'.tgz')) {
        throw 'The pinned Microsoft package metadata did not match. Nothing was connected to Codex.'
    }
}

function New-ChromeBridgeBlock([string]$Name,[string]$Node,[string]$Cli,[string]$Chrome,[string]$Images,[string]$NewLine="`n",[string]$PackageVersion=$script:ChromeBridgeVersion) {
    if ($Name -notin @('chrome_text','chrome_vision') -or $Images -notin @('omit','allow')) { throw 'Unknown Chrome bridge mode.' }
    $arguments=@($Cli,'--browser','chrome','--executable-path',$Chrome,'--isolated','--image-responses',$Images)
    $argsToml=(@($arguments | ForEach-Object { ConvertTo-ChromeBridgeToml $_ }) -join ', ')
    $toolsToml=(@($script:ChromeBridgeToolAllowList | ForEach-Object { ConvertTo-ChromeBridgeToml $_ }) -join ', ')
    return (@(
        ('# BEGIN Codex Chrome Bridge '+$Name+' '+$PackageVersion),
        ('[mcp_servers.'+$Name+']'),
        ('command = '+(ConvertTo-ChromeBridgeToml $Node)),
        ('args = ['+$argsToml+']'),
        ('enabled_tools = ['+$toolsToml+']'),
        'startup_timeout_sec = 30',
        'tool_timeout_sec = 60',
        ('# END Codex Chrome Bridge '+$Name)
    ) -join $NewLine)
}

function Get-ChromeBridgeComparableSection([string]$Text) {
    # Only generated basic-string lines are accepted as equivalent. Comments and
    # line ending differences may vary; unknown keys cause a safe refusal.
    return ([regex]::Replace(($Text -replace "`r`n","`n"),'(?m)^\s*#.*(?:\n|$)','')).Trim()
}

function Merge-ChromeBridgeConfig([byte[]]$Original,[hashtable]$Blocks,[hashtable]$PreviousBlocks=@{}) {
    $utf8=New-Object Text.UTF8Encoding($false,$true)
    $text=$utf8.GetString($Original)
    $scan=$text.TrimStart([char]0xFEFF)
    # Do not guess the meaning of complex inline/parent-table definitions.
    if ($scan -match '(?m)^\s*(?:mcp_servers|"mcp_servers"|''mcp_servers'')\s*=' -or
        $scan -match '(?m)^\s*\[\s*(?:mcp_servers|"mcp_servers"|''mcp_servers'')\s*\]') {
        throw 'The MCP configuration uses an inline or parent table. Existing configuration was preserved; add the reviewed block manually.'
    }
    $newLine=if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
    $append=New-Object Collections.Generic.List[string]
    $replacements=New-Object Collections.Generic.List[object]
    foreach ($name in @('chrome_text','chrome_vision')) {
        if (-not $Blocks.ContainsKey($name)) { continue }
        $quoted='(?:'+[regex]::Escape($name)+'|"'+[regex]::Escape($name)+'"|'''+[regex]::Escape($name)+''')'
        $base='(?:mcp_servers|"mcp_servers"|''mcp_servers'')\s*\.\s*'+$quoted
        if ($scan -match ('(?m)^\s*'+$base+'\s*(?:\.|=)')) { throw ('Existing '+$name+' uses dotted assignments and was preserved.') }
        $headers=[regex]::Matches($scan,'(?m)^\s*\[\[?\s*'+$base+'\s*(?:\.[^\]\r\n]+)?\]\]?[^\r\n]*')
        if ($headers.Count) {
            if ($headers.Count -ne 1 -or $headers[0].Value.Trim() -cne ('[mcp_servers.'+$name+']')) {
                throw ('Existing '+$name+' configuration differs; it was not overwritten.')
            }
            $start=$headers[0].Index
            $remaining=$scan.Substring($start+$headers[0].Length)
            $next=[regex]::Match($remaining,'(?m)^\s*\[')
            $length=if ($next.Success) { $headers[0].Length+$next.Index } else { $scan.Length-$start }
            $actual=Get-ChromeBridgeComparableSection $scan.Substring($start,$length)
            $expected=Get-ChromeBridgeComparableSection $Blocks[$name]
            if ($actual -cne $expected) {
                if (-not $PreviousBlocks.ContainsKey($name) -or $actual -cne (Get-ChromeBridgeComparableSection $PreviousBlocks[$name])) {
                    throw ('Existing '+$name+' configuration differs; it was not overwritten.')
                }
                $oldBlock=$PreviousBlocks[$name] -replace "`r?`n",$newLine
                if (-not $text.Contains($oldBlock)) { throw ('The generated '+$name+' block was edited. Existing configuration was preserved.') }
                $replacements.Add(@{old=$oldBlock;next=($Blocks[$name] -replace "`r?`n",$newLine)})
            }
        } else { $append.Add(($Blocks[$name] -replace "`r?`n",$newLine)) }
    }
    if (-not $append.Count -and -not $replacements.Count) { return ,$Original }
    foreach ($replacement in $replacements) { $text=$text.Replace($replacement.old,$replacement.next) }
    if ($replacements.Count) { $Original=$utf8.GetBytes($text) }
    if (-not $append.Count) { return ,$Original }
    $separator=if (-not $text.Length) { '' } elseif ($text.EndsWith("`n")) { $newLine } else { $newLine+$newLine }
    $suffix=$utf8.GetBytes($separator+($append -join ($newLine+$newLine))+$newLine)
    $result=New-Object byte[] ($Original.Length+$suffix.Length)
    [Buffer]::BlockCopy($Original,0,$result,0,$Original.Length)
    [Buffer]::BlockCopy($suffix,0,$result,$Original.Length,$suffix.Length)
    return ,$result
}

function Write-ChromeBridgeConfig([string]$Path,[byte[]]$Original,[byte[]]$Next,[string]$BackupDirectory) {
    if ((Get-ChromeBridgeHash ([IO.File]::ReadAllBytes($Path))) -cne (Get-ChromeBridgeHash $Original)) {
        throw 'Codex configuration changed during preparation. Existing configuration was preserved.'
    }
    if ((Get-ChromeBridgeHash $Original) -ceq (Get-ChromeBridgeHash $Next)) { return $null }
    $backup=Join-Path $BackupDirectory ('config-before-chrome-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')+'-'+[Guid]::NewGuid().ToString('N')+'.toml')
    [IO.File]::WriteAllBytes($backup,$Original)
    $temporary=$Path+'.chrome-bridge-'+[Guid]::NewGuid().ToString('N')+'.tmp'
    try {
        $stream=New-ChromeBridgePrivateFile $temporary
        $stream.Dispose()
        Protect-ChromeBridgePath $temporary
        [IO.File]::WriteAllBytes($temporary,$Next)
        if ((Get-ChromeBridgeHash ([IO.File]::ReadAllBytes($Path))) -cne (Get-ChromeBridgeHash $Original)) {
            throw 'Codex configuration changed before activation. Existing configuration was preserved.'
        }
        # Windows PowerShell converts an ordinary $null string argument to "".
        [IO.File]::Replace($temporary,$Path,[NullString]::Value)
        return $backup
    } finally {
        # Exact owned temporary file only; no recursive deletion or computed tree.
        if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Assert-ChromeBridgeWithin([string]$Path,[string]$Parent) {
    $full=[IO.Path]::GetFullPath($Path)
    $root=[IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if (-not $full.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) {
        throw 'A Chrome component path escaped its dedicated installation directory.'
    }
    return $full
}

function Assert-ChromeBridgeInstallMarker([object]$Marker,[string]$Directory,[string]$Configuration) {
    if ($Marker.kind -cne 'codex-chrome-bridge' -or $Marker.schemaVersion -ne 1 -or
        $Marker.installationId -notmatch '^[a-f0-9]{32}$' -or
        $Marker.state -notin @('prepared','installed') -or
        $Marker.version -notmatch '^\d+\.\d+\.\d+$' -or
        -not $Marker.directory -or -not $Marker.configPath -or
        -not [IO.Path]::GetFullPath([string]$Marker.directory).Equals([IO.Path]::GetFullPath($Directory),[StringComparison]::OrdinalIgnoreCase) -or
        -not [IO.Path]::GetFullPath([string]$Marker.configPath).Equals([IO.Path]::GetFullPath($Configuration),[StringComparison]::OrdinalIgnoreCase)) {
        throw 'The existing Chrome installation marker does not match this installation and configuration. Existing data was preserved.'
    }
    if ($Marker.state -eq 'installed') {
        $expected=Join-Path $Directory ('runtimes\playwright-mcp-'+$Marker.version)
        if (-not $Marker.runtimeRoot -or -not $Marker.chromePath -or
            -not [IO.Path]::GetFullPath([string]$Marker.runtimeRoot).Equals([IO.Path]::GetFullPath($expected),[StringComparison]::OrdinalIgnoreCase) -or
            $Marker.vision -isnot [bool]) {
            throw 'The existing Chrome runtime marker is incomplete or inconsistent. Existing data was preserved.'
        }
        Assert-ChromeBridgeWithin ([string]$Marker.runtimeRoot) $Directory | Out-Null
    }
}

function Assert-ChromeBridgeRuntime([string]$Root) {
    $runtimeNode=Join-Path $Root 'node.exe'
    $runtimeCli=Join-Path $Root 'node_modules\@playwright\mcp\cli.js'
    if (-not (Test-Path -LiteralPath $runtimeNode -PathType Leaf) -or -not (Test-Path -LiteralPath $runtimeCli -PathType Leaf)) {
        throw 'The optional Chrome runtime is incomplete. Codex configuration was not changed.'
    }
    # npm lockfiles contain packages[""]. Windows PowerShell 5.1 cannot parse
    # that valid JSON property into a PSObject. Use the copied Node runtime;
    # paths/pins are separate arguments, never interpolated JavaScript source.
    $validator=@'
const fs=require('node:fs'),path=require('node:path');
try {
  const [root,version,integrity,repository]=process.argv.slice(1);
  const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'node_modules/@playwright/mcp/package.json'),'utf8'));
  if(!lock.packages||typeof lock.packages!=='object'||Array.isArray(lock.packages))throw new Error();
  const entry=lock.packages['node_modules/@playwright/mcp'];
  const tarball='https://registry.npmjs.org/@playwright/mcp/-/mcp-'+version+'.tgz';
  if(!entry||entry.version!==version||entry.integrity!==integrity||entry.resolved!==tarball||pkg.name!=='@playwright/mcp'||pkg.version!==version||pkg.repository?.url!==repository)throw new Error();
  for(const item of Object.values(lock.packages)) {
    if(item.resolved&&(typeof item.resolved!=='string'||!item.resolved.startsWith('https://registry.npmjs.org/')))throw new Error();
  }
  process.stdout.write('chrome-bridge-runtime-verified');
} catch {
  process.exitCode=1;
}
'@
    $verified=& $runtimeNode -e $validator -- $Root $script:ChromeBridgeVersion $script:ChromeBridgeIntegrity $script:ChromeBridgeRepository
    if ($LASTEXITCODE -ne 0 -or $verified -cne 'chrome-bridge-runtime-verified') {
        throw 'The installed Chrome runtime did not match the pinned source. Codex configuration was not changed.'
    }
    & $runtimeNode $runtimeCli --help | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'The pinned CLI did not pass its help check. Codex configuration was not changed.' }
}

function Install-ChromeBridgeRuntime([string]$Directory,[string]$Node,[string]$Npm,[object]$Metadata) {
    Assert-ChromeBridgeMetadata $Metadata
    $root=Assert-ChromeBridgeWithin (Join-Path $Directory ('runtimes\playwright-mcp-'+$script:ChromeBridgeVersion)) $Directory
    if (Test-Path -LiteralPath $root -PathType Container) {
        # Reuse only a complete verified runtime. Never npm-install into one that
        # a current Codex session may already be using.
        Assert-ChromeBridgeRuntime $root
        return $root
    }
    $private=Join-Path $Directory 'private'
    $stage=Assert-ChromeBridgeWithin (Join-Path $private ('preparing-'+[Guid]::NewGuid().ToString('N'))) $Directory
    New-ChromeBridgeDirectory $stage
    $utf8=New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText((Join-Path $stage 'verified-source.json'),(@{name=$Metadata.name;version=$Metadata.version;repository=$Metadata.repository.url;integrity=$Metadata.dist.integrity;tarball=$Metadata.dist.tarball;verifiedUtc=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json),$utf8)
    [IO.File]::WriteAllText((Join-Path $stage 'package.json'),(@{name='codex-chrome-bridge';version='1.0.0';private=$true;dependencies=@{'@playwright/mcp'=$script:ChromeBridgeVersion}} | ConvertTo-Json -Depth 4),$utf8)
    $npmrc=Join-Path $stage 'npmrc'
    [IO.File]::WriteAllText($npmrc,"registry=https://registry.npmjs.org/`n@playwright:registry=https://registry.npmjs.org/`nignore-scripts=true`naudit=false`nfund=false`n",$utf8)
    $npmGlobal=Join-Path $stage 'npm-global-empty'
    [IO.File]::WriteAllText($npmGlobal,'',$utf8)
    $oldDownload=$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
    $oldScripts=$env:npm_config_ignore_scripts
    Push-Location -LiteralPath $stage
    try {
        $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD='1'; $env:npm_config_ignore_scripts='true'
        & $Node $Npm install --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/ --userconfig $npmrc --globalconfig $npmGlobal | Out-Host
        if ($LASTEXITCODE -ne 0) { throw 'The optional Chrome dependency preparation failed. Existing runtime and Codex configuration were preserved.' }
    } finally {
        Pop-Location
        $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=$oldDownload; $env:npm_config_ignore_scripts=$oldScripts
    }
    Copy-Item -LiteralPath $Node -Destination (Join-Path $stage 'node.exe')
    Assert-ChromeBridgeRuntime $stage
    New-ChromeBridgeDirectory (Split-Path -Parent $root)
    # Both absolute paths have been checked inside the explicitly chosen root.
    Assert-ChromeBridgeWithin $stage $Directory | Out-Null
    Assert-ChromeBridgeWithin $root $Directory | Out-Null
    if (Test-Path -LiteralPath $root) { throw 'Another installer prepared the runtime concurrently. Existing files and configuration were preserved.' }
    Move-Item -LiteralPath $stage -Destination $root
    return $root
}

if ($LibraryOnly) { return }
if (-not $InstallDirectory) { $InstallDirectory=Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'CodexChromeBridge' }
if (-not $ConfigPath) {
    $codexDirectory=if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
    $ConfigPath=Join-Path $codexDirectory 'config.toml'
}
$InstallDirectory=[IO.Path]::GetFullPath($InstallDirectory)
$ConfigPath=[IO.Path]::GetFullPath($ConfigPath)
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw 'An existing Codex config.toml is required.' }
if (-not (Test-Path -LiteralPath (Split-Path -Parent $InstallDirectory) -PathType Container)) { throw 'The installation parent directory must already exist.' }
if (-not $NodePath) { $NodePath=(Get-Command node.exe -ErrorAction Stop).Source }
$NodePath=[IO.Path]::GetFullPath($NodePath)
$version=& $NodePath --version
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) { throw 'Node.js 24 or newer is required.' }
if (-not $NpmCliPath) {
    $npmCommand=Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($npmCommand) { $NpmCliPath=Join-Path (Split-Path -Parent $npmCommand.Source) 'node_modules\npm\bin\npm-cli.js' }
}
if (-not $NpmCliPath -or -not (Test-Path -LiteralPath $NpmCliPath -PathType Leaf)) { throw 'Pass -NpmCliPath pointing to an existing npm-cli.js.' }
$NpmCliPath=[IO.Path]::GetFullPath($NpmCliPath)
if (-not $ChromePath) {
    $candidates=New-Object Collections.Generic.List[string]
    foreach ($directory in @($env:ProgramFiles,${env:ProgramFiles(x86)},$env:LOCALAPPDATA)) {
        if ($directory) { $candidates.Add((Join-Path $directory 'Google\Chrome\Application\chrome.exe')) }
    }
    $ChromePath=@($candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1)[0]
}
if (-not $ChromePath -or -not (Test-Path -LiteralPath $ChromePath -PathType Leaf)) { throw 'Install Google Chrome first, or pass -ChromePath. No browser is downloaded by this installer.' }
$ChromePath=[IO.Path]::GetFullPath($ChromePath)
$marker=Join-Path $InstallDirectory 'bridge-install.json'
$owned=$null
if (Test-Path -LiteralPath $InstallDirectory -PathType Container) {
    if (@(Get-ChildItem -LiteralPath $InstallDirectory -Force).Count) {
        if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { throw 'Choose an empty dedicated installation directory. Existing files were preserved.' }
        $owned=Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json
        Assert-ChromeBridgeInstallMarker $owned $InstallDirectory $ConfigPath
    }
}
$original=[IO.File]::ReadAllBytes($ConfigPath)
$runtimeRoot=Assert-ChromeBridgeWithin (Join-Path $InstallDirectory ('runtimes\playwright-mcp-'+$script:ChromeBridgeVersion)) $InstallDirectory
$runtimeNode=Join-Path $runtimeRoot 'node.exe'
$cli=Join-Path $runtimeRoot 'node_modules\@playwright\mcp\cli.js'
$effectiveVision=[bool]$EnableVision -or [bool]($owned -and $owned.state -eq 'installed' -and $owned.vision)
$blocks=@{chrome_text=(New-ChromeBridgeBlock 'chrome_text' $runtimeNode $cli $ChromePath 'omit')}
if ($effectiveVision) { $blocks.chrome_vision=New-ChromeBridgeBlock 'chrome_vision' $runtimeNode $cli $ChromePath 'allow' }
$previousBlocks=@{}
if ($owned -and $owned.state -eq 'installed') {
    $previousNode=Join-Path $owned.runtimeRoot 'node.exe'
    $previousCli=Join-Path $owned.runtimeRoot 'node_modules\@playwright\mcp\cli.js'
    $previousBlocks.chrome_text=New-ChromeBridgeBlock 'chrome_text' $previousNode $previousCli $owned.chromePath 'omit' "`n" $owned.version
    if ($owned.vision) { $previousBlocks.chrome_vision=New-ChromeBridgeBlock 'chrome_vision' $previousNode $previousCli $owned.chromePath 'allow' "`n" $owned.version }
}
# Reject conflicts before network access or writing installation data.
$next=Merge-ChromeBridgeConfig $original $blocks $previousBlocks
if (-not $PSCmdlet.ShouldProcess($InstallDirectory,'Install the pinned optional Chrome tools and append only the reviewed Codex MCP server entries')) { return }
$metadata=Invoke-RestMethod -Uri ('https://registry.npmjs.org/@playwright%2fmcp/'+$script:ChromeBridgeVersion) -TimeoutSec 30
Assert-ChromeBridgeMetadata $metadata
New-ChromeBridgeDirectory $InstallDirectory
$private=Join-Path $InstallDirectory 'private'
New-ChromeBridgeDirectory $private
$utf8=New-Object Text.UTF8Encoding($false)
$installationId=if ($owned) { [string]$owned.installationId } else { [Guid]::NewGuid().ToString('N') }
if (-not $owned) {
    [IO.File]::WriteAllText($marker,(@{kind='codex-chrome-bridge';schemaVersion=1;installationId=$installationId;directory=$InstallDirectory;configPath=$ConfigPath;version=$script:ChromeBridgeVersion;state='prepared'} | ConvertTo-Json),$utf8)
}
# A failure here only leaves an isolated preparation folder. A previously
# installed runtime, installation marker and Codex configuration stay intact.
$prepared=Install-ChromeBridgeRuntime $InstallDirectory $NodePath $NpmCliPath $metadata
if (-not $prepared.Equals($runtimeRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'The prepared runtime path did not match the reviewed configuration.' }
$backup=Write-ChromeBridgeConfig $ConfigPath $original $next $private
[IO.File]::WriteAllText($marker,(@{kind='codex-chrome-bridge';schemaVersion=1;installationId=$installationId;directory=$InstallDirectory;configPath=$ConfigPath;version=$script:ChromeBridgeVersion;state='installed';mode='isolated';vision=$effectiveVision;runtimeRoot=$runtimeRoot;chromePath=$ChromePath} | ConvertTo-Json),$utf8)
Write-Output 'Optional Chrome tools prepared. Restart Codex to load chrome_text. Chrome opens only when a browser tool is used.'
if ($effectiveVision) { Write-Output 'chrome_vision is also available for image-capable models; chrome_text remains available.' }
if ($backup) { Write-Output ('The original Codex configuration was backed up in the protected installation private directory: '+[IO.Path]::GetFileName($backup)) }
