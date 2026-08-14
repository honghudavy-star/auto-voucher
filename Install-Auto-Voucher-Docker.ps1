[CmdletBinding()]
param(
    [ValidateNotNullOrEmpty()]
    [string]$Image = "ghcr.m.daocloud.io/honghudavy-star/auto-voucher:latest",
    [ValidateRange(1, 65535)]
    [int]$Port = 8765,
    [switch]$AcceptDockerLicense,
    [switch]$DockerOnly,
    # Kept for compatibility with commands copied from older documentation.
    # The default DaoCloud image now falls back automatically.
    [switch]$AllowOverseasFallback,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$ContainerName = "auto-voucher"
$VolumeName = "auto-voucher-data"
$CanonicalImage = "ghcr.io/honghudavy-star/auto-voucher:latest"
$DockerDesktopUrl = "https://files.m.daocloud.io/desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe"
$AppUrl = "http://127.0.0.1:$Port/"
$script:DockerCommand = $null

function Resolve-WslCommand {
    $Command = Get-Command wsl.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $Command) {
        return $Command.Source
    }

    $Candidate = Join-Path $env:SystemRoot "System32\wsl.exe"
    if (Test-Path -LiteralPath $Candidate -PathType Leaf) {
        return $Candidate
    }
    return $null
}

function Test-WslReady {
    $WslCommand = Resolve-WslCommand
    if ([string]::IsNullOrWhiteSpace($WslCommand)) {
        return $false
    }

    $ProbeErrorActionPreference = $ErrorActionPreference
    $ProbeExitCode = 1
    try {
        $ErrorActionPreference = "Continue"
        & $WslCommand --status 2>$null | Out-Null
        $ProbeExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $ProbeErrorActionPreference
    }
    return $ProbeExitCode -eq 0
}

function Ensure-WslReady {
    if (Test-WslReady) {
        return
    }

    $WslCommand = Resolve-WslCommand
    if ([string]::IsNullOrWhiteSpace($WslCommand)) {
        throw "Windows WSL is unavailable. Run Windows Update and try the same command again."
    }

    Write-Host "[Auto Voucher] WSL 2 is not ready. Requesting administrator permission to enable it..." -ForegroundColor Cyan
    $Process = Start-Process -FilePath $WslCommand -ArgumentList @(
        "--install",
        "--no-distribution"
    ) -Verb RunAs -Wait -PassThru
    if ($Process.ExitCode -ne 0) {
        throw "WSL 2 could not be enabled (exit code $($Process.ExitCode)). Approve the administrator prompt and try again."
    }
    if (-not (Test-WslReady)) {
        throw "WSL 2 was enabled. Restart Windows, then run the same one-line command again."
    }
}

function Resolve-DockerCommand {
    $Command = Get-Command docker.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $Command) {
        return $Command.Source
    }

    $Candidates = @(
        (Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\resources\bin\docker.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Docker\Docker\resources\bin\docker.exe"),
        (Join-Path $env:LOCALAPPDATA "Docker\resources\bin\docker.exe"),
        (Join-Path $env:ProgramFiles "Docker\Docker\resources\bin\docker.exe")
    )
    foreach ($Candidate in $Candidates) {
        if (Test-Path -LiteralPath $Candidate -PathType Leaf) {
            return $Candidate
        }
    }
    return $null
}

function Resolve-DockerDesktopCommand {
    $Candidates = @(
        (Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\Docker Desktop.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Docker\Docker\Docker Desktop.exe"),
        (Join-Path $env:LOCALAPPDATA "Docker\Docker Desktop.exe"),
        (Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe")
    )
    foreach ($Candidate in $Candidates) {
        if (Test-Path -LiteralPath $Candidate -PathType Leaf) {
            return $Candidate
        }
    }
    return $null
}

function Test-DockerServer {
    if ([string]::IsNullOrWhiteSpace($script:DockerCommand)) {
        return $false
    }

    # Windows PowerShell 5.1 promotes native stderr to a terminating
    # NativeCommandError when the caller uses $ErrorActionPreference=Stop.
    # A stopped Docker daemon is an expected probe result, so keep this
    # command non-terminating and decide readiness from its exit code.
    $ProbeErrorActionPreference = $ErrorActionPreference
    $ProbeExitCode = 1
    try {
        $ErrorActionPreference = "Continue"
        & $script:DockerCommand version --format "{{.Server.Version}}" 2>$null | Out-Null
        $ProbeExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $ProbeErrorActionPreference
    }
    return $ProbeExitCode -eq 0
}

function Wait-DockerServer {
    for ($Attempt = 0; $Attempt -lt 180; $Attempt++) {
        if (Test-DockerServer) {
            return $true
        }
        Start-Sleep -Seconds 2
    }
    return $false
}

function Start-DockerDesktop {
    $DesktopCommand = Resolve-DockerDesktopCommand
    if ([string]::IsNullOrWhiteSpace($DesktopCommand)) {
        return $false
    }
    if (-not (Get-Process -Name "Docker Desktop" -ErrorAction SilentlyContinue)) {
        Start-Process -FilePath $DesktopCommand | Out-Null
    }
    return $true
}

function Confirm-DockerDesktopLicense {
    if ($AcceptDockerLicense) {
        return
    }

    Write-Host "Docker Desktop is required and is governed by the Docker Desktop Subscription Service Agreement." -ForegroundColor Yellow
    Write-Host "Review: https://www.docker.com/legal/docker-subscription-service-agreement/"
    $Consent = Read-Host "Type YES to accept and continue"
    if ($Consent -cne "YES") {
        throw "Docker Desktop license was not accepted. No Docker installation was started."
    }
    $script:AcceptDockerLicense = $true
}

function Install-DockerDesktop {
    if (-not $AcceptDockerLicense) {
        throw "Docker Desktop is missing. Run the documented one-line command, which includes -AcceptDockerLicense after you review the Docker Desktop Subscription Service Agreement."
    }

    $InstallerPath = Join-Path $env:TEMP "Auto-Voucher-Docker-Desktop-Installer.exe"
    try {
        Write-Host "[Auto Voucher] Downloading Docker Desktop from the mainland accelerator..." -ForegroundColor Cyan
        Invoke-WebRequest -UseBasicParsing -Uri $DockerDesktopUrl -OutFile $InstallerPath -TimeoutSec 1800

        $Signature = Get-AuthenticodeSignature -LiteralPath $InstallerPath
        if ($Signature.Status -ne "Valid" -or $null -eq $Signature.SignerCertificate -or $Signature.SignerCertificate.Subject -notmatch "O=Docker Inc") {
            throw "Docker Desktop installer signature validation failed. The file was not executed."
        }

        Write-Host "[Auto Voucher] Installing Docker Desktop with the WSL 2 backend..." -ForegroundColor Cyan
        $Process = Start-Process -FilePath $InstallerPath -ArgumentList @(
            "install",
            "--user",
            "--accept-license",
            "--backend=wsl-2",
            "--no-windows-containers"
        ) -Wait -PassThru
        if ($Process.ExitCode -eq 3010) {
            throw "Docker Desktop was installed, but Windows must restart. Restart Windows and run the same one-line command again."
        }
        if ($Process.ExitCode -ne 0) {
            throw "Docker Desktop installation failed with exit code $($Process.ExitCode)."
        }
    }
    finally {
        if (Test-Path -LiteralPath $InstallerPath) {
            Remove-Item -LiteralPath $InstallerPath -Force -ErrorAction SilentlyContinue
        }
    }

    $script:DockerCommand = Resolve-DockerCommand
    if ([string]::IsNullOrWhiteSpace($script:DockerCommand)) {
        throw "Docker Desktop was installed, but docker.exe is not available yet. Restart Windows and run the same one-line command again."
    }
}

function Invoke-Docker {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    & $script:DockerCommand @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "Docker command failed with exit code $LASTEXITCODE."
    }
}

function Pull-AutoVoucherImage {
    param([Parameter(Mandatory = $true)][string]$SelectedImage)

    Write-Host "[Auto Voucher] Pulling prebuilt image: $SelectedImage" -ForegroundColor Cyan
    try {
        Invoke-Docker -Arguments @("pull", $SelectedImage)
        return $SelectedImage
    }
    catch {
        if ($SelectedImage -ne "ghcr.m.daocloud.io/honghudavy-star/auto-voucher:latest") {
            throw
        }
        $SelectedImage = $CanonicalImage
        Write-Host "[Auto Voucher] Mainland accelerator failed. Trying canonical GHCR automatically: $SelectedImage" -ForegroundColor Yellow
        Invoke-Docker -Arguments @("pull", $SelectedImage)
        return $SelectedImage
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
        $Status = (& $script:DockerCommand inspect --format "{{.State.Health.Status}}" $ContainerName 2>$null)
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
$SelectedImage = $Image

try {
    if ($env:OS -ne "Windows_NT") {
        throw "This installer must be run from Windows PowerShell."
    }

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $script:DockerCommand = Resolve-DockerCommand
    if ([string]::IsNullOrWhiteSpace($script:DockerCommand)) {
        Confirm-DockerDesktopLicense
    }
    Ensure-WslReady
    if ([string]::IsNullOrWhiteSpace($script:DockerCommand)) {
        Install-DockerDesktop
    }

    if (-not (Test-DockerServer)) {
        Write-Host "[Auto Voucher] Starting Docker Desktop..." -ForegroundColor Cyan
        if (-not (Start-DockerDesktop)) {
            throw "Docker Desktop is installed but could not be started. Start it in Linux containers / WSL 2 mode and run the same command again."
        }
        if (-not (Wait-DockerServer)) {
            throw "Docker Desktop did not become ready. If WSL 2 was just enabled, restart Windows and run the same one-line command again."
        }
    }

    if ($DockerOnly) {
        Write-Host ""
        Write-Host "Docker Desktop and WSL 2 are ready." -ForegroundColor Green
        Write-Host "Run this script again without -DockerOnly to install Auto Voucher."
        exit 0
    }

    $SelectedImage = Pull-AutoVoucherImage -SelectedImage $SelectedImage

    $ExistingContainerId = (& $script:DockerCommand ps --all --quiet --filter "name=^/$ContainerName$")
    if ($LASTEXITCODE -ne 0) {
        throw "Could not inspect existing Docker containers."
    }
    $ExistingContainer = -not [string]::IsNullOrWhiteSpace($ExistingContainerId)
    if ($ExistingContainer) {
        $PreviousImageId = (& $script:DockerCommand inspect --format "{{.Image}}" $ContainerName)
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($PreviousImageId)) {
            throw "Could not read the existing Auto Voucher image for safe rollback."
        }
        Write-Host "[Auto Voucher] Replacing the existing container without deleting its data volume" -ForegroundColor Cyan
        Invoke-Docker -Arguments @("rm", "--force", $ContainerName)
    }

    & $script:DockerCommand volume create $VolumeName | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Could not create or reuse Docker volume $VolumeName."
    }

    Start-AutoVoucherContainer -SelectedImage $SelectedImage
    if (-not (Wait-AutoVoucherHealthy)) {
        & $script:DockerCommand logs --tail 200 $ContainerName | Out-Host
        throw "The new Auto Voucher container did not become healthy."
    }

    $Health = Invoke-RestMethod -Uri ($AppUrl + "api/health") -TimeoutSec 10
    if (-not $Health.ok -or $Health.databaseStatus -ne "ok" -or -not $Health.staticAssets) {
        throw "Auto Voucher started but did not pass its application health check."
    }

    $ImageId = (& $script:DockerCommand inspect --format "{{.Image}}" $ContainerName)
    Write-Host ""
    Write-Host "Auto Voucher is ready: $AppUrl" -ForegroundColor Green
    Write-Host "Image: $SelectedImage"
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
            & $script:DockerCommand rm --force $ContainerName 2>$null | Out-Null
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
