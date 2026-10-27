[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$root=Join-Path ([IO.Path]::GetTempPath()) ('codex-binary-upgrade-fixture-'+[Guid]::NewGuid().ToString('N'))
$installed=Join-Path $root 'installed'
$release=Join-Path $root 'source'
$checks=0
$identity=$null
function Check-BinaryUpgrade([bool]$Value,[string]$Message){if(-not $Value){throw $Message};$script:checks++}
function Hash-BinaryUpgrade([string]$Path){return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function Write-BinaryUpgrade([string]$Path,[string]$Text){[IO.File]::WriteAllText($Path,$Text,(New-Object Text.UTF8Encoding($false)))}
function Invoke-BinaryUpgrade([string]$Binary){
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $info.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+(Join-Path $release 'scripts\repair-gemini.ps1')+'" -BridgeDirectory "'+$installed+'" -BinaryPath "'+$Binary+'"'
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $process=New-Object Diagnostics.Process;$process.StartInfo=$info
    try{
        if(-not $process.Start()){throw 'The synthetic binary-upgrade process did not start.'}
        $out=$process.StandardOutput.ReadToEndAsync();$err=$process.StandardError.ReadToEndAsync()
        if(-not $process.WaitForExit(60000)){$process.Kill();$process.WaitForExit();throw 'The synthetic binary-upgrade process exceeded its bound.'}
        return [pscustomobject]@{Code=$process.ExitCode;Output=$out.Result;ErrorOutput=$err.Result}
    }finally{$process.Dispose()}
}
try{
    foreach($path in @($installed,(Join-Path $installed 'private\auth'),(Join-Path $release 'bridge'),(Join-Path $release 'scripts'))){New-Item -ItemType Directory -Path $path -Force|Out-Null}
    foreach($file in Get-ChildItem -LiteralPath (Join-Path $repository 'bridge') -File){
        Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $release ('bridge\'+$file.Name))
        Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $installed $file.Name)
    }
    Copy-Item -LiteralPath (Join-Path $repository 'scripts\repair-gemini.ps1') -Destination (Join-Path $release 'scripts\repair-gemini.ps1')
    $probe=@'
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;
public static class SyntheticBinaryUpgradeBridge {
    public static void Main(string[] args) {
        string config=null;
        for(int i=0;i+1<args.Length;i++) if(args[i]=="-config") config=args[i+1];
        if(config==null) Environment.Exit(2);
        int port=Int32.Parse(Regex.Match(File.ReadAllText(config),@"port:\s*(\d+)").Groups[1].Value);
        TcpListener listener=new TcpListener(IPAddress.Loopback,port);
        listener.Start();
        while(true) using(TcpClient client=listener.AcceptTcpClient()) { }
    }
}
'@
    $old=Join-Path $root 'old.exe'
    $new=Join-Path $root 'new.exe'
    $bad=Join-Path $root 'rollback-candidate.exe'
    Add-Type -TypeDefinition $probe -OutputAssembly $old -OutputType ConsoleApplication
    [IO.File]::WriteAllBytes($new,([IO.File]::ReadAllBytes($old)+[byte]0))
    [IO.File]::WriteAllBytes($bad,([IO.File]::ReadAllBytes($old)+[byte]1))
    $manifest=@{version=1;product='CLIProxyAPI';official=@{release='synthetic-old';sha256=(Hash-BinaryUpgrade $old);claudeQ19=$false};patched=@{release='synthetic-new';sha256=(Hash-BinaryUpgrade $new);claudeQ19=$true}}
    Write-BinaryUpgrade (Join-Path $release 'bridge\binary-manifest.json') ($manifest|ConvertTo-Json -Depth 5)
    Copy-Item -LiteralPath $old -Destination (Join-Path $installed 'cli-proxy-api.exe')
    $listener=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0);$listener.Start();$port=$listener.LocalEndpoint.Port;$listener.Stop()
    Write-BinaryUpgrade (Join-Path $installed 'config.yaml') ('port: '+$port)
    Write-BinaryUpgrade (Join-Path $installed 'private\auth\synthetic.json') 'SYNTHETIC_ACCOUNT_BYTES_ONLY'
    Write-BinaryUpgrade (Join-Path $installed 'private\control.json') '{"synthetic":"not a real credential"}'
    Write-BinaryUpgrade (Join-Path $installed 'bridge.json') (@{product='CodexGeminiBridge';port=$port;release='synthetic-old';binarySha256=(Hash-BinaryUpgrade $old);claudeSignatureChannels=@(18)}|ConvertTo-Json -Depth 4)
    . (Join-Path $release 'bridge\lifecycle.ps1')
    $identity=Get-GeminiBridgeIdentity $installed
    $preserved=@{}
    foreach($file in @('config.yaml','private\auth\synthetic.json','private\control.json')){$preserved[$file]=Hash-BinaryUpgrade (Join-Path $installed $file)}
    $state=Start-GeminiBridge $installed $port 20
    Check-BinaryUpgrade ($state.Listening -and $state.TaskActive) 'Synthetic original binary did not start.'
    $taskBefore=Get-GeminiBridgeTaskSnapshot $installed
    $result=Invoke-BinaryUpgrade $new
    Check-BinaryUpgrade ($result.Code -eq 0) ('Pinned synthetic binary upgrade failed: '+$result.ErrorOutput)
    Check-BinaryUpgrade ((Hash-BinaryUpgrade (Join-Path $installed 'cli-proxy-api.exe')) -ceq $manifest.patched.sha256) 'The new executable bytes were not installed.'
    $metadata=Get-Content -LiteralPath (Join-Path $installed 'bridge.json') -Raw|ConvertFrom-Json
    Check-BinaryUpgrade ($metadata.release -ceq 'synthetic-new' -and $metadata.binarySha256 -ceq $manifest.patched.sha256 -and ($metadata.claudeSignatureChannels -join ',') -ceq '18,19') 'Patched executable metadata was not updated.'
    Check-BinaryUpgrade ((Get-GeminiBridgeStatus $installed $port).Listening -and (Get-GeminiBridgeTaskSnapshot $installed).Xml -ceq $taskBefore.Xml) 'Enabled upgrade lost the service or task definition.'
    foreach($file in $preserved.Keys){Check-BinaryUpgrade ((Hash-BinaryUpgrade (Join-Path $installed $file)) -ceq $preserved[$file]) 'Binary upgrade changed synthetic configuration or account bytes.'}
    $before=Get-GeminiBridgeStatus $installed $port
    $unknown=Join-Path $root 'unknown.exe';[IO.File]::WriteAllBytes($unknown,([IO.File]::ReadAllBytes($old)+[byte]2))
    $metadataBefore=Hash-BinaryUpgrade (Join-Path $installed 'bridge.json')
    $result=Invoke-BinaryUpgrade $unknown
    Check-BinaryUpgrade ($result.Code -ne 0) 'An executable outside the reviewed synthetic manifest was accepted.'
    $after=Get-GeminiBridgeStatus $installed $port
    Check-BinaryUpgrade ($after.Listening -and $after.ProcessIds[0] -eq $before.ProcessIds[0] -and (Hash-BinaryUpgrade (Join-Path $installed 'bridge.json')) -ceq $metadataBefore) 'Invalid binary validation stopped or changed the original service.'
    Stop-GeminiBridge $installed $port|Out-Null
    $disabled=Get-GeminiBridgeTaskSnapshot $installed
    $result=Invoke-BinaryUpgrade $old
    Check-BinaryUpgrade ($result.Code -eq 0) 'Pinned synthetic binary upgrade failed while explicitly stopped.'
    $state=Get-GeminiBridgeStatus $installed $port
    Check-BinaryUpgrade (-not $state.TaskEnabled -and -not $state.TaskActive -and -not $state.Listening -and (Get-GeminiBridgeTaskSnapshot $installed).Xml -ceq $disabled.Xml) 'A binary upgrade re-enabled an explicitly stopped service.'
    $metadata=Get-Content -LiteralPath (Join-Path $installed 'bridge.json') -Raw|ConvertFrom-Json
    Check-BinaryUpgrade ($metadata.release -ceq 'synthetic-old' -and ($metadata.claudeSignatureChannels -join ',') -ceq '18') 'Official binary metadata retained patched-only signature channels.'
    Start-GeminiBridge $installed $port 20|Out-Null
    $rollbackTask=Get-GeminiBridgeTaskSnapshot $installed
    $rollbackMetadata=Hash-BinaryUpgrade (Join-Path $installed 'bridge.json')
    $rollbackRunner=Hash-BinaryUpgrade (Join-Path $installed 'runner.ps1')
    $manifest.patched.sha256=Hash-BinaryUpgrade $bad;$manifest.patched.release='synthetic-will-fail'
    Write-BinaryUpgrade (Join-Path $release 'bridge\binary-manifest.json') ($manifest|ConvertTo-Json -Depth 5)
    Write-BinaryUpgrade (Join-Path $release 'bridge\runner.ps1') "throw 'Synthetic replacement deliberately fails readiness.'"
    $result=Invoke-BinaryUpgrade $bad
    Check-BinaryUpgrade ($result.Code -ne 0) 'The deliberately broken runner was reported as an upgrade success.'
    Check-BinaryUpgrade ((Hash-BinaryUpgrade (Join-Path $installed 'cli-proxy-api.exe')) -ceq (Hash-BinaryUpgrade $old)) 'Failed upgrade did not restore original executable bytes.'
    Check-BinaryUpgrade ((Hash-BinaryUpgrade (Join-Path $installed 'bridge.json')) -ceq $rollbackMetadata -and (Hash-BinaryUpgrade (Join-Path $installed 'runner.ps1')) -ceq $rollbackRunner) 'Failed upgrade did not restore metadata and helper bytes.'
    $state=Get-GeminiBridgeStatus $installed $port
    Check-BinaryUpgrade ($state.TaskEnabled -and $state.TaskActive -and $state.Listening -and (Get-GeminiBridgeTaskSnapshot $installed).Xml -ceq $rollbackTask.Xml) 'Failed upgrade did not restore the enabled task and working service.'
    foreach($file in $preserved.Keys){Check-BinaryUpgrade ((Hash-BinaryUpgrade (Join-Path $installed $file)) -ceq $preserved[$file]) 'Failed binary upgrade changed synthetic configuration or account bytes.'}
    [pscustomobject]@{passed=$checks;syntheticOnly=$true;externalRequests=0;binaryAndMetadataRollback=$true}|ConvertTo-Json -Compress
}finally{
    if($identity){Stop-GeminiBridge $installed $port -RemoveTask|Out-Null}
    $absolute=[IO.Path]::GetFullPath($root)
    $parent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([char[]]'\/')
    if(-not $absolute.StartsWith($parent+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or -not ([IO.Path]::GetFileName($absolute)).StartsWith('codex-binary-upgrade-fixture-')){throw 'Binary-upgrade fixture cleanup escaped its temporary parent.'}
    if(Test-Path -LiteralPath $absolute){Remove-Item -LiteralPath $absolute -Recurse -Force}
}
