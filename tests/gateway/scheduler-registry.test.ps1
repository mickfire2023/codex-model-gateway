[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$module=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../gateway/scheduler.ps1'))
$Directory='parent-directory-must-not-change'
$LibraryOnly=$false
. $module -LibraryOnly
$fixtureRoot=Join-Path $PSScriptRoot ('scheduler-registry-fixture-'+[Guid]::NewGuid().ToString('N'))
$names=@()
$folder=$null
$assertions=0
function Assert-Scheduler([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message};$script:assertions++}
function Write-SchedulerFixture([string]$Path,[string]$Text){[IO.File]::WriteAllText($Path,$Text,(New-Object Text.UTF8Encoding($false)))}
function Wait-SchedulerState([string]$Path,[string]$State,[int]$Timeout=20){
    $deadline=[DateTime]::UtcNow.AddSeconds($Timeout)
    do {if(Test-Path -LiteralPath $Path){$value=$null;try{$value=Get-Content -Raw -LiteralPath $Path|ConvertFrom-Json}catch{};if($value.state -ceq $State){return $value};if($value.state -ceq 'failed'){throw ('Fixture controller failed: '+$value.error)}};Start-Sleep -Milliseconds 150}while([DateTime]::UtcNow -lt $deadline)
    throw ('Fixture did not reach '+$State)
}
function Wait-ControlReady([string]$Root,[string]$Kind){$deadline=[DateTime]::UtcNow.AddSeconds(5);do{if((Get-GatewayTaskState $Root $Kind).State -ne 'running'){return};Start-Sleep -Milliseconds 100}while([DateTime]::UtcNow-lt$deadline);throw 'Controller remained running.'}
try {
    Assert-Scheduler ($Directory -ceq 'parent-directory-must-not-change' -and -not $LibraryOnly) 'Loading scheduler changed the parent script parameters.'
    New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
    Copy-Item -LiteralPath $module -Destination (Join-Path $fixtureRoot 'scheduler.ps1')
    Write-SchedulerFixture (Join-Path $fixtureRoot 'runner.ps1') @'
param([string]$Directory)
$ErrorActionPreference='Stop'
$target=Join-Path $Directory 'runner.json'
$text=@{state='running';pid=$PID}|ConvertTo-Json -Compress
[IO.File]::WriteAllText($target,$text,(New-Object Text.UTF8Encoding($false)))
while($true){Start-Sleep -Milliseconds 200}
'@
    Write-SchedulerFixture (Join-Path $fixtureRoot 'control.ps1') @'
param([string]$Directory,[ValidateSet('restart','restore')][string]$Action)
$ErrorActionPreference='Stop'
trap{[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'control-fatal.json'),(@{error=$_.Exception.Message;location=$_.ScriptStackTrace}|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)));exit 1}
. (Join-Path $Directory 'scheduler.ps1') -LibraryOnly
$target=Join-Path $Directory ('control-'+$Action+'.json')
function Write-ControlFixture([string]$State,[string]$ErrorMessage){[IO.File]::WriteAllText($target,(@{state=$State;pid=$PID;action=$Action;error=$ErrorMessage}|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)))}
try{
    Write-ControlFixture 'running'
    if($Action -eq 'restore'){
        $old=(Get-Content -Raw -LiteralPath (Join-Path $Directory 'runner.json')|ConvertFrom-Json).pid
        Stop-GatewayScheduledService $Directory -Disable
        Wait-Process -Id ([int]$old) -Timeout 8 -ErrorAction SilentlyContinue
        if(Get-Process -Id ([int]$old) -ErrorAction SilentlyContinue){throw 'Old runner remained alive.'}
    }else{
        $runnerPath=Join-Path $Directory 'runner.json'
        $old=(Get-Content -Raw -LiteralPath $runnerPath|ConvertFrom-Json).pid
        Stop-GatewayScheduledService $Directory
        Run-GatewayScheduledService $Directory|Out-Null
        $deadline=[DateTime]::UtcNow.AddSeconds(12)
        do{$new=$old;try{$new=(Get-Content -Raw -LiteralPath $runnerPath|ConvertFrom-Json).pid}catch{};if($new -and $new -ne $old){break};Start-Sleep -Milliseconds 150}while([DateTime]::UtcNow -lt $deadline)
        if($new -eq $old){throw 'New runner did not become ready.'}
    }
    Write-ControlFixture 'succeeded'
}catch{Write-ControlFixture 'failed' $_.Exception.Message;exit 1}
'@
    $connection=Get-GatewaySchedulerConnection
    $folder=$connection.Folder
    foreach($kind in @('service','restart','restore')){$names+= (Get-GatewaySchedulerIdentity $fixtureRoot $kind).Name}
    Assert-Scheduler ((Get-GatewayTaskState $fixtureRoot).State -eq 'missing') 'Fixture task should initially be missing.'
    foreach($badRoot in @('', '.', 'relative/gateway','C:relative','\drive-relative',"C:\bad`nfolder")){ $rejected=$false;try{Get-GatewaySchedulerIdentity $badRoot|Out-Null}catch{$rejected=$true};Assert-Scheduler $rejected 'A relative/empty root was accepted.' }
    $emptySnapshot=Get-GatewayScheduledTaskSnapshot $fixtureRoot
    Register-GatewayScheduledService $fixtureRoot | Out-Null
    $task=Get-GatewayScheduledService $fixtureRoot
    Assert-Scheduler ([int]$task.Definition.Principal.LogonType -eq 3 -and [int]$task.Definition.Principal.RunLevel -eq 0) 'Service requires a password or elevation.'
    Assert-Scheduler ($task.Definition.Settings.ExecutionTimeLimit -eq 'PT0S') 'Persistent service has an execution deadline.'
    Assert-Scheduler (-not $task.Definition.Settings.DisallowStartIfOnBatteries -and -not $task.Definition.Settings.StopIfGoingOnBatteries) 'Battery settings can stop the service.'
    Assert-Scheduler ([int]$task.Definition.Settings.MultipleInstances -eq 2) 'Service can create duplicate instances.'
    Assert-Scheduler ([int]$task.Definition.Triggers.Count -eq 1 -and [int]$task.Definition.Triggers.Item(1).Type -eq 9) 'Service does not have its login trigger.'
    Run-GatewayScheduledService $fixtureRoot | Out-Null
    $first=Wait-SchedulerState (Join-Path $fixtureRoot 'runner.json') 'running'
    Assert-Scheduler ((Get-GatewayTaskState $fixtureRoot).State -eq 'running') 'Scheduled service did not run.'
    $activeSnapshot=Get-GatewayScheduledTaskSnapshot $fixtureRoot
    $activeRejected=$false
    try{Restore-GatewayScheduledTaskSnapshot $fixtureRoot $activeSnapshot|Out-Null}catch{$activeRejected=$true}
    Assert-Scheduler $activeRejected 'Snapshot restoration was allowed over an active task.'
    Run-GatewayScheduledService $fixtureRoot | Out-Null
    Start-Sleep -Milliseconds 450
    $same=Get-Content -Raw -LiteralPath (Join-Path $fixtureRoot 'runner.json')|ConvertFrom-Json
    Assert-Scheduler ([int]$same.pid -eq [int]$first.pid) 'Repeated service start created a duplicate.'
    Register-GatewayScheduledControl $fixtureRoot 'restart'|Out-Null
    Register-GatewayScheduledControl $fixtureRoot 'restore'|Out-Null
    Assert-Scheduler ([int](Get-GatewayScheduledControl $fixtureRoot 'restart').Definition.Triggers.Count -eq 0) 'A controller has an automatic trigger.'
    Run-GatewayScheduledControl $fixtureRoot 'restart'|Out-Null
    $restart=Wait-SchedulerState (Join-Path $fixtureRoot 'control-restart.json') 'succeeded'
    Wait-ControlReady $fixtureRoot 'restart'
    $second=Get-Content -Raw -LiteralPath (Join-Path $fixtureRoot 'runner.json')|ConvertFrom-Json
    Assert-Scheduler ([int]$second.pid -ne [int]$first.pid) 'Controller did not restart its service task.'
    Assert-Scheduler (-not (Get-Process -Id ([int]$first.pid) -ErrorAction SilentlyContinue)) 'The old runner process remains.'
    Assert-Scheduler ([int]$restart.pid -ne [int]$first.pid -and [int]$restart.pid -ne [int]$second.pid) 'Controller was not independent from the service task.'
    Run-GatewayScheduledControl $fixtureRoot 'restore'|Out-Null
    $restore=Wait-SchedulerState (Join-Path $fixtureRoot 'control-restore.json') 'succeeded'
    Wait-ControlReady $fixtureRoot 'restore'
    Assert-Scheduler ((Get-GatewayTaskState $fixtureRoot).State -eq 'disabled') 'Recovery did not disable future login starts.'
    Assert-Scheduler (-not (Get-Process -Id ([int]$second.pid) -ErrorAction SilentlyContinue)) 'Recovery left its service running.'
    Set-GatewayScheduledServiceEnabled $fixtureRoot $true
    Run-GatewayScheduledService $fixtureRoot|Out-Null
    Start-Sleep -Milliseconds 750
    Assert-Scheduler ((Get-GatewayTaskState $fixtureRoot).State -eq 'running') 'Re-enabling did not restart the task.'
    Stop-GatewayScheduledService $fixtureRoot
    Assert-Scheduler ((Get-GatewayTaskState $fixtureRoot).State -eq 'ready') 'A normal stop disabled future login starts.'
    $snapshot=Get-GatewayScheduledTaskSnapshot $fixtureRoot
    Set-GatewayScheduledServiceEnabled $fixtureRoot $false
    Restore-GatewayScheduledTaskSnapshot $fixtureRoot $snapshot|Out-Null
    Assert-Scheduler ((Get-GatewayTaskState $fixtureRoot).State -eq 'ready') 'Task XML snapshot did not restore its enabled state.'
    Remove-Item -LiteralPath (Join-Path $fixtureRoot 'control-restore.json') -Force
    $cliArgs='-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+(Join-Path $fixtureRoot 'scheduler.ps1')+'" -ControlAction restore'
    $cli=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') -ArgumentList $cliArgs -WindowStyle Hidden -PassThru
    try{$null=$cli.Handle;if(-not$cli.WaitForExit(15000)){throw 'Scheduler CLI timed out.'};Assert-Scheduler ($cli.ExitCode -eq 0) 'Scheduler CLI failed to register/run control.'}finally{$cli.Dispose()}
    Wait-SchedulerState (Join-Path $fixtureRoot 'control-restore.json') 'succeeded'|Out-Null
    Wait-ControlReady $fixtureRoot 'restore'
    Assert-Scheduler ((Get-GatewayTaskState $fixtureRoot).State -eq 'disabled') 'Scheduler CLI did not use its script directory default.'
    Restore-GatewayScheduledTaskSnapshot $fixtureRoot $emptySnapshot
    Assert-Scheduler ((Get-GatewayTaskState $fixtureRoot).State -eq 'missing') 'An empty snapshot did not remove the owned task.'
    $identity=Get-GatewaySchedulerIdentity $fixtureRoot 'service'
    $foreign=New-GatewayScheduledDefinition $connection $identity
    $foreign.RegistrationInfo.Description='Deliberately foreign synthetic fixture'
    $folder.RegisterTaskDefinition($identity.Name,$foreign,6,$identity.Sid,$null,3,$null)|Out-Null
    $originalXml=[string]$folder.GetTask($identity.Name).Xml
    foreach($operation in @('register','restore','remove')){
      $rejected=$false
      try {if($operation -eq 'register'){Register-GatewayScheduledService $fixtureRoot|Out-Null}elseif($operation -eq 'restore'){Restore-GatewayScheduledTaskSnapshot $fixtureRoot $snapshot|Out-Null}else{Remove-GatewayScheduledService $fixtureRoot}}catch{$rejected=$true}
      Assert-Scheduler $rejected ('A foreign task was accepted during '+$operation)
      Assert-Scheduler ([string]$folder.GetTask($identity.Name).Xml -ceq $originalXml) 'A foreign task changed.'
    }
    [pscustomobject]@{Passed=$true;Assertions=$assertions;ServiceIndependent=$true;ControllerSurvivedServiceStop=$true;ForeignTaskProtected=$true;SnapshotsPassed=$true}|ConvertTo-Json
} catch {
    [pscustomobject]@{Passed=$false;Assertions=$assertions;Error=$_.Exception.Message;Location=$_.ScriptStackTrace}|ConvertTo-Json
    foreach($file in @(Get-ChildItem -LiteralPath $fixtureRoot -File -Filter 'control-*.json' -ErrorAction SilentlyContinue)){Get-Content -Raw -LiteralPath $file.FullName}
    if($folder){foreach($name in $names){try{$t=$folder.GetTask($name);[pscustomobject]@{Kind=$t.Definition.RegistrationInfo.Description.Split('|')[1];State=$t.State;Result=$t.LastTaskResult;Instances=$t.GetInstances(0).Count}|ConvertTo-Json}catch{}}}
    throw
} finally {
    if($folder){foreach($name in $names){try{$folder.GetTask($name).Stop(0)}catch{};try{$folder.DeleteTask($name,0)}catch{}}}
    Start-Sleep -Milliseconds 300
    $resolved=[IO.Path]::GetFullPath($fixtureRoot)
    $expected=[IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')+'\scheduler-registry-fixture-'
    if($resolved.StartsWith($expected,[StringComparison]::OrdinalIgnoreCase)-and (Test-Path -LiteralPath $resolved)){try{Remove-Item -LiteralPath $resolved -Recurse -Force}catch{Write-Warning 'Fixture directory remains in use; no unrelated process was stopped.'}}
}
