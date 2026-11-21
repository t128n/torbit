#requires -Version 5.1
# Builds the Outlook bridge (bridge/, Go) into bridge/dist/torbit-bridge.exe.
[CmdletBinding()]
param([string]$Version)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot/lib/common.ps1"

if (-not (Get-Command go -ErrorAction SilentlyContinue)) { throw "go is not on PATH" }
if (-not $Version) { $Version = (Get-Content (Join-Path $script:TorbitRoot "VERSION") -Raw).Trim() }
if ($Version -notmatch '^[0-9A-Za-z.+-]+$') { throw "invalid version '$Version'" }

$bridge = Join-Path $script:TorbitRoot "bridge"
$out = Join-Path $bridge "dist/torbit-bridge.exe"
New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null

Write-Step "Building torbit-bridge.exe $Version"
Push-Location $bridge
try {
    $env:GOOS = "windows"; $env:GOARCH = "amd64"; $env:CGO_ENABLED = "0"
    & go build -trimpath -ldflags "-s -w -X main.version=$Version" -o $out .
    Assert-LastExitCode "go build"
} finally {
    Pop-Location
    Remove-Item Env:GOOS, Env:GOARCH, Env:CGO_ENABLED -ErrorAction SilentlyContinue
}
Write-Host "Built $out"
