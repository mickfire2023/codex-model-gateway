[CmdletBinding()]
param([string]$Directory)
$ErrorActionPreference='Stop'
if (-not $PSBoundParameters.ContainsKey('Directory')) { $Directory=$PSScriptRoot }
. (Join-Path $PSScriptRoot 'lifecycle.ps1')
$identity=Get-GeminiBridgeIdentity $Directory
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
try {
    if(-not $process.Start()){throw 'The bridge executable did not start.'}
    if(-not [CodexGeminiBridge.ChildLifetime]::AssignProcessToJobObject($job,$process.Handle)) {
        # Kill by this already-open process handle, never by a recycled PID.
        $process.Kill()
        throw 'The bridge executable could not be attached to its managed lifetime.'
    }
    # Drain both streams without printing or storing upstream error bodies or tokens.
    $stdout=$process.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
    $stderr=$process.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
    $process.WaitForExit()
    $stdout.GetAwaiter().GetResult() | Out-Null
    $stderr.GetAwaiter().GetResult() | Out-Null
    exit $process.ExitCode
} finally { $job.Dispose(); $process.Dispose() }
