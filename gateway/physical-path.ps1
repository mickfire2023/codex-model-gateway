# Return the OS path behind a packaged application's virtual file-system view.
function Get-GatewayPhysicalPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path -match '[\x00-\x1f]' -or -not [IO.Path]::IsPathRooted($Path) -or $Path -match '^[A-Za-z]:[^\\/]') { throw 'An absolute path is required.' }
    $absolute = [IO.Path]::GetFullPath($Path)
    if (-not ([IO.File]::Exists($absolute) -or [IO.Directory]::Exists($absolute))) {
        $parent = [IO.Path]::GetDirectoryName($absolute.TrimEnd([char[]]'\/'))
        if (-not $parent -or $parent -eq $absolute) { throw 'The installation path has no existing parent.' }
        return [IO.Path]::Combine((Get-GatewayPhysicalPath $parent), [IO.Path]::GetFileName($absolute.TrimEnd([char[]]'\/')))
    }
    if (-not ('CodexGateway.NativePaths' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace CodexGateway {
  public static class NativePaths {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
  }
}
'@
    }
    $handle = [CodexGateway.NativePaths]::CreateFile($absolute, 0, 7, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
    if ($handle.IsInvalid) { throw 'The physical installation path could not be verified.' }
    try {
        $buffer = New-Object Text.StringBuilder 32768
        $length = [CodexGateway.NativePaths]::GetFinalPathNameByHandle($handle, $buffer, $buffer.Capacity, 0)
        if ($length -eq 0 -or $length -ge $buffer.Capacity) { throw 'The physical installation path could not be resolved.' }
        $physical = $buffer.ToString()
        if ($physical.StartsWith('\\?\UNC\')) { return ('\\' + $physical.Substring(8)) }
        if ($physical.StartsWith('\\?\')) { return $physical.Substring(4) }
        return $physical
    } finally { $handle.Dispose() }
}
