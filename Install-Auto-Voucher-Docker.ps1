[CmdletBinding()]
param(
    [ValidateNotNullOrEmpty()]
    [string]$Image = "ghcr.io/honghudavy-star/auto-voucher:latest",
    [ValidateRange(1, 65535)]
    [int]$Port = 8765,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$ContainerName = "auto-voucher"
$VolumeName = "auto-voucher-data"
$AppUrl = "http://127.0.0.1:$Port/"

function Invoke-Docker {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    & docker @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "Docker command failed with exit code $LASTEXITCODE."
    }
}

function Start-AutoVoucherContainer {
    param([Parameter(Mandatory = $true)][string]$SelectedImage)

    Invoke-Docker -Arguments @(
        "run", "--detach",
        "--name", $ContainerName,
        "--restart", "unless-stopped",
        "--init",
        "--security-opt", "no-new-privileges",
        "--cap-drop", "ALL",
        "--cpus", "2",
        "--memory", "2g",
        "--pids-limit", "256",
        "--publish", "127.0.0.1:$Port`:8765",
        "--volume", "$VolumeName`:/data",
        $SelectedImage
    )
}

function Wait-AutoVoucherHealthy {
    for ($Attempt = 0; $Attempt -lt 150; $Attempt++) {
        Start-Sleep -Seconds 2
        $Status = (& docker inspect --format "{{.State.Health.Status}}" $ContainerName 2>$null)
        if ($LASTEXITCODE -eq 0 -and $Status -eq "healthy") {
            return $true
        }
        if ($LASTEXITCODE -eq 0 -and $Status -eq "unhealthy") {
            return $false
        }
    }
    return $false
}

$PreviousImageId = $null
$ExistingContainer = $false

try {
    if ($env:OS -ne "Windows_NT") {
        throw "This installer must be run from Windows PowerShell."
    }
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw "Docker is not installed. Install Docker Desktop first: winget install -e --id Docker.DockerDesktop"
    }

    & docker version --format "{{.Server.Version}}" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Desktop is not running. Start it in Linux containers / WSL 2 mode and try again."
    }

    Write-Host "[Auto Voucher] Pulling prebuilt image: $Image" -ForegroundColor Cyan
    Invoke-Docker -Arguments @("pull", $Image)

    $PreviousImageId = (& docker inspect --format "{{.Image}}" $ContainerName 2>$null)
    $ExistingContainer = $LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($PreviousImageId)
    if ($ExistingContainer) {
        Write-Host "[Auto Voucher] Replacing the existing container without deleting its data volume" -ForegroundColor Cyan
        Invoke-Docker -Arguments @("rm", "--force", $ContainerName)
    }

    & docker volume create $VolumeName | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Could not create or reuse Docker volume $VolumeName."
    }

    Start-AutoVoucherContainer -SelectedImage $Image
    if (-not (Wait-AutoVoucherHealthy)) {
        & docker logs --tail 200 $ContainerName | Out-Host
        throw "The new Auto Voucher container did not become healthy."
    }

    $Health = Invoke-RestMethod -Uri ($AppUrl + "api/health") -TimeoutSec 10
    if (-not $Health.ok -or $Health.databaseStatus -ne "ok" -or -not $Health.staticAssets) {
        throw "Auto Voucher started but did not pass its application health check."
    }

    $ImageId = (& docker inspect --format "{{.Image}}" $ContainerName)
    Write-Host ""
    Write-Host "Auto Voucher is ready: $AppUrl" -ForegroundColor Green
    Write-Host "Image: $Image"
    Write-Host "Image ID: $ImageId"
    Write-Host "Business data: Docker volume $VolumeName"
    if (-not $NoBrowser) {
        Start-Process $AppUrl
    }
    exit 0
}
catch {
    $Failure = $_.Exception.Message
    if ($ExistingContainer -and -not [string]::IsNullOrWhiteSpace($PreviousImageId)) {
        Write-Host "The update failed. Restoring the previous image..." -ForegroundColor Yellow
        try {
            & docker rm --force $ContainerName 2>$null | Out-Null
            Start-AutoVoucherContainer -SelectedImage $PreviousImageId
            if (Wait-AutoVoucherHealthy) {
                Write-Host "The previous image was restored and restarted." -ForegroundColor Yellow
            }
            else {
                Write-Host "The previous image was restored, but it did not become healthy." -ForegroundColor Red
            }
        }
        catch {
            Write-Host "Automatic rollback failed: $($_.Exception.Message)" -ForegroundColor Red
        }
    }

    Write-Host ""
    Write-Host $Failure -ForegroundColor Red
    Write-Host "The Docker data volume was not deleted."
    exit 1
}
