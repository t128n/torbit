# Independently verifies tests/bridge-vectors.json with .NET ECDsa.
# Compatible with Windows PowerShell 5.1 (.NET Framework 4.x). Exit code 0 = all pass.
param([string]$VectorFile = (Join-Path $PSScriptRoot 'bridge-vectors.json'))
$ErrorActionPreference = 'Stop'

function Get-Sha256Hex([byte[]]$Bytes) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

# SPKI for P-256 ends with the 65-byte uncompressed point 04||X||Y.
function New-VerifierKey([string]$SpkiBase64) {
    $der = [Convert]::FromBase64String($SpkiBase64)
    if ($der.Length -ne 91 -or $der[26] -ne 4) { throw 'Not a P-256 uncompressed SPKI key' }
    $blob = New-Object System.Collections.Generic.List[byte]
    $blob.AddRange([byte[]](0x45, 0x43, 0x53, 0x31, 0x20, 0x00, 0x00, 0x00)) # "ECS1", 32
    $blob.AddRange([byte[]]($der[27..90]))
    $cng = [System.Security.Cryptography.CngKey]::Import($blob.ToArray(), [System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
    return New-Object System.Security.Cryptography.ECDsaCng($cng)
}

$doc = Get-Content -Raw -Encoding UTF8 -Path $VectorFile | ConvertFrom-Json
$key = New-VerifierKey $doc.public_key_spki_base64
$utf8 = New-Object System.Text.UTF8Encoding($false)
$sha = [System.Security.Cryptography.SHA256]::Create()
$pathPrefix = '/api/v1/mail/inbound/bridge/'
$failed = 0

foreach ($v in $doc.vectors) {
    $body = [Convert]::FromBase64String($v.body_base64)
    $ts = $v.headers.'X-Worbit-Timestamp'
    $nonce = $v.headers.'X-Worbit-Nonce'
    $sigB64 = $v.headers.'X-Worbit-Signature'
    $dev = $v.path.Substring($pathPrefix.Length)

    $str = 'worbit-bridge-v1' + "`n" + $ts + "`n" + $nonce + "`n" + $dev + "`n" + (Get-Sha256Hex $body)
    $sigOk = $false
    $sig = [Convert]::FromBase64String($sigB64)
    if ($sig.Length -eq 64) {
        $sigOk = $key.VerifyHash($sha.ComputeHash($utf8.GetBytes($str)), $sig)
    }
    $delta = [int64]$ts - [int64]$doc.now_unix
    $inWin = ([Math]::Abs($delta) -le $doc.window_seconds)
    $status = 200
    if (-not $sigOk -or -not $inWin) { $status = 401 }

    # For untampered requests the documented signed string must match exactly.
    $strOk = $true
    if ($sigOk) { $strOk = ($str -ceq $v.signed_string_of_original) }

    $pass = ($sigOk -eq $v.expect.signature_valid) -and ($inWin -eq $v.expect.timestamp_in_window) -and ($status -eq $v.expect.status) -and $strOk
    if ($pass) { Write-Host "PASS $($v.name)" } else { Write-Host "FAIL $($v.name) sig=$sigOk window=$inWin status=$status strOk=$strOk"; $failed++ }
}
if ($failed -gt 0) { Write-Host "$failed vector(s) failed"; exit 1 }
Write-Host "All $($doc.vectors.Count) vectors OK"
exit 0
