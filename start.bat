@echo off
rem Starts the Flow desktop app from the source files (no installer needed).
cd /d "%~dp0"

rem VS Code sets this, and with it Electron starts as plain Node.
set ELECTRON_RUN_AS_NODE=

if not exist node_modules (
  echo Installing packages...
  call npm install || goto :failed
)

call npm start || goto :failed
exit /b 0

:failed
echo.
echo Flow could not be started.
pause
exit /b 1
