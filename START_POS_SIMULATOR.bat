@echo off
REM POS Simulator - launcher for double-click / Command Prompt.
REM Calls Start-POS-Simulator.ps1 so both launchers behave the same.
REM   START_POS_SIMULATOR.bat         open backend, UI and tests windows
REM   START_POS_SIMULATOR.bat test    same, then run the "ready" suite automatically

set "PS_ARGS="
if /i "%~1"=="test" set "PS_ARGS=-RunTests"

powershell -NoLogo -ExecutionPolicy Bypass -File "%~dp0Start-POS-Simulator.ps1" %PS_ARGS%
if errorlevel 1 (
  echo.
  echo Launcher stopped - see the message above.
  pause
)
