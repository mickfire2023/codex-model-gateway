[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$release = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\gateway'))
. (Join-Path $release 'start.ps1') -Directory $release -LibraryOnly
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('codex-runner-console-' + [Guid]::NewGuid().ToString('N'))
$testProcess = $null
$checks = 0
function Assert-RunnerConsole([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message }; $script:checks++ }
try {
    New-Item -ItemType Directory -Path (Join-Path $fixture 'private') | Out-Null
    foreach ($name in @('runner.ps1','start.ps1','physical-path.ps1','scheduler.ps1')) { Copy-Item -LiteralPath (Join-Path $release $name) -Destination (Join-Path $fixture $name) }
    $probe = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
public static class SyntheticConsoleProbe {
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    public static int Main(string[] args) {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        bool consoleAllocated = GetConsoleWindow() != IntPtr.Zero;
        File.WriteAllText(Path.Combine(root, "console-allocated.txt"), consoleAllocated ? "true" : "false");
        Console.Out.Write(new String('o', 262144) + "stdout-complete");
        Console.Error.Write(new String('e', 262144) + "stderr-complete");
        File.Delete(Path.Combine(root, "private", "enabled"));
        return 0;
    }
}
'@
    $binary = Join-Path $fixture 'node.exe'
    Add-Type -TypeDefinition $probe -OutputAssembly $binary -OutputType ConsoleApplication
    Write-GatewayUtf8 (Join-Path $fixture 'gateway.cjs') '// Synthetic console probe only.'
    Write-GatewayUtf8 (Join-Path $fixture 'private\settings.json') (@{port=49123;routeToken='synthetic_console_probe_token_0001';nodePath=$binary;lifecycle=@{startupMode='process'}} | ConvertTo-Json)
    Write-GatewayUtf8 (Join-Path $fixture 'private\enabled') 'synthetic-enabled'
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = Get-GatewayPowerShell
    $info.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $fixture 'runner.ps1') + '" -Directory "' + $fixture + '"'
    $info.WorkingDirectory = $fixture
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.EnvironmentVariables['PSModulePath'] = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\Modules'
    $testProcess = New-Object Diagnostics.Process
    $testProcess.StartInfo = $info
    Assert-RunnerConsole ($testProcess.Start()) 'The isolated runner did not start.'
    $out = $testProcess.StandardOutput.ReadToEndAsync()
    $err = $testProcess.StandardError.ReadToEndAsync()
    Assert-RunnerConsole ($testProcess.WaitForExit(30000)) 'The runner blocked while draining synthetic diagnostic output.'
    Assert-RunnerConsole ($testProcess.ExitCode -eq 0) ('The isolated runner failed: ' + $err.Result)
    Assert-RunnerConsole (([IO.File]::ReadAllText((Join-Path $fixture 'console-allocated.txt'))) -ceq 'false') 'Node was given a console even though the service must be windowless.'
    Assert-RunnerConsole (([IO.File]::ReadAllText((Join-Path $fixture 'runtime.stdout.log'))) -ceq (('o' * 262144) + 'stdout-complete')) 'The standard output pipe was lost or truncated.'
    Assert-RunnerConsole (([IO.File]::ReadAllText((Join-Path $fixture 'runtime.stderr.log'))) -ceq (('e' * 262144) + 'stderr-complete')) 'The standard error pipe was lost or truncated.'
    Assert-RunnerConsole (-not (Test-Path -LiteralPath (Join-Path $fixture 'private\enabled'))) 'The synthetic child did not complete normally.'
    Assert-RunnerConsole (-not (Test-Path -LiteralPath (Join-Path $fixture 'private\runner.pid'))) 'The exiting supervisor left its own PID file behind.'
    Write-Output ('PASS: ' + $checks + ' isolated runner checks; no WScript, tasks, network or installed service used.')
} finally {
    if (Test-Path -LiteralPath (Join-Path $fixture 'private\settings.json')) { Stop-GatewayService $fixture }
    if ($testProcess) { $testProcess.Dispose() }
    $absolute = [IO.Path]::GetFullPath($fixture)
    $parent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([char[]]'\/')
    if (-not $absolute.StartsWith($parent + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or -not ([IO.Path]::GetFileName($absolute)).StartsWith('codex-runner-console-')) { throw 'The synthetic runner cleanup path escaped its temporary parent.' }
    if (Test-Path -LiteralPath $absolute) { Remove-Item -LiteralPath $absolute -Recurse -Force }
}
