Option Explicit
Dim gatewayShell, gatewayFiles, gatewayFolder, gatewayPowerShell, gatewayAction, gatewayResult
Set gatewayShell = CreateObject("WScript.Shell")
Set gatewayFiles = CreateObject("Scripting.FileSystemObject")
gatewayFolder = gatewayFiles.GetParentFolderName(WScript.ScriptFullName)
If WScript.Arguments.Count <> 1 Then WScript.Quit 1
gatewayAction = WScript.Arguments(0)
If gatewayAction <> "restart" And gatewayAction <> "restore" Then WScript.Quit 1
gatewayPowerShell = gatewayShell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
gatewayShell.Environment("Process")("PSModulePath") = gatewayShell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\Modules"
gatewayResult = gatewayShell.Run("""" & gatewayPowerShell & """ -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & gatewayFolder & "\control.ps1"" -Directory """ & gatewayFolder & """ -Action " & gatewayAction, 0, True)
WScript.Quit gatewayResult
