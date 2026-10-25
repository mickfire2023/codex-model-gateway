@echo off
setlocal
set "GWROOT=%~dp0"
if not exist "%GWROOT%private\settings.json" goto missing
if not exist "%GWROOT%runtime\node.exe" goto missing
if not exist "%GWROOT%rescue.cjs" goto missing
"%GWROOT%runtime\node.exe" "%GWROOT%rescue.cjs" --directory "%GWROOT%."
set "GWEXIT=%ERRORLEVEL%"
if not "%GWEXIT%"=="0" echo Recovery did not complete. Existing settings were kept.
echo.
echo Restart Codex after a successful recovery.
pause
exit /b %GWEXIT%
:missing
echo The installed gateway emergency recovery files are incomplete.
echo No Codex settings were changed.
pause
exit /b 1
