[CmdletBinding()]
param(
    [string]$Directory,
    [ValidateRange(3, 180)][int]$TimeoutSeconds = 45,
    [switch]$LibraryOnly
)
$ErrorActionPreference = 'Stop'
# WinPS 5.1 evaluates advanced-script parameter defaults before PSScriptRoot is
# populated. Resolve an omitted directory here, never against the caller's CWD.
if (-not $PSBoundParameters.ContainsKey('Directory')) { $Directory = $PSScriptRoot }
if ([string]::IsNullOrWhiteSpace($Directory) -or $Directory -match '[\x00-\x1F\x7F]' -or $Directory -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))') {
    throw 'The installation directory must be a non-empty absolute path without control characters.'
}
$Directory = [IO.Path]::GetFullPath($Directory).TrimEnd([char[]]'\/')
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'physical-path.ps1')) { . (Join-Path $PSScriptRoot 'physical-path.ps1') }
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'scheduler.ps1')) { . (Join-Path $PSScriptRoot 'scheduler.ps1') -Directory $Directory -LibraryOnly }

# Shared lifecycle functions are loaded by the other scripts without starting a service.
function Get-GatewayFullPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path -match '[\x00-\x1F\x7F]' -or $Path -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))') {
        throw 'A non-empty absolute path without control characters is required.'
    }
    $full = [System.IO.Path]::GetFullPath($Path)
    $root = [System.IO.Path]::GetPathRoot($full)
    if ($full.Length -gt $root.Length) { return $full.TrimEnd([char[]]'\/') }
    return $root
}
function Test-GatewaySamePath([string]$Left, [string]$Right) {
    if (-not $Left -or -not $Right) { return $false }
    try { return [string]::Equals((Get-GatewayFullPath $Left), (Get-GatewayFullPath $Right), [StringComparison]::OrdinalIgnoreCase) } catch { return $false }
}
function Write-GatewayUtf8([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}
function Write-GatewayAtomicUtf8([string]$Path, [string]$Text) {
    $temporary = $Path + '.gateway-' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        Write-GatewayUtf8 $temporary $Text
        if (Test-Path -LiteralPath $Path) { [System.IO.File]::Replace($temporary, $Path, [System.Management.Automation.Language.NullString]::Value) }
        else { [System.IO.File]::Move($temporary, $Path) }
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}
function Get-GatewaySettings([string]$Root) {
    $settings = Get-Content -LiteralPath (Join-Path $Root 'private\settings.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $settings.port -or [int]$settings.port -lt 1 -or [int]$settings.port -gt 65535 -or $settings.routeToken -notmatch '^[A-Za-z0-9_-]{16,}$') {
        throw 'Gateway settings are incomplete. The encrypted credential and history have not been changed.'
    }
    return $settings
}
function Get-GatewayPowerShell {
    return (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe')
}
function Split-GatewayCommandLine([string]$CommandLine) {
    # All commands generated here use ordinary quoted Windows paths and no embedded quotes.
    return @([regex]::Matches($CommandLine, '(?:[^\s"]+|"[^"]*")+') | ForEach-Object { $_.Value.Trim('"') })
}
function Test-GatewayScriptArgument([object[]]$Arguments, [string]$Script) {
    # Reject -Command/-EncodedCommand and script parameters that merely mention our path.
    for ($index = 1; $index -lt ($Arguments.Count - 1); $index++) {
        if ($Arguments[$index] -ieq '-File') { return (Test-GatewaySamePath ([string]$Arguments[$index + 1]) $Script) }
        if ($Arguments[$index] -in @('-NoProfile','-NonInteractive')) { continue }
        if ($Arguments[$index] -ieq '-WindowStyle' -and $Arguments[$index + 1] -ieq 'Hidden') { $index++; continue }
        if ($Arguments[$index] -ieq '-ExecutionPolicy' -and $Arguments[$index + 1] -ieq 'Bypass') { $index++; continue }
        return $false
    }
    return $false
}
function Get-GatewayOwnedProcesses([string]$Root, [ValidateSet('runner','gateway','all')][string]$Kind = 'all') {
    $settings = Get-GatewaySettings $Root
    $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'powershell.exe' OR Name = 'pwsh.exe'" -ErrorAction Stop)
    foreach ($process in $processes) {
        if (-not $process.CommandLine -or -not $process.ExecutablePath) { continue }
        $arguments = @(Split-GatewayCommandLine $process.CommandLine)
        if ($Kind -ne 'gateway' -and (Test-GatewaySamePath $process.ExecutablePath (Get-GatewayPowerShell)) -and (Test-GatewayScriptArgument $arguments (Join-Path $Root 'runner.ps1'))) { $process; continue }
        if ($Kind -ne 'runner' -and (Test-GatewaySamePath $process.ExecutablePath $settings.nodePath) -and $arguments.Count -ge 2 -and (Test-GatewaySamePath ([string]$arguments[1]) (Join-Path $Root 'gateway.cjs'))) { $process }
    }
}
function Test-GatewayHealth([string]$Root) {
    try {
        $settings = Get-GatewaySettings $Root
        $owned = @(Get-GatewayOwnedProcesses $Root 'gateway')
        if ($owned.Count -ne 1) { return $false }
        $listeners = @(Get-NetTCPConnection -LocalPort ([int]$settings.port) -State Listen -ErrorAction Stop | Where-Object { $_.LocalAddress -eq '127.0.0.1' })
        if (-not ($listeners | Where-Object { $_.OwningProcess -eq $owned[0].ProcessId })) { return $false }
        $health = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $settings.port + '/health') -TimeoutSec 2 -UseBasicParsing
        if ($health.pid -and [int]$health.pid -ne [int]$owned[0].ProcessId) { return $false }
        if ($health.directory -and -not (Test-GatewaySamePath ([string]$health.directory) $Root)) { return $false }
        return ($health.ok -eq $true -and $health.service -eq 'codex-local-model-gateway')
    } catch { return $false }
}
function Get-GatewayMutex([string]$Root, [string]$Purpose = 'lifecycle') {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes((Get-GatewayFullPath $Root).ToLowerInvariant()))).Replace('-','') }
    finally { $sha.Dispose() }
    return (New-Object System.Threading.Mutex($false, ('Local\CodexModelGateway_' + $Purpose + '_' + $hash)))
}
function Stop-GatewayService([string]$Root) {
    $settings = Get-GatewaySettings $Root
    $enabled = Join-Path $Root 'private\enabled'
    if (Test-Path -LiteralPath $enabled) { Remove-Item -LiteralPath $enabled -Force }
    if ($settings.lifecycle -and $settings.lifecycle.startupMode -eq 'scheduledTask') {
        if (-not (Get-Command Stop-GatewayScheduledService -ErrorAction SilentlyContinue)) { throw 'The independent startup module is missing; use the emergency GPT recovery entry.' }
        Stop-GatewayScheduledService $Root | Out-Null
    }
    # Revalidate each PID against the executable and its complete script argument immediately before stopping it.
    foreach ($kind in @('runner','gateway')) {
        foreach ($process in @(Get-GatewayOwnedProcesses $Root $kind)) {
            $current = @(Get-GatewayOwnedProcesses $Root $kind | Where-Object { $_.ProcessId -eq $process.ProcessId -and $_.CreationDate -eq $process.CreationDate })
            if ($current.Count -eq 1) {
                Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
                Wait-Process -Id ([int]$process.ProcessId) -Timeout 8 -ErrorAction SilentlyContinue
            }
        }
    }
    if (@(Get-GatewayOwnedProcesses $Root).Count -gt 0) { throw 'The gateway could not be stopped safely.' }
    foreach ($name in @('runner.pid','gateway.pid')) {
        $pidFile = Join-Path $Root ('private\' + $name)
        if (Test-Path -LiteralPath $pidFile) { Remove-Item -LiteralPath $pidFile -Force }
    }
}
function Start-GatewayService([string]$Root, [int]$WaitSeconds = 45) {
    $Root = Get-GatewayFullPath $Root
    $settings = Get-GatewaySettings $Root
    if (-not (Test-Path -LiteralPath $settings.nodePath -PathType Leaf)) { throw 'The installed Node runtime is missing. Run the deployment script to repair the installation.' }
    $mutex = Get-GatewayMutex $Root 'start'
    $locked = $false
    try {
        try { $locked = $mutex.WaitOne([TimeSpan]::FromSeconds($WaitSeconds)) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { throw 'Another gateway start is still in progress.' }
        $scheduled = $settings.lifecycle -and $settings.lifecycle.startupMode -eq 'scheduledTask'
        if ((Test-GatewayHealth $Root) -and -not $scheduled) { return }
        Write-GatewayUtf8 (Join-Path $Root 'private\enabled') 'enabled'
        if ($settings.lifecycle -and $settings.lifecycle.startupMode -eq 'scheduledTask') {
            if (-not (Get-Command Run-GatewayScheduledService -ErrorAction SilentlyContinue)) { throw 'The independent startup module is missing; use the emergency GPT recovery entry.' }
            Register-GatewayScheduledService $Root | Out-Null
            Set-GatewayScheduledServiceEnabled $Root $true
            Run-GatewayScheduledService $Root | Out-Null
        } elseif (@(Get-GatewayOwnedProcesses $Root 'runner').Count -eq 0) {
            $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $Root 'runner.ps1') + '" -Directory "' + $Root + '"'
            Start-Process -FilePath (Get-GatewayPowerShell) -ArgumentList $arguments -WorkingDirectory $Root -WindowStyle Hidden | Out-Null
        }
        $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
        do {
            if (Test-GatewayHealth $Root) {
                if (-not $scheduled -or (Get-GatewayTaskState $Root).StateCode -eq 4) { return }
            }
            Start-Sleep -Milliseconds 350
        } while ([DateTime]::UtcNow -lt $deadline)
        throw 'The gateway did not pass its local health check. Open runtime.stderr.log in the installation folder for details.'
    } finally {
        if ($locked) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
function Get-GatewayRootLine([string]$Text, [string]$Name) {
    $table = [regex]::Match($Text, '(?m)^\s*\[')
    $rootText = if ($table.Success) { $Text.Substring(0, $table.Index) } else { $Text }
    $matches = [regex]::Matches($rootText, '(?m)^\s*' + [regex]::Escape($Name) + '\s*=.*$')
    if ($matches.Count -gt 1) { throw ('More than one root configuration entry exists for ' + $Name + '.') }
    if ($matches.Count) { return $matches[0].Value.TrimEnd("`r") }
    return $null
}
function Get-GatewayTomlValue([string]$Line) {
    if (-not $Line) { return $null }
    $match = [regex]::Match($Line, '^\s*[^=]+\s*=\s*''([^'']*)''\s*(?:#.*)?$')
    if ($match.Success) { return $match.Groups[1].Value }
    $match = [regex]::Match($Line, '^\s*[^=]+\s*=\s*("(?:\\.|[^"\\])*")\s*(?:#.*)?$')
    if ($match.Success) { return ($match.Groups[1].Value | ConvertFrom-Json) }
    throw 'A gateway configuration value has an unsupported format; no configuration was overwritten.'
}
function Set-GatewayRootLine([string]$Text, [string]$Name, [AllowNull()][string]$Line) {
    $table = [regex]::Match($Text, '(?m)^\s*\[')
    $rootText = if ($table.Success) { $Text.Substring(0, $table.Index) } else { $Text }
    $suffix = if ($table.Success) { $Text.Substring($table.Index) } else { '' }
    $pattern = '(?m)^\s*' + [regex]::Escape($Name) + '\s*=.*(?:\r?\n|$)'
    $newline = if ($Text.Contains("`r`n")) { "`r`n" } else { "`n" }
    $rootText = [regex]::Replace($rootText, $pattern, '')
    if ($Line) { $rootText = $Line + $newline + $rootText }
    return ($rootText + $suffix)
}
function ConvertTo-GatewayToml([string]$Value) {
    if (-not $Value.Contains("'")) { return ("'" + $Value + "'") }
    return ($Value | ConvertTo-Json -Compress)
}
function Get-GatewayConfigPath([object]$Settings, [string]$ExplicitPath) {
    if ($ExplicitPath) { return (Get-GatewayFullPath $ExplicitPath) }
    if ($Settings.lifecycle -and $Settings.lifecycle.configPath) { return [string]$Settings.lifecycle.configPath }
    if ($env:CODEX_HOME) { return (Join-Path $env:CODEX_HOME 'config.toml') }
    return (Join-Path $env:USERPROFILE '.codex\config.toml')
}
function Get-GatewayRunValue([string]$RunStateFile) {
    if ($RunStateFile) {
        if (Test-Path -LiteralPath $RunStateFile) { return ((Get-Content -LiteralPath $RunStateFile -Raw -Encoding UTF8 | ConvertFrom-Json).value) }
        return $null
    }
    $item = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'CodexLocalModelGateway' -ErrorAction SilentlyContinue
    if ($item) { return $item.CodexLocalModelGateway }
    return $null
}
function Set-GatewayRunValue([AllowNull()][string]$Value, [string]$RunStateFile) {
    if ($RunStateFile) { Write-GatewayUtf8 $RunStateFile (@{ value = $Value } | ConvertTo-Json); return }
    $runPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    if ($null -eq $Value -or $Value -eq '') { Remove-ItemProperty -LiteralPath $runPath -Name 'CodexLocalModelGateway' -ErrorAction SilentlyContinue }
    else {
        if (-not (Test-Path -LiteralPath $runPath)) { New-Item -Path $runPath -Force | Out-Null }
        New-ItemProperty -LiteralPath $runPath -Name 'CodexLocalModelGateway' -Value $Value -PropertyType String -Force | Out-Null
    }
}
function Test-GatewayOwnedRun([string]$Value, [string]$Root) {
    if (-not $Value) { return $false }
    $arguments = @(Split-GatewayCommandLine $Value)
    if (-not ($arguments.Count -gt 0 -and (Test-GatewaySamePath $arguments[0] (Get-GatewayPowerShell)))) { return $false }
    $roots = @($Root)
    try { $known = Get-GatewaySettings $Root; if ($known.lifecycle -and $known.lifecycle.ownedDirectories) { $roots += @($known.lifecycle.ownedDirectories) } } catch {}
    foreach ($candidate in $roots) { if (Test-GatewayScriptArgument $arguments (Join-Path $candidate 'start.ps1')) { return $true } }
    return $false
}

if (-not $LibraryOnly) { Start-GatewayService $Directory $TimeoutSeconds }
