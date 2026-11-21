#requires -Version 5.1
# Bridge core tests (smoke.ps1 style, no Pester). Uses a fake Outlook adapter and a fake HTTP transport.
# Real Outlook COM and the TPM stay manual. Exit code 0 = all pass.
param([string]$VectorFile)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $VectorFile) { $VectorFile = Join-Path $here 'bridge-vectors.json' }

$modulePath = Join-Path $here '..\windows\bridge\WorbitBridge.psm1'
Import-Module $modulePath -Force

$script:failed = 0
$script:passed = 0
function Test-Case([string]$Name, [scriptblock]$Body) {
    try { & $Body; Write-Host "PASS $Name"; $script:passed++ }
    catch { Write-Host "FAIL $Name : $($_.Exception.Message)"; $script:failed++ }
}
function Assert-True($Cond, [string]$Message) { if (-not $Cond) { throw $Message } }
function Assert-Equal($Actual, $Expected, [string]$Message) {
    if (-not ($Actual -ceq $Expected)) { throw "$Message (expected '$Expected', got '$Actual')" }
}

# ---- independent test-side helpers (do not reuse module code for expectations)

function New-VerifierKey([string]$SpkiBase64) {
    $der = [Convert]::FromBase64String($SpkiBase64)
    if ($der.Length -ne 91 -or $der[26] -ne 4) { throw 'Not a P-256 uncompressed SPKI key' }
    $blob = New-Object System.Collections.Generic.List[byte]
    $blob.AddRange([byte[]](0x45, 0x43, 0x53, 0x31, 0x20, 0x00, 0x00, 0x00))
    $blob.AddRange([byte[]]($der[27..90]))
    $cng = [Security.Cryptography.CngKey]::Import($blob.ToArray(), [Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
    return New-Object Security.Cryptography.ECDsaCng($cng)
}
function Test-Signature($Verifier, [string]$SignedString, [string]$SigB64) {
    $sig = [Convert]::FromBase64String($SigB64)
    if ($sig.Length -ne 64) { return $false }
    $sha = [Security.Cryptography.SHA256]::Create()
    return $Verifier.VerifyHash($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($SignedString)), $sig)
}
function Get-HexSha256([byte[]]$b) {
    $sha = [Security.Cryptography.SHA256]::Create()
    return ([BitConverter]::ToString($sha.ComputeHash($b))).Replace('-', '').ToLowerInvariant()
}

# Minimal MIME parser. Returns @{ Headers = list of @{Name;Value}; Params; Body (bytes); Parts }.
function Split-Mime([byte[]]$Bytes) {
    $text = [Text.Encoding]::ASCII.GetString($Bytes)   # builder output must be pure 7-bit
    if ($text -cmatch '[^\x00-\x7F]') { throw 'MIME contains non-ASCII bytes' }
    if ($text -cmatch '(?<!\r)\n') { throw 'bare LF in MIME' }
    $i = $text.IndexOf("`r`n`r`n")
    if ($i -lt 0) { throw 'no header/body separator' }
    $head = $text.Substring(0, $i)
    $body = $text.Substring($i + 4)
    $hdrs = New-Object Collections.Generic.List[object]
    foreach ($l in ($head -split "`r`n")) {
        if ($l -match '^[ \t]') { $hdrs[$hdrs.Count - 1].Value += ' ' + $l.Trim() }
        else { $c = $l.IndexOf(':'); $hdrs.Add(@{ Name = $l.Substring(0, $c); Value = $l.Substring($c + 1).Trim() }) }
    }
    $entity = @{ Headers = $hdrs; BodyText = $body; Parts = @() }
    $ct = Get-Hdr $entity 'content-type'
    if ($ct -and $ct -match '^multipart/') {
        $b = [regex]::Match($ct, 'boundary="([^"]+)"').Groups[1].Value
        $segments = $body -split ([regex]::Escape("--$b"))
        $parts = @()
        for ($k = 1; $k -lt $segments.Count; $k++) {
            $seg = $segments[$k]
            if ($seg.StartsWith('--')) { break }
            $seg = $seg.Substring(2)               # CRLF after the delimiter
            if ($seg.EndsWith("`r`n")) { $seg = $seg.Substring(0, $seg.Length - 2) }
            $parts += , (Split-Mime ([Text.Encoding]::ASCII.GetBytes($seg)))
        }
        $entity.Parts = $parts
    }
    return $entity
}
function Get-Hdr($Entity, [string]$Name) {
    foreach ($h in $Entity.Headers) { if ($h.Name -ieq $Name) { return $h.Value } }
    return $null
}
function Get-DecodedBody($Entity) {
    $cte = Get-Hdr $Entity 'content-transfer-encoding'
    if ($cte -ne 'base64') { throw "unexpected transfer encoding $cte" }
    return [Convert]::FromBase64String(($Entity.BodyText -replace '\s', ''))
}
function Get-Utf8Body($Entity) { [Text.Encoding]::UTF8.GetString((Get-DecodedBody $Entity)) }

function New-FakeItem($Overrides) {
    $item = @{
        EntryId = 'ENTRY-0001'; Subject = 'Hello'; SenderName = 'Alice'; SenderEmail = 'alice@example.com'
        To = 'bob@example.com'; ReceivedTime = [DateTime]::SpecifyKind([DateTime]'2026-03-04T05:06:07', 'Utc')
        TransportHeaders = "Received: from mx.example.com by host`r`n with ESMTP; Wed, 4 Mar 2026 05:06:07 +0000`r`nFrom: Alice <alice@example.com>`r`nTo: bob@example.com`r`nSubject: Hello`r`nDate: Wed, 04 Mar 2026 05:06:00 +0000`r`nMessage-ID: <abc@example.com>`r`nContent-Type: text/plain; charset=us-ascii`r`nMIME-Version: 1.0`r`nContent-Transfer-Encoding: 7bit`r`n"
        Body = "Hi Bob,`r`nsee you.`r`n"; HtmlBody = ''; Attachments = @()
    }
    foreach ($k in @($Overrides.Keys)) { $item[$k] = $Overrides[$k] }
    return [pscustomobject]$item
}

# Fake Outlook adapter: same contract as New-OutlookAdapter.
function New-FakeAdapter($Items) {
    $a = New-Object psobject
    $a | Add-Member -MemberType NoteProperty -Name Items -Value $Items
    $a | Add-Member -MemberType ScriptMethod -Name GetInboxItems -Value { param([DateTime]$Since) , $this.Items }
    return $a
}

$doc = Get-Content -Raw -Encoding UTF8 -Path $VectorFile | ConvertFrom-Json
$verifier = New-VerifierKey $doc.public_key_spki_base64
$vectorCng = [Security.Cryptography.CngKey]::Import([Convert]::FromBase64String($doc.private_key_pkcs8_base64), [Security.Cryptography.CngKeyBlobFormat]::Pkcs8PrivateBlob)
$vectorSigner = New-BridgeSigner $vectorCng

# ---- signing against the shared vectors

Test-Case 'signed string matches every untampered vector' {
    $n = 0
    foreach ($v in $doc.vectors) {
        if (-not $v.expect.signature_valid) { continue }
        $dev = $v.path.Substring('/api/v1/mail/inbound/bridge/'.Length)
        $s = Get-BridgeSignedString $v.headers.'X-Worbit-Timestamp' $v.headers.'X-Worbit-Nonce' $dev ([Convert]::FromBase64String($v.body_base64))
        Assert-Equal $s $v.signed_string_of_original "signed string for $($v.name)"
        $n++
    }
    Assert-True ($n -ge 4) 'expected several valid vectors'
}

Test-Case 'module signatures verify under the vector rules and fail when tampered' {
    foreach ($v in $doc.vectors) {
        if (-not $v.expect.signature_valid) { continue }
        $body = [Convert]::FromBase64String($v.body_base64)
        $h = New-BridgeRequestHeaders -DeviceId $doc.device_id -Body $body -Signer $vectorSigner `
            -Timestamp $v.headers.'X-Worbit-Timestamp' -Nonce $v.headers.'X-Worbit-Nonce'
        Assert-Equal $h.'X-Worbit-Timestamp' $v.headers.'X-Worbit-Timestamp' 'timestamp passthrough'
        Assert-True (([Convert]::FromBase64String($h.'X-Worbit-Signature')).Length -eq 64) 'P1363 is 64 bytes'
        Assert-Equal $h.'X-Worbit-Signature'.Length 88 'base64 with padding is 88 chars'
        Assert-True (Test-Signature $verifier $v.signed_string_of_original $h.'X-Worbit-Signature') "signature verifies for $($v.name)"
        $tampered = Get-BridgeSignedString $h.'X-Worbit-Timestamp' $h.'X-Worbit-Nonce' 'other-device' $body
        Assert-True (-not (Test-Signature $verifier $tampered $h.'X-Worbit-Signature')) 'wrong device must not verify'
    }
}

Test-Case 'default timestamp and nonce follow the field rules' {
    $h = New-BridgeRequestHeaders -DeviceId $doc.device_id -Body ([byte[]]@(1, 2, 3)) -Signer $vectorSigner
    Assert-True ($h.'X-Worbit-Timestamp' -cmatch '^[1-9][0-9]*$') 'timestamp digits only'
    Assert-True ($h.'X-Worbit-Nonce' -cmatch '^[A-Za-z0-9_-]{22}$') 'nonce is 22 base64url chars'
    $h2 = New-BridgeRequestHeaders -DeviceId $doc.device_id -Body ([byte[]]@(1, 2, 3)) -Signer $vectorSigner
    Assert-True ($h.'X-Worbit-Nonce' -ne $h2.'X-Worbit-Nonce') 'nonce unique per request'
}

# ---- key store

Test-Case 'key is non-exportable P-256, public key is 91-byte SPKI that verifies signatures' {
    $name = 'Worbit-Bridge-test-' + [guid]::NewGuid().ToString('N')
    $prov = New-BridgeKey -Name $name -Provider 'Microsoft Software Key Storage Provider'
    try {
        $key = Open-BridgeKey $name $prov
        $spki = Get-BridgePublicKeySpki $key
        Assert-Equal ([Convert]::FromBase64String($spki)).Length 91 'SPKI length'
        $threw = $false
        try { [void]$key.Export([Security.Cryptography.CngKeyBlobFormat]::Pkcs8PrivateBlob) } catch { $threw = $true }
        Assert-True $threw 'private key export must fail'
        $h = New-BridgeRequestHeaders -DeviceId $doc.device_id -Body ([byte[]]@(9)) -Signer (New-BridgeSigner $key) -Timestamp '1790000000' -Nonce 'n-key_000001'
        $s = Get-BridgeSignedString '1790000000' 'n-key_000001' $doc.device_id ([byte[]]@(9))
        Assert-True (Test-Signature (New-VerifierKey $spki) $s $h.'X-Worbit-Signature') 'signature verifies with exported public key'
    } finally { Remove-BridgeKey $name $prov }
}

# ---- MIME rebuild

Test-Case 'plain text item becomes parseable MIME, transport headers kept, structure headers regenerated' {
    $m = Split-Mime (ConvertTo-MimeMessage -Item (New-FakeItem @{}))
    Assert-Equal (Get-Hdr $m 'subject') 'Hello' 'subject'
    Assert-Equal (Get-Hdr $m 'message-id') '<abc@example.com>' 'message-id kept'
    Assert-Equal (Get-Hdr $m 'date') 'Wed, 04 Mar 2026 05:06:00 +0000' 'date kept'
    Assert-True ((Get-Hdr $m 'received') -like 'from mx.example.com by host with ESMTP*') 'folded Received unfolded by parser'
    Assert-Equal (@($m.Headers | Where-Object { $_.Name -ieq 'content-type' }).Count) 1 'single content-type'
    Assert-Equal (@($m.Headers | Where-Object { $_.Name -ieq 'mime-version' }).Count) 1 'single mime-version'
    Assert-True ((Get-Hdr $m 'content-type') -like 'text/plain; charset=utf-8') 'content type regenerated'
    Assert-Equal (Get-Utf8Body $m) "Hi Bob,`r`nsee you.`r`n" 'body round trip'
}

Test-Case 'same item gives identical bytes' {
    $a = ConvertTo-MimeMessage -Item (New-FakeItem @{ HtmlBody = '<p>x</p>'; Attachments = @([pscustomobject]@{ FileName = 'a.bin'; MimeType = 'application/octet-stream'; ContentId = ''; IsInline = $false; Bytes = [byte[]](1..200) }) })
    $b = ConvertTo-MimeMessage -Item (New-FakeItem @{ HtmlBody = '<p>x</p>'; Attachments = @([pscustomobject]@{ FileName = 'a.bin'; MimeType = 'application/octet-stream'; ContentId = ''; IsInline = $false; Bytes = [byte[]](1..200) }) })
    Assert-Equal (Get-HexSha256 $a) (Get-HexSha256 $b) 'hash equal'
}

Test-Case 'text plus html becomes multipart/alternative with both bodies' {
    $m = Split-Mime (ConvertTo-MimeMessage -Item (New-FakeItem @{ HtmlBody = '<p>Gr&uuml;&szlig;e ä</p>' }))
    Assert-True ((Get-Hdr $m 'content-type') -like 'multipart/alternative*') 'alternative'
    Assert-Equal $m.Parts.Count 2 'two parts'
    Assert-True ((Get-Hdr $m.Parts[0] 'content-type') -like 'text/plain*') 'plain first'
    Assert-True ((Get-Hdr $m.Parts[1] 'content-type') -like 'text/html*') 'html last'
    Assert-Equal (Get-Utf8Body $m.Parts[1]) '<p>Gr&uuml;&szlig;e ä</p>' 'html body'
}

Test-Case 'inline image and regular attachment nest as mixed(related(alternative, inline), attachment)' {
    $png = [byte[]](0, 1, 2, 3, 250, 251, 252, 253, 254, 255) * 20
    $pdf = [byte[]](37, 80, 68, 70, 0, 13, 10, 0, 255)
    $item = New-FakeItem @{
        HtmlBody = '<img src="cid:logo1">'
        Attachments = @(
            [pscustomobject]@{ FileName = 'logo.png'; MimeType = 'image/png'; ContentId = 'logo1'; IsInline = $true; Bytes = $png },
            [pscustomobject]@{ FileName = ([string]::Concat('Bericht ', [char]0x00DC, 'bersicht.pdf')); MimeType = 'application/pdf'; ContentId = ''; IsInline = $false; Bytes = $pdf })
    }
    $m = Split-Mime (ConvertTo-MimeMessage -Item $item)
    Assert-True ((Get-Hdr $m 'content-type') -like 'multipart/mixed*') 'mixed root'
    $related = $m.Parts[0]
    Assert-True ((Get-Hdr $related 'content-type') -like 'multipart/related*') 'related'
    Assert-True ((Get-Hdr $related.Parts[0] 'content-type') -like 'multipart/alternative*') 'alternative inside related'
    $img = $related.Parts[1]
    Assert-Equal (Get-Hdr $img 'content-id') '<logo1>' 'content id'
    Assert-True ((Get-Hdr $img 'content-disposition') -like 'inline*') 'inline disposition'
    Assert-Equal (Get-HexSha256 (Get-DecodedBody $img)) (Get-HexSha256 $png) 'inline bytes survive'
    $att = $m.Parts[1]
    Assert-True ((Get-Hdr $att 'content-disposition') -like 'attachment*') 'attachment disposition'
    Assert-True ((Get-Hdr $att 'content-disposition') -like "*filename*=UTF-8''Bericht%20%C3%9Cbersicht.pdf*" -or (Get-Hdr $att 'content-disposition') -like "*filename*=UTF-8''Bericht%20*") 'RFC 2231 filename'
    Assert-Equal (Get-HexSha256 (Get-DecodedBody $att)) (Get-HexSha256 $pdf) 'attachment bytes survive'
}

Test-Case 'html only item with no transport headers gets From, Date, Message-ID and encoded subject' {
    $item = New-FakeItem @{ TransportHeaders = ''; Body = ''; HtmlBody = '<b>x</b>'; Subject = ([string]::Concat('Gr', [char]0x00FC, [char]0x00DF, 'e')); EntryId = 'E2' }
    $m = Split-Mime (ConvertTo-MimeMessage -Item $item)
    Assert-True ((Get-Hdr $m 'content-type') -like 'text/html*') 'html root'
    Assert-True ((Get-Hdr $m 'subject') -like '=?UTF-8?B?*?=') 'RFC 2047 subject'
    Assert-True ((Get-Hdr $m 'message-id') -like '<*@worbit-bridge.invalid>') 'synthetic message-id'
    Assert-True ((Get-Hdr $m 'from') -like '*<alice@example.com>') 'from'
    Assert-Equal (Get-Hdr $m 'date') 'Wed, 04 Mar 2026 05:07:07 +0000'.Replace('05:07:07', '05:06:07') 'date from received time'
}

# ---- delivery

$config = [pscustomobject]@{ server = 'https://orbit.example.com/'; workspace_id = 'ws1'; device_id = $doc.device_id; address = 'x@y.bridge.invalid'
    device_name = 'T'; key_name = 'k'; key_provider = 'p'; enrolled_at = 'now' }

Test-Case 'fake Inbox items are delivered as signed, parseable messages' {
    $script:seen = @()
    Set-BridgeHttpTransport { param($r) $script:seen += , $r; @{ Status = 200; Body = '' } }
    $items = @(
        (New-FakeItem @{ EntryId = 'A' }),
        (New-FakeItem @{ EntryId = 'B'; Subject = 'Second'; HtmlBody = '<i>hi</i>' }))
    $adapter = New-FakeAdapter $items
    foreach ($it in $adapter.GetInboxItems([DateTime]::UtcNow.AddDays(-1))) {
        $r = Send-BridgeItem -Config $config -Signer $vectorSigner -Item $it
        Assert-Equal $r.Outcome 'Delivered' 'outcome'
    }
    Assert-Equal $script:seen.Count 2 'two requests'
    foreach ($req in $script:seen) {
        Assert-Equal $req.Method 'POST' 'method'
        Assert-Equal $req.Url ('https://orbit.example.com/api/v1/mail/inbound/bridge/' + $doc.device_id) 'url'
        Assert-Equal $req.ContentType 'message/rfc822' 'content type'
        $s = Get-BridgeSignedString $req.Headers.'X-Worbit-Timestamp' $req.Headers.'X-Worbit-Nonce' $doc.device_id $req.Body
        Assert-True (Test-Signature $verifier $s $req.Headers.'X-Worbit-Signature') 'signature over exact body bytes'
        [void](Split-Mime $req.Body)
    }
    Assert-True ($script:seen[0].Headers.'X-Worbit-Nonce' -ne $script:seen[1].Headers.'X-Worbit-Nonce') 'nonces differ'
}

Test-Case 'status codes map to retry or permanent per the doc' {
    $map = @{ 200 = 'Delivered'; 503 = 'Retry'; 0 = 'Retry'; 401 = 'Permanent'; 404 = 'Permanent'; 413 = 'Permanent' }
    foreach ($code in $map.Keys) {
        $script:code = $code
        Set-BridgeHttpTransport { param($r) @{ Status = $script:code; Body = '' } }
        $r = Send-BridgeItem -Config $config -Signer $vectorSigner -Item (New-FakeItem @{})
        Assert-Equal $r.Outcome $map[$code] "status $code"
    }
}

Test-Case 'message over 2 MiB is permanent and never sent' {
    $script:calls = 0
    Set-BridgeHttpTransport { param($r) $script:calls++; @{ Status = 200; Body = '' } }
    $big = [pscustomobject]@{ FileName = 'big.bin'; MimeType = 'application/octet-stream'; ContentId = ''; IsInline = $false; Bytes = (New-Object byte[] 2000000) }
    $r = Send-BridgeItem -Config $config -Signer $vectorSigner -Item (New-FakeItem @{ Attachments = @($big) })
    Assert-Equal $r.Outcome 'Permanent' 'outcome'
    Assert-Equal $script:calls 0 'no request'
}

Test-Case 'log never contains body text' {
    $env:WORBIT_BRIDGE_HOME = Join-Path ([IO.Path]::GetTempPath()) ('worbit-bridge-log-' + [guid]::NewGuid())
    try {
        Set-BridgeHttpTransport { param($r) @{ Status = 200; Body = '' } }
        [void](Send-BridgeItem -Config $config -Signer $vectorSigner -Item (New-FakeItem @{ Body = 'SECRET-BODY-MARKER' }))
        $log = Get-Content -Raw (Join-Path $env:WORBIT_BRIDGE_HOME 'bridge.log')
        Assert-True ($log -notmatch 'SECRET-BODY-MARKER') 'body in log'
        Assert-True ($log -match 'Delivered') 'event logged'
    } finally { Remove-Item -Recurse -Force $env:WORBIT_BRIDGE_HOME -ErrorAction SilentlyContinue; Remove-Item Env:WORBIT_BRIDGE_HOME }
}

# ---- enrollment

Test-Case 'enroll registers the public key, stores config without secrets, keeps key non-exportable' {
    $env:WORBIT_BRIDGE_HOME = Join-Path ([IO.Path]::GetTempPath()) ('worbit-bridge-enroll-' + [guid]::NewGuid())
    $cfg = $null
    try {
        $script:req = $null
        Set-BridgeHttpTransport { param($r) $script:req = $r; @{ Status = 201; Body = '{"id":"11111111-2222-4333-8444-555555555555","name":"Test PC","address":"u@ws.bridge.invalid","mailbox_id":"m1","created_at":"2026-01-01T00:00:00Z","revoked_at":null}' } }
        $cfg = Invoke-BridgeEnroll -Server 'https://orbit.example.com' -WorkspaceId 'ws-1' -Credential 'TOKEN-VALUE-123' -Name 'Test PC' -Provider 'Microsoft Software Key Storage Provider'
        Assert-Equal $script:req.Url 'https://orbit.example.com/api/v1/workspaces/ws-1/mail/bridge/devices' 'enroll url'
        Assert-Equal $script:req.Method 'POST' 'method'
        Assert-Equal $script:req.Headers.Cookie '__Host-orbit_session=TOKEN-VALUE-123' 'session cookie'
        Assert-Equal $script:req.Headers.Origin 'https://orbit.example.com' 'origin'
        $body = [Text.Encoding]::UTF8.GetString($script:req.Body) | ConvertFrom-Json
        Assert-Equal $body.name 'Test PC' 'name'
        Assert-Equal (@($body.PSObject.Properties).Count) 2 'only name and public_key (server denies unknown fields)'
        Assert-Equal ([Convert]::FromBase64String($body.public_key)).Length 91 'SPKI'
        $saved = Read-BridgeConfig
        Assert-Equal $saved.device_id '11111111-2222-4333-8444-555555555555' 'device id saved'
        Assert-Equal $saved.address 'u@ws.bridge.invalid' 'address saved'
        $raw = Get-Content -Raw (Get-BridgeConfigPath)
        Assert-True ($raw -notmatch 'TOKEN-VALUE-123') 'credential must not be stored'
        # the stored key signs, and matches the registered public key
        $key = Open-BridgeKey $saved.key_name $saved.key_provider
        Assert-Equal (Get-BridgePublicKeySpki $key) $body.public_key 'registered key is the stored key'
        $key.Dispose()
        $threw = $false
        try { Invoke-BridgeEnroll -Server 'https://orbit.example.com' -WorkspaceId 'ws-1' -Credential 'x' -Provider 'Microsoft Software Key Storage Provider' } catch { $threw = $true }
        Assert-True $threw 'second enroll without -Force is refused'
    } finally {
        if ($cfg) { Remove-BridgeKey $cfg.key_name $cfg.key_provider }
        Remove-Item -Recurse -Force $env:WORBIT_BRIDGE_HOME -ErrorAction SilentlyContinue; Remove-Item Env:WORBIT_BRIDGE_HOME
    }
}

Test-Case 'failed enroll leaves no key and no config, with a plain message' {
    $env:WORBIT_BRIDGE_HOME = Join-Path ([IO.Path]::GetTempPath()) ('worbit-bridge-enroll-' + [guid]::NewGuid())
    try {
        Set-BridgeHttpTransport { param($r) @{ Status = 401; Body = '' } }
        $msg = ''
        try { Invoke-BridgeEnroll -Server 'https://orbit.example.com' -WorkspaceId 'ws-1' -Credential 'bad' -Provider 'Microsoft Software Key Storage Provider' } catch { $msg = $_.Exception.Message }
        Assert-True ($msg -like '*did not accept the credential*') "message: $msg"
        Assert-True (-not (Read-BridgeConfig)) 'no config'
    } finally { Remove-Item -Recurse -Force $env:WORBIT_BRIDGE_HOME -ErrorAction SilentlyContinue; Remove-Item Env:WORBIT_BRIDGE_HOME }
}

Test-Case 'plain http to a remote host is refused' {
    $threw = $false
    try { Invoke-BridgeEnroll -Server 'http://orbit.example.com' -WorkspaceId 'w' -Credential 'x' } catch { $threw = $true }
    Assert-True $threw 'http refused'
}

# ---- Outlook errors

Test-Case 'blocked COM access becomes a plain-language message without hex codes' {
    foreach ($hr in @(-2146959355, -2147024891)) {
        try { throw (New-Object Runtime.InteropServices.COMException('Access denied', $hr)) }
        catch { $msg = Get-OutlookErrorMessage $_ }
        Assert-True ($msg -like '*blocked*Outlook*') "message: $msg"
        Assert-True ($msg -notmatch '0x|HRESULT') 'no codes'
    }
    try { throw (New-Object Runtime.InteropServices.COMException('Invalid class string', -2147221164)) } catch { $msg = Get-OutlookErrorMessage $_ }
    Assert-True ($msg -like '*not installed*') 'not installed message'
}

Set-BridgeHttpTransport $null
Write-Host "$script:passed passed, $script:failed failed"
if ($script:failed -gt 0) { exit 1 }
exit 0
