[CmdletBinding()]
param([string]$Directory)
$ErrorActionPreference='Stop'
if (-not $PSBoundParameters.ContainsKey('Directory')) { $Directory=$PSScriptRoot }
. (Join-Path $PSScriptRoot 'lifecycle.ps1')
$identity=Get-GeminiBridgeIdentity $Directory
$metadata=Get-Content -LiteralPath (Join-Path $identity.Root 'bridge.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($metadata.product -cne 'CodexGeminiBridge' -or [int]$metadata.port -lt 1024 -or [int]$metadata.port -gt 65535) {
    throw 'The bridge metadata is invalid.'
}
$bridgePort=[int]$metadata.port
if (-not (Test-Path -LiteralPath $identity.Binary -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $identity.Root 'config.yaml') -PathType Leaf)) {
    throw 'The bridge executable or configuration is missing.'
}
if (-not ('CodexGeminiBridge.ChildLifetime' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace CodexGeminiBridge {
  public static class ChildLifetime {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
      public long ProcessUserTimeLimit, JobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
      public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
      public BasicLimit Basic;
      public IoCounters Io;
      public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetInformationJobObject(SafeFileHandle job, int kind, IntPtr data, uint size);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
    public static SafeFileHandle Create() {
      SafeFileHandle job=CreateJobObject(IntPtr.Zero,null);
      if(job.IsInvalid) throw new InvalidOperationException("Cannot create bridge child lifetime.");
      ExtendedLimit limits=new ExtendedLimit();
      limits.Basic.LimitFlags=0x00002000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      int size=Marshal.SizeOf(typeof(ExtendedLimit));
      IntPtr memory=Marshal.AllocHGlobal(size);
      try {
        Marshal.StructureToPtr(limits,memory,false);
        if(!SetInformationJobObject(job,9,memory,(uint)size)) {
          job.Dispose();
          throw new InvalidOperationException("Cannot set bridge child lifetime.");
        }
      } finally { Marshal.FreeHGlobal(memory); }
      return job;
    }
  }
}
'@
}
function Write-BridgeLifecycle($Record) {
    # Only caller-built lifecycle metadata is accepted. Child output is never logged.
    try {
        $private=Join-Path $identity.Root 'private'
        if (-not [IO.Directory]::Exists($private)) { return }
        $file=Join-Path $private 'lifecycle.jsonl'
        if ([IO.File]::Exists($file) -and ([IO.FileInfo]$file).Length -ge 65536) {
            $previous=$file+'.1'
            if ([IO.File]::Exists($previous)) { [IO.File]::Delete($previous) }
            [IO.File]::Move($file,$previous)
        }
        $entry=[ordered]@{time=[DateTime]::UtcNow.ToString('o')}
        foreach ($field in @('event','pid','exitCode','uptimeMs','restartCount','delaySeconds','reason')) {
            if ($Record.Contains($field)) { $entry[$field]=$Record[$field] }
        }
        [IO.File]::AppendAllText($file,($entry | ConvertTo-Json -Compress)+[Environment]::NewLine,(New-Object Text.UTF8Encoding($false)))
    } catch { } # A logging failure must not stop the local service.
}
function Test-BridgeSupervisionEnabled {
    # Re-check ownership before every spawn. A deliberate disabled/missing task
    # is never re-enabled by this runner, including during recovery backoff.
    $task=Find-GeminiBridgeTask (Get-GeminiBridgeScheduler) $identity
    return [bool]($task -and $task.Enabled)
}
$restartCount=0L
$failureStreak=0
Write-BridgeLifecycle ([ordered]@{event='runner_started';restartCount=$restartCount})
while (Test-BridgeSupervisionEnabled) {
    $existing=@(Get-GeminiBridgeListeners $bridgePort)
    if ($existing.Count -gt 0) {
        $foreign=@($existing | Where-Object { -not (Test-GeminiBridgeListenerOwned $_ $identity) })
        $reason=if ($foreign.Count -gt 0) { 'foreign_listener' } else { 'existing_listener' }
        Write-BridgeLifecycle ([ordered]@{event='runner_stopped';reason=$reason;restartCount=$restartCount})
        exit 0 # Never displace another listener or launch a duplicate child.
    }
    $job=$null
    $process=$null
    $started=$false
    $clock=[Diagnostics.Stopwatch]::StartNew()
    $exitCode=$null
    $reason='child_start_failed'
    try {
        # Each attempt owns its whole process tree. Closing this job also closes
        # inherited pipe handles when a child exits before one of its descendants.
        $job=[CodexGeminiBridge.ChildLifetime]::Create()
        $info=New-Object Diagnostics.ProcessStartInfo
        $info.FileName=$identity.Binary
        $info.Arguments=$identity.BinaryArguments
        $info.WorkingDirectory=$identity.Root
        $info.UseShellExecute=$false
        $info.CreateNoWindow=$true
        $info.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
        $info.RedirectStandardOutput=$true
        $info.RedirectStandardError=$true
        $process=New-Object Diagnostics.Process
        $process.StartInfo=$info
        if(-not $process.Start()){throw 'The bridge executable did not start.'}
        $started=$true
        if(-not [CodexGeminiBridge.ChildLifetime]::AssignProcessToJobObject($job,$process.Handle)) {
            # Kill by this already-open process handle, never by a recycled PID.
            $process.Kill()
            throw 'The bridge executable could not be attached to its managed lifetime.'
        }
        Write-BridgeLifecycle ([ordered]@{event='child_started';pid=$process.Id;restartCount=$restartCount})
        $stdout=$process.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
        $stderr=$process.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
        $process.WaitForExit()
        $exitCode=$process.ExitCode
        $reason='child_exited'
        $job.Dispose();$job=$null
        $stdout.GetAwaiter().GetResult() | Out-Null
        $stderr.GetAwaiter().GetResult() | Out-Null
    } catch {
        # No exception messages, provider stderr, prompts or tokens are persisted.
        if ($started -and $process -and -not $process.HasExited) {
            try { $process.Kill() } catch { }
        }
    } finally {
        $clock.Stop()
        if ($job) { $job.Dispose() }
        if ($process) { $process.Dispose() }
    }
    if ($clock.ElapsedMilliseconds -ge 60000) { $failureStreak=0 }
    $delay=[int][Math]::Min(30,[Math]::Pow(2,[Math]::Min(5,$failureStreak)))
    $failureStreak=[Math]::Min(6,$failureStreak+1)
    $restartCount++
    $record=[ordered]@{event=$reason;uptimeMs=$clock.ElapsedMilliseconds;restartCount=$restartCount;delaySeconds=$delay}
    if ($null -ne $exitCode) { $record.exitCode=$exitCode }
    Write-BridgeLifecycle $record
    # Intentional Stop disables the task before stopping this parent. All exits,
    # including code 0, otherwise receive bounded backoff instead of going idle.
    if (-not (Test-BridgeSupervisionEnabled)) { break }
    Start-Sleep -Seconds $delay
}
Write-BridgeLifecycle ([ordered]@{event='runner_stopped';reason='task_disabled_or_missing';restartCount=$restartCount})
