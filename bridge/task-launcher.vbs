Option Explicit
' Fixed local supervisor only: no arbitrary script, arguments or credentials.
Dim files, shell, root, target, powershell, command, result
Set files = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
If WScript.Arguments.Count <> 1 Then WScript.Quit 2
If WScript.Arguments(0) <> "service" Then WScript.Quit 2
root = files.GetParentFolderName(WScript.ScriptFullName)
target = root & "\runner.ps1"
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
If Not files.FileExists(powershell) Or Not files.FileExists(target) Then WScript.Quit 3
shell.Environment("Process")("PSModulePath") = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\Modules"
command = """" & powershell & """ -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & target & """ -Directory """ & root & """"
On Error Resume Next
result = shell.Run(command, 0, True)
If Err.Number <> 0 Then WScript.Quit 4
On Error GoTo 0
WScript.Quit result
