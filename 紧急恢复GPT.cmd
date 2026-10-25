@echo off
setlocal
set "GWROOT=%USERPROFILE%\Documents\CodexModelGateway"
if not exist "%GWROOT%\private\settings.json" set "GWROOT=%USERPROFILE%\AppData\Local\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\CodexModelGateway"
if not exist "%GWROOT%\private\settings.json" goto missing
if not exist "%GWROOT%\runtime\node.exe" goto missing
set "GWSCRIPT=%GWROOT%\rescue.cjs"
if not exist "%GWSCRIPT%" set "GWSCRIPT=%~dp0gateway\rescue.cjs"
if not exist "%GWSCRIPT%" goto missing
"%GWROOT%\runtime\node.exe" "%GWSCRIPT%" --directory "%GWROOT%"
set "GWEXIT=%ERRORLEVEL%"
if not "%GWEXIT%"=="0" echo Recovery did not complete. Existing settings were kept.
echo.
echo Restart Codex after a successful recovery.
pause
exit /b %GWEXIT%
:missing
echo The gateway runtime, settings, or emergency recovery file was not found.
echo No Codex settings were changed.
pause
exit /b 1
