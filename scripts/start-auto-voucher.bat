@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0.."
title Auto Voucher

if not defined AUTO_VOUCHER_PORT set "AUTO_VOUCHER_PORT=8765"
set "APP_URL=http://127.0.0.1:%AUTO_VOUCHER_PORT%/"
set "VENV_DIR=%CD%\.venv"
set "VENV_PYTHON=%VENV_DIR%\Scripts\python.exe"
set "RUNTIME_DIR=%CD%\.auto-voucher-runtime"
set "STATUS_SCRIPT=%CD%\scripts\startup-status.ps1"
set "STATUS_PAGE=%RUNTIME_DIR%\startup.html"
set "LOG_FILE=%RUNTIME_DIR%\startup.log"
set "SERVER_OUT=%RUNTIME_DIR%\server.out.log"
set "SERVER_ERR=%RUNTIME_DIR%\server.err.log"
set "SERVER_PID=%RUNTIME_DIR%\server.pid"
set "NODE_STATUS=checking"
set "PYTHON_STATUS=checking"

if not exist "%RUNTIME_DIR%" mkdir "%RUNTIME_DIR%"
type nul > "%LOG_FILE%"
call :write_status checking "Checking this computer before setup"
start "" "%STATUS_PAGE%"

where node >nul 2>nul
if errorlevel 1 goto :missing_node

for /f %%V in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR goto :missing_node
if !NODE_MAJOR! LSS 20 goto :missing_node
set "NODE_STATUS=ready"
call :write_status checking "Node.js is ready. Checking Python"

set "PYTHON_BOOTSTRAP="
py -3.12 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
if not errorlevel 1 set "PYTHON_BOOTSTRAP=py -3.12"
if not defined PYTHON_BOOTSTRAP (
  py -3.11 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
  if not errorlevel 1 set "PYTHON_BOOTSTRAP=py -3.11"
)
if not defined PYTHON_BOOTSTRAP (
  python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
  if not errorlevel 1 set "PYTHON_BOOTSTRAP=python"
)
if not defined PYTHON_BOOTSTRAP if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" (
  set "PYTHON_BOOTSTRAP="%LOCALAPPDATA%\Programs\Python\Python312\python.exe""
)
if not defined PYTHON_BOOTSTRAP if exist "%ProgramFiles%\Python312\python.exe" (
  set "PYTHON_BOOTSTRAP="%ProgramFiles%\Python312\python.exe""
)
if not defined PYTHON_BOOTSTRAP goto :missing_python
set "PYTHON_STATUS=ready"
call :write_status checking "Node.js and Python are ready"

if /I not "%AUTO_VOUCHER_SKIP_SOURCE_UPDATE%"=="1" (
  call :write_status updating "Checking for a newer Auto Voucher source version"
  powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\source-update.ps1" -Root "%CD%" >> "%LOG_FILE%" 2>&1
  if errorlevel 1 echo Source update check failed. Continuing with the current version.>> "%LOG_FILE%"
)

for /f %%V in ('node -p "require('./package.json').version" 2^>nul') do set "APP_VERSION=%%V"
if not defined APP_VERSION goto :setup_failed
set "READY_FILE=%VENV_DIR%\.auto-voucher-%APP_VERSION%-ready"

if not exist "%VENV_PYTHON%" (
  call :write_status configuring "Creating the local Python environment"
  %PYTHON_BOOTSTRAP% -m venv "%VENV_DIR%" >> "%LOG_FILE%" 2>&1
  if errorlevel 1 goto :setup_failed
)

if not exist "%READY_FILE%" (
  call :write_status configuring "Installing Core, OCR and PDF components"
  "%VENV_PYTHON%" -m pip install --disable-pip-version-check -e ".[ocr,pdf]" >> "%LOG_FILE%" 2>&1
  if errorlevel 1 goto :setup_failed
  type nul > "%READY_FILE%"
)

call :write_status configuring "Preparing the local web interface"
call npm install --no-audit --no-fund >> "%LOG_FILE%" 2>&1
if errorlevel 1 goto :setup_failed
call npm run build >> "%LOG_FILE%" 2>&1
if errorlevel 1 goto :setup_failed

"%VENV_PYTHON%" -c "import urllib.request; urllib.request.urlopen('%APP_URL%', timeout=1)" >nul 2>nul
if not errorlevel 1 goto :already_running

call :write_status starting "Starting the local Auto Voucher service"
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
call :write_status ready "Auto Voucher is already running"
start "" "%APP_URL%"
exit /b 0

:ready
call :write_status ready "Environment ready. Opening Auto Voucher"
start "" "%APP_URL%"
exit /b 0

:missing_node
set "NODE_STATUS=missing"
call :write_status missing_node "Node.js 20 or newer is required"
start "" "https://nodejs.org/en/download"
exit /b 10

:missing_python
set "PYTHON_STATUS=missing"
call :write_status missing_python "Python 3.11 or 3.12 is required"
start "" "https://www.python.org/downloads/windows/"
exit /b 11

:server_failed
call :write_status error "The local service did not become ready. Review the startup log"
exit /b 21

:setup_failed
call :write_status error "Environment setup failed. Review the startup log and try again"
exit /b 20

:write_status
powershell -NoProfile -ExecutionPolicy Bypass -File "%STATUS_SCRIPT%" -Root "%CD%" -Phase "%~1" -Message "%~2" -NodeStatus "%NODE_STATUS%" -PythonStatus "%PYTHON_STATUS%" -AppUrl "%APP_URL%" -LogPath "%LOG_FILE%" >nul 2>&1
exit /b 0
