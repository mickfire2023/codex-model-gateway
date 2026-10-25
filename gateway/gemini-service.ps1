[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Directory,[ValidateRange(1024,65535)][int]$Port,[ValidateRange(1,30)][int]$WaitSeconds=20)
$ErrorActionPreference='Stop'
try {
    . (Join-Path $Directory 'lifecycle.ps1')
    $identity=Get-GeminiBridgeIdentity $Directory
    $metadata=Get-Content -LiteralPath (Join-Path $identity.Root 'bridge.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($metadata.product -cne 'CodexGeminiBridge' -or [int]$metadata.port -ne $Port) { exit 24 }
    $connection=Get-GeminiBridgeScheduler
    $deadline=[DateTime]::UtcNow.AddSeconds($WaitSeconds)
    $requested=$false
    do {
        $state=Get-GeminiBridgeStatus $identity.Root $Port
        if ($state.ForeignListener) { exit 22 }
        $task=Find-GeminiBridgeTask $connection $identity
        if (-not $task) { exit 21 }
        # Recovery never registers a task or re-enables an explicitly stopped service.
        if (-not [bool]$task.Enabled) { exit 20 }
        if ($state.Listening -and $state.TaskActive) { Write-Output '{"ready":true}'; exit 0 }
        if (@($state.OwnedProcessIds).Count -gt 0 -and -not $state.TaskActive) { exit 23 }
        if (-not $requested -and -not (Test-GeminiBridgeTaskActive $task)) { $task.Run($null) | Out-Null; $requested=$true }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    exit 23
} catch { exit 24 }
