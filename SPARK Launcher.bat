@echo off
setlocal
start "" powershell -STA -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File "%~dp0SPARK-Launcher.ps1"
exit /b 0
