param(
    [Parameter(Mandatory = $true)]
    [string]$Root
)

$ErrorActionPreference = "Stop"
$repository = "honghudavy-star/auto-voucher"
$headers = @{
    "User-Agent" = "AutoVoucher-Source-Updater"
    "Cache-Control" = "no-cache"
}

$localPackagePath = Join-Path $Root "package.json"
$localPackage = Get-Content -LiteralPath $localPackagePath -Raw | ConvertFrom-Json
$timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$remotePackageUrl = "https://files.m.daocloud.io/raw.githubusercontent.com/$repository/main/package.json?time=$timestamp"
$remotePackage = Invoke-RestMethod -Uri $remotePackageUrl -Headers $headers -TimeoutSec 15

$localVersion = [version]$localPackage.version
$remoteVersion = [version]$remotePackage.version
if ($remoteVersion -le $localVersion) {
    Write-Output "Auto Voucher source is current: $localVersion"
    exit 0
}

$temporaryRoot = Join-Path $env:TEMP "auto-voucher-source-update"
$archivePath = Join-Path $temporaryRoot "main.zip"
$expandedPath = Join-Path $temporaryRoot "expanded"
if (Test-Path -LiteralPath $temporaryRoot) {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $temporaryRoot | Out-Null

try {
    Invoke-WebRequest `
        -Uri "https://files.m.daocloud.io/github.com/$repository/archive/refs/heads/main.zip" `
        -Headers $headers `
        -OutFile $archivePath `
        -TimeoutSec 60
    Expand-Archive -LiteralPath $archivePath -DestinationPath $expandedPath
    $source = Get-ChildItem -LiteralPath $expandedPath -Directory | Select-Object -First 1
    if ($null -eq $source) {
        throw "下载的源码压缩包结构无效"
    }

    $arguments = @(
        $source.FullName,
        $Root,
        "/E",
        "/R:2",
        "/W:1",
        "/NFL",
        "/NDL",
        "/NJH",
        "/NJS",
        "/NP",
        "/XD",
        ".git",
        ".venv",
        ".auto-voucher-runtime",
        ".auto-voucher-tools",
        "node_modules",
        "dist",
        "test-data",
        "/XF",
        "Start-Auto-Voucher.bat",
        "start-auto-voucher.bat",
        "source-update.ps1"
    )
    & robocopy @arguments | Out-Null
    if ($LASTEXITCODE -ge 8) {
        throw "源码更新复制失败，Robocopy 错误代码：$LASTEXITCODE"
    }
    Set-Content `
        -LiteralPath (Join-Path $Root ".auto-voucher-source-version") `
        -Value $remotePackage.version `
        -Encoding ASCII
    Write-Output "Auto Voucher source updated: $localVersion -> $remoteVersion"
} finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}

exit 0
