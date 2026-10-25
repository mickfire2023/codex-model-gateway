[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $repo 'gateway\start.ps1') -Directory (Join-Path $repo 'gateway') -LibraryOnly
$logical=Join-Path ([IO.Path]::GetTempPath()) ('gateway fresh '+[char]0x4e2d+[char]0x6587+' '+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $logical | Out-Null
$fixture=Get-GatewayPhysicalPath $logical
$installed=Join-Path $fixture 'installed'
$broken=Join-Path $fixture 'failed-install'
$config=Join-Path $fixture 'config.toml'
$auth=Join-Path $fixture 'auth.json'
$count=0
function Check([bool]$ok,[string]$message) { if (-not $ok) { throw $message }; $script:count++ }
function FreePort { $l=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0);$l.Start();$p=$l.LocalEndpoint.Port;$l.Stop();return $p }
function Install([string]$Source,[string]$Destination,[string]$Configuration,[int]$LocalPort) {
    $p=New-Object Diagnostics.ProcessStartInfo
    $p.FileName=Get-GatewayPowerShell
    $p.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+(Join-Path $Source 'install.ps1')+'" -InstallDirectory "'+$Destination+'" -ConfigPath "'+$Configuration+'" -Port '+$LocalPort+' -SkipShortcuts -NodePath "'+(Get-Command node.exe).Source+'"'
    $p.WorkingDirectory=$fixture;$p.UseShellExecute=$false;$p.CreateNoWindow=$true;$p.WindowStyle='Hidden';$p.RedirectStandardOutput=$true;$p.RedirectStandardError=$true
    $child=[Diagnostics.Process]::Start($p);$stdout=$child.StandardOutput.ReadToEndAsync();$stderr=$child.StandardError.ReadToEndAsync()
    if (-not $child.WaitForExit(180000)) { $child.Kill();throw 'Isolated installation timed out.' }
    return @{code=$child.ExitCode;output=$stdout.Result;error=$stderr.Result}
}
$original="model = 'gpt-synthetic'`r`n[plugins.synthetic]`r`nenabled = true`r`n"
Write-GatewayUtf8 $config $original
Write-GatewayUtf8 $auth '{"synthetic":"no real credentials"}'
$authHash=(Get-FileHash -LiteralPath $auth -Algorithm SHA256).Hash
Write-GatewayUtf8 (Join-Path $fixture 'models_cache.json') '{"models":[{"slug":"gpt-synthetic","display_name":"Synthetic GPT","visibility":"list"}]}'
try {
    $port=FreePort
    $first=Install $repo $installed $config $port
    Check ($first.code -eq 0) ('Fresh installation failed: '+$first.error)
    Check (Test-GatewayHealth $installed) 'New independent service is unhealthy.'
    $settings=Get-GatewaySettings $installed
    Check ($settings.routeToken -match '^[a-f0-9]{64}$') 'A fresh random local token was not generated.'
    Check ($settings.codexDirectory -eq $fixture) 'The supplied Codex home was not persisted.'
    Check ([IO.File]::ReadAllText($config).Contains('openai_base_url')) 'Codex was not connected after readiness.'
    Check ([IO.File]::ReadAllText($config).Contains("model = 'gpt-synthetic'")) 'The default model changed.'
    Check ((Get-FileHash -LiteralPath $auth -Algorithm SHA256).Hash -eq $authHash) 'Auth file changed.'
    $models=Get-Content -LiteralPath (Join-Path $installed 'openai-models.json') -Raw | ConvertFrom-Json
    Check ($models.models[0].slug -eq 'gpt-synthetic') 'Account cache was lost to an empty source seed.'
    Write-GatewayUtf8 (Join-Path $installed 'private\retained.txt') 'synthetic-private-state'
    $second=Install $repo $installed $config $port
    Check ($second.code -eq 0) ('Preserving upgrade failed: '+$second.error)
    Check (Test-GatewayHealth $installed) 'Upgraded service is unhealthy.'
    $after=Get-GatewaySettings $installed
    Check ($after.routeToken -ceq $settings.routeToken) 'Upgrade replaced the existing local token.'
    Check ([IO.File]::ReadAllText((Join-Path $installed 'private\retained.txt')) -ceq 'synthetic-private-state') 'Upgrade lost private state.'
    $models=Get-Content -LiteralPath (Join-Path $installed 'openai-models.json') -Raw | ConvertFrom-Json
    Check ($models.models[0].slug -eq 'gpt-synthetic') 'Upgrade lost the last known account catalog.'
    & (Join-Path $installed 'restore.ps1') -Directory $installed -ConfigPath $config
    Check (-not [IO.File]::ReadAllText($config).Contains('openai_base_url')) 'Direct connection was not restored.'
    Check ([IO.File]::ReadAllText($config).Contains('[plugins.synthetic]')) 'An unrelated setting was lost.'
    # Reject an occupied port before any configuration mutation.
    $held=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0);$held.Start()
    try { $bad=Install $repo $broken $config $held.LocalEndpoint.Port;Check ($bad.code -ne 0) 'An occupied listener was accepted.' } finally { $held.Stop() }
    Check (-not [IO.File]::ReadAllText($config).Contains('openai_base_url')) 'Failed install changed Codex.'
    Check ((Get-FileHash -LiteralPath $auth -Algorithm SHA256).Hash -eq $authHash) 'Failed install changed authentication.'
    Write-Output ('Fresh installation and preserving upgrade passed '+$count+' assertions.')
} finally {
    $cleanupErrors=New-Object Collections.Generic.List[string]
    foreach ($target in @($installed,$broken)) {
        if (Test-Path -LiteralPath (Join-Path $target 'private\settings.json')) {
            try { Stop-GatewayService $target; Remove-GatewayScheduledService $target | Out-Null } catch { $cleanupErrors.Add('An isolated test service could not be cleaned up.') }
        }
    }
    if ($cleanupErrors.Count) { throw ($cleanupErrors -join ' ') }
    $absolute=[IO.Path]::GetFullPath($fixture)
    $parent=[IO.Path]::GetFullPath((Split-Path -Parent $absolute)).TrimEnd([char[]]'\/')
    if ($absolute.StartsWith($parent+'\',[StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $absolute).StartsWith('gateway fresh ')) { Remove-Item -LiteralPath $absolute -Recurse -Force }
}
