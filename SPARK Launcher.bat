@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0SPARK-Launcher.ps1"
if errorlevel 1 (
  echo.
  echo SPARK could not start. Check the message above, then press any key to close.
  pause >nul
)
