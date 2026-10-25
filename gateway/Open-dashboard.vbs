Option Explicit
Dim gatewayShell, gatewayFiles, gatewayRoot, gatewayLauncher, gatewayCommand, gatewayResult
Set gatewayShell = CreateObject("WScript.Shell")
Set gatewayFiles = CreateObject("Scripting.FileSystemObject")
gatewayRoot = gatewayFiles.GetParentFolderName(WScript.ScriptFullName)
gatewayLauncher = gatewayRoot & "\launch.vbs"
If Not gatewayFiles.FileExists(gatewayLauncher) Then
    If InStr(LCase(WScript.FullName), "cscript.exe") > 0 Then
        WScript.StdErr.WriteLine "The gateway launcher is missing. Repair the installation or use emergency GPT recovery."
    Else
        MsgBox "The gateway launcher is missing. Repair the installation or use emergency GPT recovery.", vbExclamation, "Codex model gateway"
    End If
    WScript.Quit 1
End If
gatewayCommand = """" & gatewayShell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\wscript.exe"" //B //NoLogo """ & gatewayLauncher & """ dashboard"
On Error Resume Next
gatewayResult = gatewayShell.Run(gatewayCommand, 0, True)
If Err.Number <> 0 Then
    GatewayFailure
    WScript.Quit 1
End If
On Error GoTo 0
If gatewayResult <> 0 Then GatewayFailure
WScript.Quit gatewayResult

Sub GatewayFailure()
    If InStr(LCase(WScript.FullName), "cscript.exe") > 0 Then
        WScript.StdErr.WriteLine "The model gateway did not open. Use Emergency-restore-GPT.cmd if Codex cannot connect."
    Else
        MsgBox "The model gateway did not open. Use Emergency-restore-GPT.cmd if Codex cannot connect.", vbExclamation, "Codex model gateway"
    End If
End Sub
