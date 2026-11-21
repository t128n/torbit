#requires -Version 5.1
# Packaging checks (smoke.ps1 style, no Pester): scripts parse, the release zip carries the
# bridge binary binary and its docs, and install.ps1 + the env example know the bridge registry path.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$failed = 0
function Test-Case([string]$Name, [scriptblock]$Body) {
    try { & $Body; Write-Host "PASS $Name" } catch { Write-Host "FAIL $Name : $($_.Exception.Message)"; $script:failed++ }
}
function Assert-True($Cond, [string]$Message) { if (-not $Cond) { throw $Message } }

foreach ($rel in 'scripts/package.ps1', 'scripts/build-bridge.ps1', 'windows/install.ps1', 'windows/uninstall.ps1') {
    Test-Case "parse $rel" {
        $errors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root $rel), [ref]$null, [ref]$errors)
        Assert-True ($errors.Count -eq 0) ($errors | ForEach-Object { $_.Message } | Out-String)
    }
}

Test-Case 'install.ps1 handles the registry path and ACLs' {
    $text = Get-Content -Raw (Join-Path $root 'windows/install.ps1')
    Assert-True ($text -match 'ORBIT_MAIL_BRIDGE_REGISTRY_PATH') 'install.ps1 does not read ORBIT_MAIL_BRIDGE_REGISTRY_PATH'
    Assert-True ($text -match 'Set-DirectoryAcl \$RegistryDir') 'install.ps1 does not apply the directory ACL to the registry directory'
    # always, not only for a directory outside the data directory and not only when the file exists
    $block = $text.Substring($text.IndexOf('$RegistryDir = '))
    $block = $block.Substring(0, $block.IndexOf('Write-Host "Bridge registry'))
    Assert-True ($block -notmatch 'StartsWith') 'the registry directory ACL must not depend on where the directory is'
    Assert-True ($block -match '(?m)^    Set-DirectoryAcl \$RegistryDir') 'the registry directory ACL must be applied unconditionally'
}
Test-Case 'env example documents the registry path as opt-in' {
    $text = Get-Content -Raw (Join-Path $root 'windows/torbit.env.example')
    Assert-True ($text -match '(?m)^# ORBIT_MAIL_BRIDGE_REGISTRY_PATH=') 'example must carry a commented-out ORBIT_MAIL_BRIDGE_REGISTRY_PATH'
    Assert-True ($text -notmatch '(?m)^ORBIT_MAIL_BRIDGE_REGISTRY_PATH=') 'registry path must not be enabled by default'
}

Test-Case 'package zip contains bridge and docs' {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('torbit-pkg-' + [guid]::NewGuid())
    try {
        $repo = Join-Path $tmp 'repo'
        New-Item -ItemType Directory -Force (Join-Path $repo 'target/release'), (Join-Path $repo '.git') | Out-Null
        Set-Content (Join-Path $repo 'target/release/orbit.exe') 'fake' -Encoding ascii
        $out = Join-Path $tmp 'out'
        $dist = Join-Path $root 'bridge/dist'
        $madeDist = -not (Test-Path (Join-Path $dist 'torbit-bridge.exe'))
        if ($madeDist) { New-Item -ItemType Directory -Force $dist | Out-Null; Set-Content (Join-Path $dist 'torbit-bridge.exe') 'fake' -Encoding ascii }
        try { & (Join-Path $root 'scripts/package.ps1') -RepoPath $repo -OutputDir $out -Version '0.0.0-test' | Out-Null }
        finally { if ($madeDist) { Remove-Item -Recurse -Force $dist } }
        $zip = Join-Path $out 'torbit-windows-x86_64-0.0.0-test.zip'
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $archive = [IO.Compression.ZipFile]::OpenRead($zip)
        try { $names = $archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') } } finally { $archive.Dispose() }
        Assert-True (Test-Path (Join-Path $out 'torbit-bridge-windows-x86_64-0.0.0-test.exe')) 'standalone bridge asset is missing'
        Assert-True ((Get-Content -Raw (Join-Path $out 'SHA256SUMS')) -match 'torbit-bridge-windows-x86_64-0.0.0-test\.exe') 'SHA256SUMS has no bridge entry'
        foreach ($want in 'bridge/torbit-bridge.exe', 'docs/bridge.md', 'docs/bridge-signing.md', 'install.ps1', 'torbit.env.example') {
            Assert-True ($names -contains $want) "zip is missing $want"
        }
    } finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}

if ($failed) { exit 1 }
Write-Host 'Packaging tests passed'
