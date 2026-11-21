#requires -Version 5.1
# Worbit Outlook bridge command entry. Commands: enroll (run, backfill, status, revoke follow).
param(
    [Parameter(Position = 0, Mandatory)][ValidateSet('enroll')][string]$Command,
    [string]$Server,
    [string]$Workspace,
    [string]$Name,
    [securestring]$SessionToken,
    [securestring]$ApiToken,
    [switch]$Force
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Import-Module (Join-Path $here 'WorbitBridge.psm1') -Force

function ConvertFrom-Secure([securestring]$s) {
    $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }
}

try {
    switch ($Command) {
        'enroll' {
            if (-not $Server) { $Server = Read-Host 'Orbit server URL (https://...)' }
            if (-not $Workspace) { $Workspace = Read-Host 'Workspace id' }
            $kind = 'session'
            $secure = $SessionToken
            if ($ApiToken) { $kind = 'api'; $secure = $ApiToken }
            if (-not $secure) { $secure = Read-Host 'Orbit session token (value of the __Host-orbit_session cookie)' -AsSecureString }
            $cfg = Invoke-BridgeEnroll -Server $Server -WorkspaceId $Workspace -Credential (ConvertFrom-Secure $secure) `
                -CredentialKind $kind -Name $Name -Force:$Force
            Write-Host ('Enrolled. Device {0} delivers to {1}. Key stored in: {2}.' -f $cfg.device_id, $cfg.address, $cfg.key_provider)
        }
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
