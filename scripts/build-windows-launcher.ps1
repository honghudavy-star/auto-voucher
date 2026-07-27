[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')]
    [string]$Version,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^https://')]
    [string]$ManifestUrl,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9+/]{43}=$')]
    [string]$ManifestPublicKey,

    [Parameter(Mandatory = $true)]
    [string]$Output
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$launcherRoot = Join-Path $repositoryRoot 'launcher'
$packageJsonPath = Join-Path $repositoryRoot 'package.json'
$pyprojectPath = Join-Path $repositoryRoot 'pyproject.toml'

$packageVersion = (Get-Content $packageJsonPath -Raw | ConvertFrom-Json).version
$pyprojectMatch = [regex]::Match(
    (Get-Content $pyprojectPath -Raw),
    '(?m)^version\s*=\s*"([^"]+)"\s*$'
)
if (-not $pyprojectMatch.Success) {
    throw 'pyproject.toml does not declare a project version'
}
$pyprojectVersion = $pyprojectMatch.Groups[1].Value
if ($Version -ne $packageVersion -or $Version -ne $pyprojectVersion) {
    throw "Release version $Version does not match package.json $packageVersion and pyproject.toml $pyprojectVersion"
}

$manifestUri = [uri]$ManifestUrl
$expectedManifestSuffix = "/stable/manifest.json"
if ($manifestUri.AbsolutePath -notlike "*$expectedManifestSuffix") {
    throw "Manifest URL path must end with $expectedManifestSuffix"
}

$goCommand = Get-Command go -ErrorAction Stop
$outputPath = if ([System.IO.Path]::IsPathRooted($Output)) {
    [System.IO.Path]::GetFullPath($Output)
}
else {
    [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $Output))
}
$outputDirectory = Split-Path -Parent $outputPath
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

Push-Location $launcherRoot
try {
    & $goCommand.Source test ./...
    if ($LASTEXITCODE -ne 0) {
        throw 'Go launcher tests failed'
    }

    & $goCommand.Source vet ./...
    if ($LASTEXITCODE -ne 0) {
        throw 'Go launcher vet failed'
    }

    $linkerFlags = @(
        '-s'
        '-w'
        '-H=windowsgui'
        "-X main.launcherVersion=$Version"
        "-X main.defaultManifestURL=$ManifestUrl"
        "-X main.releaseContract=$Version|$ManifestUrl"
        "-X main.manifestPublicKey=$ManifestPublicKey"
    ) -join ' '

    & $goCommand.Source build -trimpath -ldflags $linkerFlags -o $outputPath .
    if ($LASTEXITCODE -ne 0) {
        throw 'Go launcher build failed'
    }
}
finally {
    Pop-Location
}

if (-not (Test-Path $outputPath -PathType Leaf)) {
    throw "Launcher output was not created: $outputPath"
}

$buildMetadata = (& $goCommand.Source version -m $outputPath 2>&1) -join "`n"
foreach ($requiredSetting in @(
    "GOOS=windows",
    "GOARCH=amd64"
)) {
    if (-not $buildMetadata.Contains($requiredSetting)) {
        throw "Launcher build metadata is missing required setting: $requiredSetting"
    }
}

$binaryText = [System.Text.Encoding]::ASCII.GetString(
    [System.IO.File]::ReadAllBytes($outputPath)
)
foreach ($requiredValue in @(
    "$Version|$ManifestUrl",
    $ManifestPublicKey
)) {
    if (-not $binaryText.Contains($requiredValue)) {
        throw 'Launcher binary does not contain the required release contract'
    }
}

$launcher = Get-Item $outputPath
$digest = (Get-FileHash $outputPath -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Output "launcher_path=$($launcher.FullName)"
Write-Output "launcher_size=$($launcher.Length)"
Write-Output "launcher_sha256=$digest"
