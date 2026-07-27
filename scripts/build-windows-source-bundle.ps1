param(
    [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
if (-not $OutputPath) {
    $OutputPath = Join-Path $root "release\Auto-Voucher-Windows-$version.zip"
}

$outputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$stage = Join-Path $env:TEMP "auto-voucher-windows-source-$version"
if (Test-Path -LiteralPath $stage) {
    Remove-Item -LiteralPath $stage -Recurse -Force
}

try {
    $inner = Join-Path $stage "AutoVoucher"
    New-Item -ItemType Directory -Path $inner -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $root "Start-Auto-Voucher.bat") -Destination $stage

    $arguments = @(
        $root,
        $inner,
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
        ".github",
        ".codegraph",
        ".venv",
        ".auto-voucher-runtime",
        "node_modules",
        "dist",
        "release",
        "test-data",
        "/XF",
        ".DS_Store",
        "Start-Auto-Voucher.bat"
    )
    & robocopy @arguments | Out-Null
    if ($LASTEXITCODE -ge 8) {
        throw "Source bundle copy failed with Robocopy code $LASTEXITCODE"
    }

    if (Test-Path -LiteralPath $OutputPath) {
        Remove-Item -LiteralPath $OutputPath -Force
    }
    Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $OutputPath -CompressionLevel Optimal

    $topLevel = @(Get-ChildItem -LiteralPath $stage | Select-Object -ExpandProperty Name | Sort-Object)
    if (Compare-Object @("AutoVoucher", "Start-Auto-Voucher.bat") $topLevel) {
        throw "Bundle root must contain only Start-Auto-Voucher.bat and AutoVoucher"
    }
    Write-Output $OutputPath
} finally {
    if (Test-Path -LiteralPath $stage) {
        Remove-Item -LiteralPath $stage -Recurse -Force
    }
}
