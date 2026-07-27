@echo off
setlocal EnableExtensions
title Auto Voucher

set "APP_DIR=%~dp0AutoVoucher"
if not exist "%APP_DIR%\scripts\start-auto-voucher.bat" set "APP_DIR=%~dp0"
set "LAUNCHER=%APP_DIR%\scripts\start-auto-voucher.bat"

if not exist "%LAUNCHER%" (
  echo.
  echo Auto Voucher package is incomplete.
  echo Please extract the complete ZIP file before starting.
  echo.
  pause
  exit /b 2
)

call "%LAUNCHER%"
set "APP_EXIT=%ERRORLEVEL%"
if "%APP_EXIT%"=="0" exit /b 0

echo.
echo Auto Voucher did not start. Error code: %APP_EXIT%
echo See the startup page or the log inside the AutoVoucher folder.
echo.
pause
exit /b %APP_EXIT%
