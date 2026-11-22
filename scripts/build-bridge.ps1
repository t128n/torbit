#requires -Version 5.1
# Builds the Outlook bridge (bridge/, TypeScript) into one executable, bridge/dist/torbit-bridge.exe, with Bun.
[CmdletBinding()]
param([string]$Version)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot/lib/common.ps1"

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { throw "bun is not on PATH" }
if (-not $Version) { $Version = (Get-Content (Join-Path $script:TorbitRoot "VERSION") -Raw).Trim() }
if ($Version -notmatch '^[0-9A-Za-z.+-]+$') { throw "invalid version '$Version'" }

$bridge = Join-Path $script:TorbitRoot "bridge"
$out = Join-Path $bridge "dist/torbit-bridge.exe"

Write-Step "Building torbit-bridge.exe $Version"
Push-Location $bridge
try {
    & bun install --frozen-lockfile
    Assert-LastExitCode "bun install"
    & bun run scripts/build.ts $Version
    Assert-LastExitCode "bun build"
} finally {
    Pop-Location
}
if (-not (Test-Path $out)) { throw "missing $out after the build" }
Write-Host "Built $out"
