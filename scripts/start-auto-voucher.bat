@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0.."
title Auto Voucher

if not defined AUTO_VOUCHER_PORT set "AUTO_VOUCHER_PORT=8765"
if not defined AUTO_VOUCHER_ENV_PORT set "AUTO_VOUCHER_ENV_PORT=18764"
set "APP_URL=http://127.0.0.1:%AUTO_VOUCHER_PORT%/"
set "ENV_URL=http://127.0.0.1:%AUTO_VOUCHER_ENV_PORT%/"
set "VENV_DIR=%CD%\.venv"
set "VENV_PYTHON=%VENV_DIR%\Scripts\python.exe"
set "RUNTIME_DIR=%CD%\.auto-voucher-runtime"
set "ENV_SCRIPT=%CD%\scripts\environment-bootstrap.ps1"
set "ENV_READY=%RUNTIME_DIR%\environment-ready"
set "ENV_COMMAND=%RUNTIME_DIR%\environment.cmd"
set "ENV_SERVER_PID=%RUNTIME_DIR%\environment-server.pid"
set "ENV_SERVER_OUT=%RUNTIME_DIR%\environment-server.out.log"
set "ENV_SERVER_ERR=%RUNTIME_DIR%\environment-server.err.log"
set "LOG_FILE=%RUNTIME_DIR%\startup.log"
set "SERVER_OUT=%RUNTIME_DIR%\server.out.log"
set "SERVER_ERR=%RUNTIME_DIR%\server.err.log"
set "SERVER_PID=%RUNTIME_DIR%\server.pid"

if not exist "%RUNTIME_DIR%" mkdir "%RUNTIME_DIR%"
type nul > "%LOG_FILE%"
if exist "%ENV_SERVER_PID%" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$id = Get-Content -LiteralPath '%ENV_SERVER_PID%' -ErrorAction SilentlyContinue; if ($id) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }" >nul 2>&1
)
if exist "%ENV_READY%" del /q "%ENV_READY%"
if exist "%ENV_COMMAND%" del /q "%ENV_COMMAND%"

start "" /b powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ENV_SCRIPT%" -Root "%CD%" -Mode Serve -Port %AUTO_VOUCHER_ENV_PORT% -AppUrl "%APP_URL%" > "%ENV_SERVER_OUT%" 2> "%ENV_SERVER_ERR%"

set "ENV_SERVER_UP="
for /L %%I in (1,1,30) do (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing -Uri '%ENV_URL%' -TimeoutSec 1 | Out-Null" >nul 2>&1
  if not errorlevel 1 (
    set "ENV_SERVER_UP=1"
    goto :environment_page_ready
  )
  ping 127.0.0.1 -n 2 >nul
)
goto :environment_server_failed

:environment_page_ready
start "" "%ENV_URL%"
echo Waiting for automatic environment setup...>> "%LOG_FILE%"

:wait_for_environment
if exist "%ENV_READY%" goto :environment_ready
if exist "%ENV_SERVER_PID%" (
  for /f "usebackq delims=" %%P in ("%ENV_SERVER_PID%") do (
    tasklist /FI "PID eq %%P" 2>nul | find "%%P" >nul
    if errorlevel 1 goto :environment_server_failed
  )
)
ping 127.0.0.1 -n 2 >nul
goto :wait_for_environment

:environment_ready
if not exist "%ENV_COMMAND%" goto :environment_server_failed
call "%ENV_COMMAND%"

where node >nul 2>nul
if errorlevel 1 goto :environment_server_failed
for /f %%V in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR goto :environment_server_failed
if !NODE_MAJOR! LSS 20 goto :environment_server_failed

set "PYTHON_BOOTSTRAP_EXE=%AUTO_VOUCHER_PYTHON_EXE%"
if not defined PYTHON_BOOTSTRAP_EXE goto :environment_server_failed
"%PYTHON_BOOTSTRAP_EXE%" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
if errorlevel 1 goto :environment_server_failed

if /I not "%AUTO_VOUCHER_SKIP_SOURCE_UPDATE%"=="1" (
  call :write_status updating checking_source_update
  powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\source-update.ps1" -Root "%CD%" >> "%LOG_FILE%" 2>&1
  if errorlevel 1 echo Source update check failed. Continuing with the current version.>> "%LOG_FILE%"
)

for /f %%V in ('node -p "require('./package.json').version" 2^>nul') do set "APP_VERSION=%%V"
if not defined APP_VERSION goto :setup_failed
set "READY_FILE=%VENV_DIR%\.auto-voucher-%APP_VERSION%-ready"

if not exist "%VENV_PYTHON%" (
  call :write_status configuring creating_python_environment
  "%PYTHON_BOOTSTRAP_EXE%" -m venv "%VENV_DIR%" >> "%LOG_FILE%" 2>&1
  if errorlevel 1 goto :setup_failed
)

if not exist "%READY_FILE%" (
  call :write_status configuring installing_components
  "%VENV_PYTHON%" -m pip install --disable-pip-version-check -e ".[ocr,pdf]" >> "%LOG_FILE%" 2>&1
  if errorlevel 1 goto :setup_failed
  type nul > "%READY_FILE%"
)

call :write_status configuring preparing_web_interface
call npm install --no-audit --no-fund >> "%LOG_FILE%" 2>&1
if errorlevel 1 goto :setup_failed
call npm run build >> "%LOG_FILE%" 2>&1
if errorlevel 1 goto :setup_failed

"%VENV_PYTHON%" -c "import urllib.request; urllib.request.urlopen('%APP_URL%', timeout=1)" >nul 2>nul
if not errorlevel 1 goto :already_running

call :write_status starting starting_local_service
set "PYTHONPATH=%CD%\backend"
set "AUTO_VOUCHER_CORE_VERSION=%APP_VERSION%-source"
set "AUTO_VOUCHER_OCR_WORKER=%CD%\packaging\ocr_worker.py"
set "AUTO_VOUCHER_PDF_WORKER=%CD%\packaging\pdf_worker.py"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$process = Start-Process -FilePath '%VENV_PYTHON%' -ArgumentList '-m','auto_voucher','--no-browser' -WorkingDirectory '%CD%' -WindowStyle Hidden -RedirectStandardOutput '%SERVER_OUT%' -RedirectStandardError '%SERVER_ERR%' -PassThru; Set-Content -LiteralPath '%SERVER_PID%' -Value $process.Id -Encoding ASCII" >> "%LOG_FILE%" 2>&1
if errorlevel 1 goto :setup_failed

for /L %%I in (1,1,60) do (
  "%VENV_PYTHON%" -c "import urllib.request; urllib.request.urlopen('%APP_URL%', timeout=1)" >nul 2>nul
  if not errorlevel 1 goto :ready
  ping 127.0.0.1 -n 2 >nul
)
goto :server_failed

:already_running
call :write_status ready application_ready
call :finish_environment_page
exit /b 0

:ready
call :write_status ready application_ready
ping 127.0.0.1 -n 3 >nul
call :finish_environment_page
exit /b 0

:environment_server_failed
echo Environment bootstrap service failed.>> "%LOG_FILE%"
exit /b 12

:server_failed
call :write_status error server_failed
exit /b 21

:setup_failed
call :write_status error setup_failed
exit /b 20

:write_status
powershell -NoProfile -ExecutionPolicy Bypass -File "%ENV_SCRIPT%" -Root "%CD%" -Mode Update -Port %AUTO_VOUCHER_ENV_PORT% -AppUrl "%APP_URL%" -Status "%~1" -Message "%~2" >nul 2>&1
exit /b 0

:finish_environment_page
if exist "%ENV_SERVER_PID%" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$id = Get-Content -LiteralPath '%ENV_SERVER_PID%' -ErrorAction SilentlyContinue; if ($id) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }" >nul 2>&1
)
exit /b 0
