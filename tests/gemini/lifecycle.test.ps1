[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\bridge'))
$fixture = Join-Path $PSScriptRoot ('fixture ' + [char]0x6d4b + [char]0x8bd5 + ' ' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
foreach($file in @('lifecycle.ps1','start.ps1','stop.ps1','status.ps1','runner.ps1')) { Copy-Item -LiteralPath (Join-Path $source $file) -Destination (Join-Path $fixture $file) }
$listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0)
$listener.Start()
$testPort = [int]$listener.LocalEndpoint.Port
$listener.Stop()
[IO.File]::WriteAllText((Join-Path $fixture 'config.yaml'), ('server:' + "`n" + '  host: "127.0.0.1"' + "`n" + '  port: ' + $testPort + "`n"), [Text.Encoding]::ASCII)
$fake = @'
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
class Fixture {
  public static void Main(string[] args) {
    string config = null;
    for (int i=0;i+1<args.Length;i++) if(args[i]=="-config") config=args[i+1];
    if(config==null) Environment.Exit(2);
    int port=Int32.Parse(Regex.Match(File.ReadAllText(config), @"port:\s*(\d+)").Groups[1].Value);
    TcpListener server=new TcpListener(IPAddress.Loopback,port);
    server.Start();
    while(true) {
      using(TcpClient client=server.AcceptTcpClient()) {
        byte[] body=Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"data\":[]}");
        client.GetStream().Write(body,0,body.Length);
      }
    }
  }
}
'@
Add-Type -TypeDefinition $fake -OutputAssembly (Join-Path $fixture 'cli-proxy-api.exe') -OutputType ConsoleApplication
. (Join-Path $source 'lifecycle.ps1')
$identity=Get-GeminiBridgeIdentity $fixture
$assertions=0
function Assert([bool]$Condition,[string]$Message) { if(-not $Condition){throw ('ASSERT: '+$Message)}; $script:assertions++ }
$ps5=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
function Invoke-Entry([string]$Name,[string[]]$Extra) {
    Push-Location $env:SystemRoot
    try {
        $output=& $ps5 -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $fixture $Name) -Port $testPort @Extra 2>&1
        if($LASTEXITCODE -ne 0){throw ('Entry failed: '+$Name+' '+($output -join "`n"))}
        return (($output -join "`n") | ConvertFrom-Json)
    } finally { Pop-Location }
}
try {
    Assert ($identity.Root -ceq $fixture) 'Unicode physical directory unchanged'
    Assert (-not (Get-GeminiBridgeStatus $fixture $testPort).TaskExists) 'starts without task'
    $state=Invoke-Entry 'start.ps1' @()
    Assert ($state.Listening -and $state.TaskActive) 'PS5 omitted Directory starts from different CWD'
    Assert (-not $state.ForeignListener) 'loopback listener belongs to exact binary and config'
    Assert ($state.TaskState -eq 'running') 'task running'
    $firstPid=[int]$state.ProcessIds[0]
    $process=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$firstPid)
    Assert ([int]$process.ParentProcessId -ne $PID) 'listener independent of test launcher'
    $task=Find-GeminiBridgeTask (Get-GeminiBridgeScheduler) $identity
    Assert ([int]$task.Definition.Principal.LogonType -eq 3) 'interactive token no stored password'
    Assert ([int]$task.Definition.Principal.RunLevel -eq 0) 'no elevation'
    Assert ([string]$task.Definition.Settings.ExecutionTimeLimit -eq 'PT0S') 'no automatic timeout'
    Assert ([int]$task.Definition.Triggers.Count -eq 1 -and [int]$task.Definition.Triggers.Item(1).Type -eq 9) 'login trigger'
    Assert ([string]$task.Definition.Actions.Item(1).Arguments -ceq $identity.Arguments) 'exact config and local-model args'
    Assert ($identity.BinaryArguments -ceq ('-config "'+(Join-Path $fixture 'config.yaml')+'" -local-model')) 'fixed upstream arguments'
    Assert ($identity.Arguments -match '-WindowStyle Hidden') 'scheduled runner hidden'
    Assert ([string]$task.Definition.Actions.Item(1).WorkingDirectory -ceq $fixture) 'exact working directory'
    $repeat=Invoke-Entry 'start.ps1' @()
    Assert ([int]$repeat.ProcessIds[0] -eq $firstPid) 'start idempotent no extra listener'
    $state=Invoke-Entry 'stop.ps1' @()
    Assert (-not $state.Listening -and -not $state.TaskActive) 'PS5 omitted Directory stop'
    Assert (-not $state.TaskEnabled) 'stop disables future auto restart'
    $state=Invoke-Entry 'stop.ps1' @()
    Assert (-not $state.Listening) 'repeat stop succeeds'
    $state=Invoke-Entry 'status.ps1' @()
    Assert ($state.TaskState -eq 'disabled') 'status no creds from different CWD'
    foreach($bad in @('', '.', 'C:relative', "C:\bad`npath", 'C:\')) {
        $rejected=$false
        try { Get-GeminiBridgeRoot $bad | Out-Null } catch { $rejected=$true }
        Assert $rejected 'invalid installation directory rejected'
    }
    for($n=0;$n -lt 2;$n++) {
        $state=Start-GeminiBridge $fixture $testPort 20
        Assert ($state.Listening -and $state.TaskActive) 'restart listener recovered'
        Assert ([int]$state.ProcessIds[0] -ne $firstPid) 'restart has fresh process'
        $state=Stop-GeminiBridge $fixture $testPort
        Assert (-not $state.TaskActive -and -not $state.Listening) 'stop settles before next start'
    }
    $occupied=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,$testPort)
    $occupied.Start()
    try {
        $blocked=$false
        try { Start-GeminiBridge $fixture $testPort 2 | Out-Null } catch { $blocked=$true }
        Assert $blocked 'occupied foreign port rejected'
        $state=Get-GeminiBridgeStatus $fixture $testPort
        Assert (-not $state.TaskActive -and $state.ForeignListener) 'foreign listener left running and managed task inactive'
    } finally { $occupied.Stop() }
    $unready=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0)
    $unready.Start()
    $wrongPort=[int]$unready.LocalEndpoint.Port
    $unready.Stop()
    $failed=$false
    try { Start-GeminiBridge $fixture $wrongPort 2 | Out-Null } catch { $failed=$true }
    Assert $failed 'readiness failure is reported'
    $state=Get-GeminiBridgeStatus $fixture $testPort
    Assert (-not $state.TaskActive -and -not $state.Listening -and -not $state.TaskEnabled) 'failed start stops own task and process'
    $connection=Get-GeminiBridgeScheduler
    $task=Find-GeminiBridgeTask $connection $identity
    $definition=$task.Definition
    $definition.RegistrationInfo.Description='unrelated fixture owner'
    $connection.Folder.RegisterTaskDefinition($identity.Name,$definition,6,$identity.Sid,$null,3,$null)|Out-Null
    $blocked=$false
    try{ Start-GeminiBridge $fixture $testPort 2 | Out-Null }catch{$blocked=$true}
    Assert $blocked 'foreign same-name task cannot be overwritten'
    $blocked=$false
    try{ Stop-GeminiBridge $fixture $testPort | Out-Null }catch{$blocked=$true}
    Assert $blocked 'foreign same-name task cannot be stopped'
    $task=$connection.Folder.GetTask($identity.Name)
    Assert ([string]$task.Definition.RegistrationInfo.Description -eq 'unrelated fixture owner') 'foreign definition preserved'
    # This exact inactive fixture task was intentionally re-labelled above; restore only its test marker.
    $definition=$task.Definition
    $definition.RegistrationInfo.Description=$identity.Marker
    $connection.Folder.RegisterTaskDefinition($identity.Name,$definition,6,$identity.Sid,$null,3,$null)|Out-Null
    $state=Stop-GeminiBridge $fixture $testPort -RemoveTask
    Assert (-not $state.TaskExists) 'owned task removal'
    [pscustomobject]@{passed=$assertions;fixture=$fixture;port=$testPort;taskRemoved=$true}|ConvertTo-Json -Compress
} finally {
    $connection=Get-GeminiBridgeScheduler
    try {
        $task=$connection.Folder.GetTask($identity.Name)
        $action=$task.Definition.Actions.Item(1)
        if([string]$action.Path -ceq $identity.Executable -and [string]$action.Arguments -ceq $identity.Arguments -and [string]$action.WorkingDirectory -ceq $fixture) {
            $task.Enabled=$false
            try{$task.Stop(0)}catch{}
            $connection.Folder.DeleteTask($identity.Name,0)
        }
    } catch { if(($_.Exception.HResult -band 0xffff) -notin @(2,3)){throw} }
}
