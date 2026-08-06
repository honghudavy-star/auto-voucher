@echo off
setlocal EnableExtensions
title Auto Voucher Docker

set "LAUNCHER=%~dp0Start-Auto-Voucher-Docker.ps1"
if not exist "%LAUNCHER%" (
  echo.
  echo Auto Voucher Docker launcher is missing.
  echo Please extract the complete project before starting.
  echo.
  pause
  exit /b 2
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%LAUNCHER%"
set "APP_EXIT=%ERRORLEVEL%"
if "%APP_EXIT%"=="0" exit /b 0

echo.
echo Auto Voucher Docker did not start. Error code: %APP_EXIT%
echo.
pause
exit /b %APP_EXIT%
