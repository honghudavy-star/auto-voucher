@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0.."
title Auto Voucher

if not defined AUTO_VOUCHER_PORT set "AUTO_VOUCHER_PORT=8765"
set "APP_URL=http://127.0.0.1:%AUTO_VOUCHER_PORT%/"
set "VENV_DIR=%CD%\.venv"
set "VENV_PYTHON=%VENV_DIR%\Scripts\python.exe"

echo.
echo Auto Voucher 正在启动，请不要关闭此窗口。
echo.

where node >nul 2>nul
if errorlevel 1 goto :missing_node

for /f %%V in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR goto :missing_node
if !NODE_MAJOR! LSS 20 goto :missing_node

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

if /I not "%AUTO_VOUCHER_SKIP_SOURCE_UPDATE%"=="1" (
  echo [更新] 正在检查源码版本...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\source-update.ps1" -Root "%CD%"
  if errorlevel 1 echo [更新] 检查失败，将继续运行当前版本。
)

for /f %%V in ('node -p "require('./package.json').version" 2^>nul') do set "APP_VERSION=%%V"
if not defined APP_VERSION goto :setup_failed
set "READY_FILE=%VENV_DIR%\.auto-voucher-%APP_VERSION%-ready"

if not exist "%VENV_PYTHON%" (
  echo [1/4] 正在创建本地 Python 环境...
  %PYTHON_BOOTSTRAP% -m venv "%VENV_DIR%"
  if errorlevel 1 goto :setup_failed
)

if not exist "%READY_FILE%" (
  echo [2/4] 正在安装完整功能组件（Core、OCR、PDF）...
  "%VENV_PYTHON%" -m pip install --disable-pip-version-check -e ".[ocr,pdf]"
  if errorlevel 1 goto :setup_failed
  type nul > "%READY_FILE%"
) else (
  echo [2/4] 完整功能组件已就绪。
)

echo [3/4] 正在准备网页界面...
call npm install --no-audit --no-fund
if errorlevel 1 goto :setup_failed
call npm run build
if errorlevel 1 goto :setup_failed

"%VENV_PYTHON%" -c "import urllib.request; urllib.request.urlopen('%APP_URL%', timeout=1)" >nul 2>nul
if not errorlevel 1 (
  echo [4/4] Auto Voucher 已经在运行，正在打开浏览器...
  start "" "%APP_URL%"
  exit /b 0
)

echo [4/4] 正在启动 Auto Voucher...
set "PYTHONPATH=%CD%\backend"
set "AUTO_VOUCHER_CORE_VERSION=%APP_VERSION%-source"
set "AUTO_VOUCHER_OCR_WORKER=%CD%\packaging\ocr_worker.py"
set "AUTO_VOUCHER_PDF_WORKER=%CD%\packaging\pdf_worker.py"
set "SERVER_ARGS="
if /I "%AUTO_VOUCHER_NO_BROWSER%"=="1" set "SERVER_ARGS=--no-browser"
"%VENV_PYTHON%" -m auto_voucher %SERVER_ARGS%
set "APP_EXIT=%ERRORLEVEL%"
if "%APP_EXIT%"=="0" exit /b 0

echo.
echo Auto Voucher 异常退出，错误代码：%APP_EXIT%
goto :show_help

:missing_node
echo 未检测到 Node.js 20 或更高版本。
echo 请安装 Node.js 22 LTS 后重新双击本文件：
echo https://nodejs.org/en/download
start "" "https://nodejs.org/en/download"
goto :show_help

:missing_python
echo 未检测到 Python 3.11 或 3.12。
echo 请安装 Python 3.12 后重新双击本文件：
echo https://www.python.org/downloads/windows/
start "" "https://www.python.org/downloads/windows/"
goto :show_help

:setup_failed
echo.
echo 首次运行环境准备失败。请检查网络连接后重新双击本文件。

:show_help
echo.
pause
exit /b 1
