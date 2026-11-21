#requires -Version 5.1
# Torbit Outlook bridge command entry.
# Commands: enroll, run, backfill, status, revoke, install-autostart, remove-autostart.
param(
    [Parameter(Position = 0, Mandatory)]
    [ValidateSet('enroll', 'run', 'backfill', 'status', 'revoke', 'install-autostart', 'remove-autostart')][string]$Command,
    [string]$Server,
    [string]$Workspace,
    [string]$Name,
    [securestring]$SessionToken,
    [securestring]$ApiToken,
    [switch]$Force,
    [DateTime]$Since,
    [int]$IntervalSeconds = 300,
    [switch]$LocalOnly
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$scriptPath = $MyInvocation.MyCommand.Path
Import-Module (Join-Path $here 'TorbitBridge.psm1') -Force

function ConvertFrom-Secure([securestring]$s) {
    $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }
}

function Get-EnrolledConfig {
    $cfg = Read-BridgeConfig
    if (-not $cfg) { throw 'This computer is not enrolled. Run: .\bridge.ps1 enroll' }
    return $cfg
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
        'run' {
            $cfg = Get-EnrolledConfig
            # One run per user session: the logon task and a manual start must not both deliver.
            $created = $false
            $mutex = New-Object Threading.Mutex($true, 'Local\TorbitBridgeRun', [ref]$created)
            if (-not $created) { $mutex.Dispose(); throw 'The bridge is already running for this user.' }
            try {
                $adapter = New-OutlookAdapter
                $signer = Get-BridgeSigner $cfg
                Write-BridgeLog 'run started'
                Invoke-BridgeRun -Config $cfg -Signer $signer -Adapter $adapter -IntervalSeconds $IntervalSeconds
            } finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
        }
        'backfill' {
            $cfg = Get-EnrolledConfig
            if (-not $PSBoundParameters.ContainsKey('Since')) { throw 'backfill needs a start date, for example: -Since 2026-01-01' }
            $r = Invoke-BridgeBackfill -Config $cfg -Signer (Get-BridgeSigner $cfg) -Adapter (New-OutlookAdapter) -Since $Since
            Write-Host ('Backfill: {0} delivered, {1} skipped (rejected by Orbit), {2} not delivered yet.' -f $r.Delivered, $r.Skipped, $r.Pending)
            if ($r.Pending -gt 0) { Write-Host 'Orbit was not reachable for some items. Run backfill again later; delivered items are not sent twice.' }
        }
        'status' {
            $s = Get-BridgeStatus
            if (-not $s.Enrolled) { Write-Host 'Not enrolled. Run: .\bridge.ps1 enroll'; break }
            $keyState = 'MISSING; enroll again'
            if ($s.KeyPresent) { $keyState = 'present' }
            $lastRun = 'never'
            if ($s.LastRun) { $lastRun = $s.LastRun }
            $auto = 'off'
            if ((Get-BridgeAutostart).Installed) { $auto = 'on' }
            Write-Host ('Device:    {0}' -f $s.DeviceId)
            Write-Host ('Server:    {0}' -f $s.Server)
            Write-Host ('Address:   {0}' -f $s.Address)
            Write-Host ('Key:       {0} ({1})' -f $s.KeyProvider, $keyState)
            Write-Host ('Last run:  {0}' -f $lastRun)
            Write-Host ('Delivered: {0}   Skipped: {1}   Waiting to retry: {2}' -f $s.Delivered, $s.Skipped, $s.Pending)
            Write-Host ('Autostart: {0}' -f $auto)
        }
        'revoke' {
            if ($LocalOnly) { Invoke-BridgeRevoke -LocalOnly }
            else {
                $kind = 'session'
                $secure = $SessionToken
                if ($ApiToken) { $kind = 'api'; $secure = $ApiToken }
                if (-not $secure) { $secure = Read-Host 'Orbit session token (value of the __Host-orbit_session cookie)' -AsSecureString }
                Invoke-BridgeRevoke -Credential (ConvertFrom-Secure $secure) -CredentialKind $kind
            }
            Remove-BridgeAutostart
            Write-Host 'Device revoked. The local key, config and state are removed.'
        }
        'install-autostart' {
            Install-BridgeAutostart -ScriptPath $scriptPath
            Write-Host 'The bridge now starts when you sign in to Windows.'
        }
        'remove-autostart' {
            Remove-BridgeAutostart
            Write-Host 'Autostart removed.'
        }
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
