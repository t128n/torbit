#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$RepoPath,
    [string]$OutputDir,
    [string]$Version
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot/lib/common.ps1"

$repo = Resolve-OrbitRepo -RepoPath $RepoPath
if (-not $Version) {
    $Version = (Get-Content (Join-Path $script:TorbitRoot "VERSION") -Raw).Trim()
}
if ($Version -notmatch '^[0-9A-Za-z.+-]+$') {
    throw "invalid version '$Version'; use the VERSION file or a SemVer value"
}
if (-not $OutputDir) {
    $OutputDir = Join-Path $script:TorbitRoot "artifacts"
}
New-Item -ItemType Directory -Force $OutputDir | Out-Null

$name = "torbit-windows-x86_64-$Version"
$stage = Join-Path $OutputDir $name
$zip = Join-Path $OutputDir "$name.zip"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
if (Test-Path $zip) { Remove-Item -Force $zip }
New-Item -ItemType Directory -Force $stage | Out-Null

$binary = Join-Path $repo "target/release/orbit.exe"
if (-not (Test-Path $binary)) {
    throw "missing $binary; run scripts/build.ps1 first"
}
Copy-Item $binary (Join-Path $stage "orbit.exe")

$windows = Join-Path $script:TorbitRoot "windows"
foreach ($file in @("install.ps1", "uninstall.ps1", "torbit.env.example", "README.md")) {
    Copy-Item (Join-Path $windows $file) (Join-Path $stage $file)
}

# The Outlook bridge ships as scripts next to install.ps1 (bridge/bridge.ps1 and its module).
$bridgeStage = Join-Path $stage "bridge"
New-Item -ItemType Directory -Force $bridgeStage | Out-Null
foreach ($file in @("bridge.ps1", "TorbitBridge.psm1")) {
    Copy-Item (Join-Path (Join-Path $windows "bridge") $file) (Join-Path $bridgeStage $file)
}

foreach ($file in @("LICENSE", "NOTICE", "VERSION")) {
    Copy-Item (Join-Path $script:TorbitRoot $file) (Join-Path $stage $file)
}

$docs = Join-Path $stage "docs"
New-Item -ItemType Directory -Force $docs | Out-Null
foreach ($file in @("deploy-windows.md", "upgrade.md", "github-enterprise.md", "bridge.md", "bridge-signing.md")) {
    Copy-Item (Join-Path (Join-Path $script:TorbitRoot "docs") $file) (Join-Path $docs $file)
}

Write-Step "Creating $zip"
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal

$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
$checksums = Join-Path $OutputDir "SHA256SUMS"
Set-Content -Path $checksums -Value "$hash  $name.zip" -Encoding ascii

Write-Host "Packaged $zip"
Write-Host "SHA256 $hash"
