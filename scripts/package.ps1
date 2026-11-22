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

# The Outlook bridge ships as one Bun-compiled binary (scripts/build-bridge.ps1), also as a standalone release asset
# that `torbit-bridge upgrade` downloads.
$bridgeExe = Join-Path $script:TorbitRoot "bridge/dist/torbit-bridge.exe"
if (-not (Test-Path $bridgeExe)) {
    throw "missing $bridgeExe; run scripts/build-bridge.ps1 first"
}
$bridgeStage = Join-Path $stage "bridge"
New-Item -ItemType Directory -Force $bridgeStage | Out-Null
Copy-Item $bridgeExe (Join-Path $bridgeStage "torbit-bridge.exe")
$bridgeAsset = "torbit-bridge-windows-x86_64-$Version.exe"
Copy-Item $bridgeExe (Join-Path $OutputDir $bridgeAsset) -Force

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
$bridgeHash = (Get-FileHash (Join-Path $OutputDir $bridgeAsset) -Algorithm SHA256).Hash.ToLowerInvariant()
$checksums = Join-Path $OutputDir "SHA256SUMS"
Set-Content -Path $checksums -Value @("$hash  $name.zip", "$bridgeHash  $bridgeAsset") -Encoding ascii

Write-Host "Packaged $zip"
Write-Host "SHA256 $hash"
