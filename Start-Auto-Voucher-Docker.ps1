[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8765,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ComposeFile = Join-Path $Root "docker-compose.yml"
$AppUrl = "http://127.0.0.1:$Port/"

function Invoke-Docker {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    & docker @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Docker command failed with exit code $LASTEXITCODE."
    }
}

try {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw "Docker is not installed. Install and start Docker Desktop first."
    }
    if (-not (Test-Path -LiteralPath $ComposeFile)) {
        throw "docker-compose.yml is missing from the project directory."
    }

    & docker version --format "{{.Server.Version}}" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Desktop is not running. Start Docker Desktop and try again."
    }
    & docker compose version | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Compose is unavailable. Update Docker Desktop and try again."
    }

    $env:AUTO_VOUCHER_PORT = [string]$Port
    Push-Location $Root
    try {
        Invoke-Docker -Arguments @(
            "compose", "--file", $ComposeFile,
            "pull", "app"
        )
        Invoke-Docker -Arguments @(
            "compose", "--file", $ComposeFile,
            "up", "--detach", "--no-build", "--wait", "--wait-timeout", "300"
        )
    }
    finally {
        Pop-Location
    }

    $Health = Invoke-RestMethod -Uri ($AppUrl + "api/health") -TimeoutSec 10
    if (-not $Health.ok -or $Health.databaseStatus -ne "ok" -or -not $Health.staticAssets) {
        throw "Auto Voucher started but did not pass its health check."
    }

    Write-Host ""
    Write-Host "Auto Voucher is ready: $AppUrl" -ForegroundColor Green
    Write-Host "Data is stored in the Docker volume: auto-voucher-data"
    Write-Host "To stop it without deleting data: docker compose stop"
    Write-Host ""

    if (-not $NoBrowser) {
        Start-Process $AppUrl
    }
    exit 0
}
catch {
    Write-Host ""
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host "Run 'docker compose logs --tail 200 app' for details."
    exit 1
}
