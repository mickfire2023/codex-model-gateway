Option Explicit
Dim gatewayShell, gatewayFiles, gatewayRoot, gatewayPowerShell, gatewayTarget, gatewayCommand, gatewayAction, gatewayResult
Set gatewayShell = CreateObject("WScript.Shell")
Set gatewayFiles = CreateObject("Scripting.FileSystemObject")
gatewayRoot = gatewayFiles.GetParentFolderName(WScript.ScriptFullName)
If WScript.Arguments.Count <> 1 Then
    GatewayMessage "Choose one operation: dashboard, restore, or enable."
    WScript.Quit 1
End If
gatewayAction = WScript.Arguments(0)
Select Case gatewayAction
    Case "dashboard": gatewayTarget = gatewayRoot & "\Open-dashboard.ps1"
    Case "restore": gatewayTarget = gatewayRoot & "\restore.ps1"
    Case "enable": gatewayTarget = gatewayRoot & "\enable.ps1"
    Case Else
        GatewayMessage "The gateway operation is invalid."
        WScript.Quit 1
End Select
gatewayPowerShell = gatewayShell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
If Not gatewayFiles.FileExists(gatewayRoot & "\private\settings.json") Or Not gatewayFiles.FileExists(gatewayTarget) Or Not gatewayFiles.FileExists(gatewayPowerShell) Then
    GatewayMessage "The gateway installation is incomplete:" & vbCrLf & gatewayRoot & vbCrLf & "Use the emergency GPT recovery CMD."
    WScript.Quit 1
End If
gatewayShell.Environment("Process")("PSModulePath") = gatewayShell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\Modules"
gatewayCommand = """" & gatewayPowerShell & """ -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & gatewayTarget & """ -Directory """ & gatewayRoot & """"
If gatewayAction <> "dashboard" Then gatewayCommand = gatewayCommand & " -ShowMessage"
On Error Resume Next
gatewayResult = gatewayShell.Run(gatewayCommand, 0, True)
If Err.Number <> 0 Then
    GatewayMessage "Windows could not start the gateway operation. Use the emergency GPT recovery CMD."
    WScript.Quit 1
End If
On Error GoTo 0
If gatewayResult <> 0 Then GatewayMessage "The gateway operation did not complete. Use the emergency GPT recovery CMD if Codex cannot connect."
WScript.Quit gatewayResult

Sub GatewayMessage(message)
    If InStr(LCase(WScript.FullName), "cscript.exe") > 0 Then
        ' Keep console diagnostics representable on every Windows code page.
        On Error Resume Next
        WScript.StdErr.WriteLine GatewayConsoleText(message)
        On Error GoTo 0
    Else
        MsgBox message, vbExclamation, "Codex model gateway"
    End If
End Sub

Function GatewayConsoleText(message)
    Dim position, character, code, result
    result = ""
    For position = 1 To Len(message)
        character = Mid(message, position, 1)
        code = AscW(character) And &HFFFF
        If (code >= 32 And code <= 126) Or code = 9 Or code = 10 Or code = 13 Then
            result = result & character
        Else
            result = result & "\u" & Right("0000" & Hex(code), 4)
        End If
    Next
    GatewayConsoleText = result
End Function
