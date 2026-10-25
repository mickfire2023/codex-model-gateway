Option Explicit
Dim gatewayShell, gatewayFiles, gatewayRoot, gatewayPowerShell, gatewayTarget, gatewayCommand, gatewayResult, gatewayLegacy
Set gatewayShell = CreateObject("WScript.Shell")
Set gatewayFiles = CreateObject("Scripting.FileSystemObject")
gatewayRoot = gatewayShell.ExpandEnvironmentStrings("%USERPROFILE%") & "\Documents\CodexModelGateway"
gatewayLegacy = gatewayShell.ExpandEnvironmentStrings("%USERPROFILE%") & "\AppData\Local\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\CodexModelGateway"
If Not gatewayFiles.FileExists(gatewayRoot & "\private\settings.json") Then gatewayRoot = gatewayLegacy
If Not gatewayFiles.FileExists(gatewayRoot & "\private\settings.json") Then
    GatewayMessage "The installed model gateway was not found in Documents or the previous Codex package folder." & vbCrLf & "Use the emergency GPT recovery CMD, or repair the installation."
    WScript.Quit 1
End If
gatewayPowerShell = gatewayShell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
gatewayTarget = gatewayRoot & "\restore.ps1"
If Not gatewayFiles.FileExists(gatewayTarget) Or Not gatewayFiles.FileExists(gatewayPowerShell) Then
    GatewayMessage "A required gateway script or Windows PowerShell is missing:" & vbCrLf & gatewayTarget & vbCrLf & "Use the emergency GPT recovery CMD."
    WScript.Quit 1
End If
gatewayShell.Environment("Process")("PSModulePath") = gatewayShell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\Modules"
gatewayCommand = """" & gatewayPowerShell & """ -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & gatewayTarget & """ -Directory """ & gatewayRoot & """" & " -ShowMessage"
On Error Resume Next
gatewayResult = gatewayShell.Run(gatewayCommand, 0, True)
If Err.Number <> 0 Then
    GatewayMessage "Windows could not start the gateway operation." & vbCrLf & "Use the emergency GPT recovery CMD."
    WScript.Quit 1
End If
On Error GoTo 0
If gatewayResult <> 0 Then
    GatewayMessage "The gateway operation did not complete. Existing keys were kept." & vbCrLf & "Use the emergency GPT recovery CMD if Codex cannot connect."
End If
WScript.Quit gatewayResult

Sub GatewayMessage(message)
    If InStr(LCase(WScript.FullName), "cscript.exe") > 0 Then
        WScript.StdErr.WriteLine message
    Else
        MsgBox message, vbExclamation, "Codex model gateway"
    End If
End Sub
