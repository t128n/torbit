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
    # Like Outlook: only the Inbox folder, only items received at or after $Since, oldest first. Items without a
    # Folder property are in the Inbox. Tests mutate .Items to model deleted and moved mail.
    $a | Add-Member -MemberType ScriptMethod -Name GetInboxItems -Value {
        param([DateTime]$Since)
        $r = @($this.Items | Where-Object { (-not ($_.PSObject.Properties['Folder']) -or $_.Folder -eq 'Inbox') -and $_.ReceivedTime -ge $Since } | Sort-Object ReceivedTime)
        , $r
    }
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
    foreach ($it in $adapter.GetInboxItems([DateTime]'2026-01-01')) {
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

# ---- run loop, sweep, backfill (fake Outlook, fake transport)

function New-RunHome { $h = Join-Path ([IO.Path]::GetTempPath()) ('worbit-bridge-run-' + [guid]::NewGuid()); $env:WORBIT_BRIDGE_HOME = $h; Write-BridgeConfig $runConfig; return $h }
function Remove-RunHome([string]$h) { Remove-Item -Recurse -Force $h -ErrorAction SilentlyContinue; Remove-Item Env:WORBIT_BRIDGE_HOME -ErrorAction SilentlyContinue }
function Get-RecvTime([string]$Iso) { [DateTime]::SpecifyKind([DateTime]$Iso, 'Utc') }
$runConfig = [pscustomobject]@{ server = 'https://orbit.example.com'; workspace_id = 'ws1'; device_id = $doc.device_id; address = 'x@y.bridge.invalid'
    device_name = 'T'; key_name = 'k'; key_provider = 'p'; enrolled_at = '2026-01-01T00:00:00.0000000Z' }
$noSleep = { param($s) $script:sleeps += , $s }

Test-Case 'run delivers new inbox mail once, across sweeps and restarts' {
    $h = New-RunHome
    try {
        $script:seen = @(); $script:sleeps = @()
        Set-BridgeHttpTransport { param($r) $script:seen += , $r; @{ Status = 200; Body = '' } }
        $adapter = New-FakeAdapter @((New-FakeItem @{ EntryId = 'A'; ReceivedTime = (Get-RecvTime '2026-03-01T10:00:00') }),
            (New-FakeItem @{ EntryId = 'B'; ReceivedTime = (Get-RecvTime '2026-03-01T11:00:00') }))
        $r1 = Invoke-BridgeRunOnce -Config $runConfig -Signer $vectorSigner -Adapter $adapter -Sleep $noSleep
        Assert-Equal $r1.Delivered 2 'first sweep delivers both'
        $r2 = Invoke-BridgeRunOnce -Config $runConfig -Signer $vectorSigner -Adapter $adapter -Sleep $noSleep
        Assert-Equal $r2.Delivered 0 'second sweep delivers nothing'
        Import-Module $modulePath -Force   # restart: all in-memory state is gone
        Set-BridgeHttpTransport { param($r) $script:seen += , $r; @{ Status = 200; Body = '' } }
        $adapter.Items += (New-FakeItem @{ EntryId = 'C'; ReceivedTime = (Get-RecvTime '2026-03-02T09:00:00') })
        $r3 = Invoke-BridgeRunOnce -Config $runConfig -Signer $vectorSigner -Adapter $adapter -Sleep $noSleep
        Assert-Equal $r3.Delivered 1 'only the new item after restart'
        Assert-Equal $script:seen.Count 3 'three requests in total, no duplicates'
    } finally { Remove-RunHome $h }
}

Test-Case 'sweep re-reads by received time but never sends an item twice (cursor overlap)' {
    $h = New-RunHome
    try {
        $script:seen = @()
        Set-BridgeHttpTransport { param($r) $script:seen += , $r; @{ Status = 200; Body = '' } }
        $adapter = New-FakeAdapter @((New-FakeItem @{ EntryId = 'A'; ReceivedTime = (Get-RecvTime '2026-03-01T10:00:00') }))
        [void](Invoke-BridgeRunOnce -Config $runConfig -Signer $vectorSigner -Adapter $adapter -Sleep $noSleep)
        # a late-arriving item with an older received time than A (clock skew) is still picked up
        $adapter.Items += (New-FakeItem @{ EntryId = 'LATE'; ReceivedTime = (Get-RecvTime '2026-03-01T09:58:00') })
        $r = Invoke-BridgeRunOnce -Config $runConfig -Signer $vectorSigner -Adapter $adapter -Sleep $noSleep
        Assert-Equal $r.Delivered 1 'late item delivered'
        Assert-Equal $script:seen.Count 2 'A not repeated'
    } finally { Remove-RunHome $h }
}

Test-Case '503 is retried with growing backoff, then delivered' {
    $h = New-RunHome
    try {
        $script:seen = @(); $script:sleeps = @(); $script:codes = @(503, 503, 200)
        Set-BridgeHttpTransport { param($r) $script:seen += , $r; $c = $script:codes[$script:seen.Count - 1]; @{ Status = $c; Body = '' } }
        $adapter = New-FakeAdapter @((New-FakeItem @{ EntryId = 'A'; ReceivedTime = (Get-RecvTime '2026-03-01T10:00:00') }))
        $r = Invoke-BridgeRunOnce -Config $runConfig -Signer $vectorSigner -Adapter $adapter -Sleep $noSleep
        Assert-Equal $r.Delivered 1 'delivered after retries'
        Assert-Equal $script:seen.Count 3 'three attempts'
        Assert-Equal $script:sleeps.Count 2 'two waits'
        Assert-True ($script:sleeps[1] -gt $script:sleeps[0]) 'backoff grows'
        Assert-Equal (Get-BridgeStatus).Pending 0 'nothing pending'
    } finally { Remove-RunHome $h }
}

Test-Case 'Orbit down: items stay pending, later sweep delivers each once' {
    $h = New-RunHome
    try {
        $script:seen = @(); $script:sleeps = @(); $script:up = $false
        Set-BridgeHttpTransport { param($r) $script:seen += , $r; if ($script:up) { @{ Status = 200; Body = '' } } else { @{ Status = 0; Body = '' } } }
        $adapter = New-FakeAdapter @((New-FakeItem @{ EntryId = 'A'; ReceivedTime = (Get-RecvTime '2026-03-01T10:00:00') }),
            (New-FakeItem @{ EntryId = 'B'; ReceivedTime = (Get-RecvTime '2026-03-01T11:00:00') }))
        $r = Invoke-BridgeRunOnce -Config $runConfig -Signer $vectorSigner -Adapter $adapter -Sleep $noSleep
        Assert-Equal $r.Delivered 0 'nothing delivered'
        Assert-Equal $r.Pending 2 'both pending'
        Assert-True ($script:seen.Count -le 4) 'gives up after a few attempts, does not hammer'
        Assert-Equal (Get-BridgeStatus).Pending 2 'status shows pending'
        $script:up = $true; $script:seen = @()
        $r = Invoke-BridgeRunOnce -Config $runConfig -Signer $vectorSigner -Adapter $adapter -Sleep $noSleep
        Assert-Equal $r.Delivered 2 'delivered when Orbit is back'
        Assert-Equal $script:seen.Count 2 'each once'
        Assert-Equal (Get-BridgeStatus).Pending 0 'pending cleared'
    } finally { Remove-RunHome $h }
}

Test-Case '401 and 413 are recorded and skipped, never retried or resent' {
    $h = New-RunHome
    try {
        $script:seen = @(); $script:sleeps = @()
        Set-BridgeHttpTransport { param($r) $script:seen += , $r
            $n = [Text.Encoding]::ASCII.GetString($r.Body)
            if ($n -match 'Subject: DENIED') { @{ Status = 401; Body = '' } } elseif ($n -match 'Subject: HUGE') { @{ Status = 413; Body = '' } } else { @{ Status = 200; Body = '' } } }
        $adapter = New-FakeAdapter @(
            (New-FakeItem @{ EntryId = 'A'; Subject = 'DENIED'; TransportHeaders = ''; ReceivedTime = (Get-RecvTime '2026-03-01T10:00:00') }),
            (New-FakeItem @{ EntryId = 'B'; Subject = 'HUGE'; TransportHeaders = ''; ReceivedTime = (Get-RecvTime '2026-03-01T11:00:00') }),
            (New-FakeItem @{ EntryId = 'C'; Subject = 'fine'; TransportHeaders = ''; ReceivedTime = (Get-RecvTime '2026-03-01T12:00:00') }))
        $r = Invoke-BridgeRunOnce -Config $runConfig -Signer $vectorSigner -Adapter $adapter -Sleep $noSleep
        Assert-Equal $r.Delivered 1 'C delivered'
        Assert-Equal $r.Skipped 2 'A and B skipped'
        Assert-Equal $script:sleeps.Count 0 'no retry waits'
        Assert-Equal $script:seen.Count 3 'one request each'
        $state = Read-BridgeState
        Assert-Equal $state.items.A.outcome 'skipped' 'A recorded as skipped'
        Assert-Equal $state.items.A.status 401 'A status'
        Assert-Equal $state.items.B.status 413 'B status'
        $r = Invoke-BridgeRunOnce -Config $runConfig -Signer $vectorSigner -Adapter $adapter -Sleep $noSleep
        Assert-Equal $script:seen.Count 3 'nothing resent on the next sweep'
        Assert-Equal (Get-BridgeStatus).Skipped 2 'status counts skipped'
    } finally { Remove-RunHome $h }
}

Test-Case 'a message over 2 MiB is recorded as skipped (413) without a request' {
    $h = New-RunHome
    try {
        $script:seen = @()
        Set-BridgeHttpTransport { param($r) $script:seen += , $r; @{ Status = 200; Body = '' } }
        $big = [pscustomobject]@{ FileName = 'big.bin'; MimeType = 'application/octet-stream'; ContentId = ''; IsInline = $false; Bytes = (New-Object byte[] 2000000) }
        $adapter = New-FakeAdapter @((New-FakeItem @{ EntryId = 'BIG'; Attachments = @($big); ReceivedTime = (Get-RecvTime '2026-03-01T10:00:00') }))
        $r = Invoke-BridgeRunOnce -Config $runConfig -Signer $vectorSigner -Adapter $adapter -Sleep $noSleep
        Assert-Equal $r.Skipped 1 'skipped'
        Assert-Equal $script:seen.Count 0 'no request'
        Assert-Equal (Read-BridgeState).items.BIG.status 413 'recorded 413'
    } finally { Remove-RunHome $h }
}

Test-Case 'backfill honors the start date and skips what was already delivered' {
    $h = New-RunHome
    try {
        $script:seen = @()
        Set-BridgeHttpTransport { param($r) $script:seen += , $r; @{ Status = 200; Body = '' } }
        $adapter = New-FakeAdapter @(
            (New-FakeItem @{ EntryId = 'JAN'; ReceivedTime = (Get-RecvTime '2026-01-15T10:00:00') }),
            (New-FakeItem @{ EntryId = 'MAR'; ReceivedTime = (Get-RecvTime '2026-03-01T10:00:00') }),
            (New-FakeItem @{ EntryId = 'JUN'; ReceivedTime = (Get-RecvTime '2026-06-01T10:00:00') }))
        $r = Invoke-BridgeBackfill -Config $runConfig -Signer $vectorSigner -Adapter $adapter -Since (Get-RecvTime '2026-02-01T00:00:00') -Sleep $noSleep
        Assert-Equal $r.Delivered 2 'MAR and JUN only'
        Assert-Equal $script:seen.Count 2 'two requests'
        $r = Invoke-BridgeBackfill -Config $runConfig -Signer $vectorSigner -Adapter $adapter -Since (Get-RecvTime '2026-01-01T00:00:00') -Sleep $noSleep
        Assert-Equal $r.Delivered 1 'only JAN is new'
        Assert-Equal $script:seen.Count 3 'MAR and JUN not resent'
    } finally { Remove-RunHome $h }
}

Test-Case 'only the Inbox is read: other folders are never delivered' {
    $h = New-RunHome
    try {
        $script:seen = @()
        Set-BridgeHttpTransport { param($r) $script:seen += , $r; @{ Status = 200; Body = '' } }
        $adapter = New-FakeAdapter @(
            (New-FakeItem @{ EntryId = 'IN'; Folder = 'Inbox'; ReceivedTime = (Get-RecvTime '2026-03-01T10:00:00') }),
            (New-FakeItem @{ EntryId = 'SENT'; Folder = 'Sent Items'; ReceivedTime = (Get-RecvTime '2026-03-01T10:00:00') }),
            (New-FakeItem @{ EntryId = 'JUNK'; Folder = 'Junk Email'; ReceivedTime = (Get-RecvTime '2026-03-01T10:00:00') }),
            (New-FakeItem @{ EntryId = 'SUB'; Folder = 'Inbox/Projects'; ReceivedTime = (Get-RecvTime '2026-03-01T10:00:00') }))
        $r = Invoke-BridgeRunOnce -Config $runConfig -Signer $vectorSigner -Adapter $adapter -Sleep $noSleep
        Assert-Equal $r.Delivered 1 'inbox only'
        Assert-Equal $script:seen.Count 1 'one request'
        $r = Invoke-BridgeBackfill -Config $runConfig -Signer $vectorSigner -Adapter $adapter -Since (Get-RecvTime '2026-01-01T00:00:00') -Sleep $noSleep
        Assert-Equal $r.Delivered 0 'backfill is inbox only too'
    } finally { Remove-RunHome $h }
}

Test-Case 'deleted and moved items are not propagated and not resent' {
    $h = New-RunHome
    try {
        $script:seen = @()
        Set-BridgeHttpTransport { param($r) $script:seen += , $r; @{ Status = 200; Body = '' } }
        $a = New-FakeItem @{ EntryId = 'A'; Folder = 'Inbox'; ReceivedTime = (Get-RecvTime '2026-03-01T10:00:00') }
        $b = New-FakeItem @{ EntryId = 'B'; Folder = 'Inbox'; ReceivedTime = (Get-RecvTime '2026-03-01T11:00:00') }
        $adapter = New-FakeAdapter @($a, $b)
        [void](Invoke-BridgeRunOnce -Config $runConfig -Signer $vectorSigner -Adapter $adapter -Sleep $noSleep)
        Assert-Equal $script:seen.Count 2 'both delivered first'
        $adapter.Items = @($b); $b.Folder = 'Deleted Items'      # A deleted, B moved to Deleted Items
        $r = Invoke-BridgeRunOnce -Config $runConfig -Signer $vectorSigner -Adapter $adapter -Sleep $noSleep
        Assert-Equal $r.Delivered 0 'nothing new'
        $b.Folder = 'Inbox'                                       # moved back: still delivered only once
        $r = Invoke-BridgeRunOnce -Config $runConfig -Signer $vectorSigner -Adapter $adapter -Sleep $noSleep
        Assert-Equal $r.Delivered 0 'moved back, still not resent'
        Assert-Equal $script:seen.Count 2 'no further requests of any kind'
        foreach ($req in $script:seen) { Assert-Equal $req.Method 'POST' 'only deliveries, never deletes' }
        Assert-Equal (Read-BridgeState).items.A.outcome 'delivered' 'history kept'
    } finally { Remove-RunHome $h }
}

Test-Case 'run loop sweeps on an interval, survives an Outlook error, logs no bodies' {
    $h = New-RunHome
    try {
        $script:seen = @(); $script:sleeps = @()
        Set-BridgeHttpTransport { param($r) $script:seen += , $r; @{ Status = 200; Body = '' } }
        $adapter = New-FakeAdapter @((New-FakeItem @{ EntryId = 'A'; Body = 'SECRET-LOOP-MARKER'; ReceivedTime = (Get-RecvTime '2026-03-01T10:00:00') }))
        $adapter | Add-Member -MemberType NoteProperty -Name Calls -Value 0
        $adapter | Add-Member -MemberType ScriptMethod -Name GetInboxItems -Force -Value {
            param([DateTime]$Since)
            $this.Calls++
            if ($this.Calls -eq 1) { throw 'Outlook is not running' }
            , @($this.Items)
        }
        Invoke-BridgeRun -Config $runConfig -Signer $vectorSigner -Adapter $adapter -IntervalSeconds 300 -MaxIterations 3 -Sleep $noSleep
        Assert-Equal $adapter.Calls 3 'three sweeps'
        Assert-Equal $script:seen.Count 1 'delivered once'
        Assert-Equal $script:sleeps.Count 2 'waited between sweeps'
        Assert-Equal $script:sleeps[0] 300 'interval'
        $log = Get-Content -Raw (Join-Path $h 'bridge.log')
        Assert-True ($log -notmatch 'SECRET-LOOP-MARKER') 'no body in log'
        Assert-True ($log -match 'Outlook is not running') 'error logged'
    } finally { Remove-RunHome $h }
}

Test-Case 'status reports device, key location and counters' {
    $h = New-RunHome
    try {
        Write-BridgeConfig $runConfig
        Set-BridgeHttpTransport { param($r) @{ Status = 200; Body = '' } }
        $adapter = New-FakeAdapter @((New-FakeItem @{ EntryId = 'A'; ReceivedTime = (Get-RecvTime '2026-03-01T10:00:00') }))
        [void](Invoke-BridgeRunOnce -Config $runConfig -Signer $vectorSigner -Adapter $adapter -Sleep $noSleep)
        $s = Get-BridgeStatus
        Assert-Equal $s.Enrolled $true 'enrolled'
        Assert-Equal $s.DeviceId $doc.device_id 'device'
        Assert-Equal $s.Server 'https://orbit.example.com' 'server'
        Assert-Equal $s.KeyProvider 'p' 'key location'
        Assert-Equal $s.Delivered 1 'delivered'
        Assert-True ($null -ne $s.LastRun) 'last run'
    } finally { Remove-RunHome $h }
    $h = New-RunHome
    try { Remove-Item (Get-BridgeConfigPath); Assert-Equal (Get-BridgeStatus).Enrolled $false 'not enrolled' } finally { Remove-RunHome $h }
}

# ---- revoke

Test-Case 'revoke calls the server, deletes the key, config and state' {
    $h = New-RunHome
    try {
        $prov = 'Microsoft Software Key Storage Provider'
        $keyName = 'Worbit-Bridge-test-' + [guid]::NewGuid().ToString('N')
        [void](New-BridgeKey -Name $keyName -Provider $prov)
        $cfg = $runConfig.PSObject.Copy(); $cfg.key_name = $keyName; $cfg.key_provider = $prov
        Write-BridgeConfig $cfg; Write-BridgeState @{ version = 1; items = @{} }
        $script:req = $null
        Set-BridgeHttpTransport { param($r) $script:req = $r; @{ Status = 204; Body = '' } }
        Invoke-BridgeRevoke -Credential 'TOKEN-REV' -CredentialKind session
        Assert-Equal $script:req.Method 'DELETE' 'method'
        Assert-Equal $script:req.Url ('https://orbit.example.com/api/v1/workspaces/ws1/mail/bridge/devices/' + $doc.device_id) 'url'
        Assert-Equal $script:req.Headers.Cookie '__Host-orbit_session=TOKEN-REV' 'cookie'
        Assert-Equal $script:req.Headers.Origin 'https://orbit.example.com' 'origin'
        Assert-True (-not (Read-BridgeConfig)) 'config removed'
        Assert-True (-not (Read-BridgeState)) 'state removed'
        $gone = $false
        try { $k = Open-BridgeKey $keyName $prov; $k.Dispose() } catch { $gone = $true }
        Assert-True $gone 'key deleted'
        $log = Get-Content -Raw (Join-Path $h 'bridge.log')
        Assert-True ($log -notmatch 'TOKEN-REV') 'credential not logged'
    } finally { Remove-RunHome $h }
}

Test-Case 'failed revoke keeps everything; -LocalOnly removes local data without a request' {
    $h = New-RunHome
    $prov = 'Microsoft Software Key Storage Provider'
    $keyName = 'Worbit-Bridge-test-' + [guid]::NewGuid().ToString('N')
    try {
        [void](New-BridgeKey -Name $keyName -Provider $prov)
        $cfg = $runConfig.PSObject.Copy(); $cfg.key_name = $keyName; $cfg.key_provider = $prov
        Write-BridgeConfig $cfg
        Set-BridgeHttpTransport { param($r) @{ Status = 401; Body = '' } }
        $msg = ''
        try { Invoke-BridgeRevoke -Credential 'bad' -CredentialKind session } catch { $msg = $_.Exception.Message }
        Assert-True ($msg -like '*did not accept the credential*') "message: $msg"
        Assert-True ([bool](Read-BridgeConfig)) 'config kept'
        $k = Open-BridgeKey $keyName $prov; $k.Dispose()
        $script:req = $null
        Set-BridgeHttpTransport { param($r) $script:req = $r; @{ Status = 204; Body = '' } }
        Invoke-BridgeRevoke -LocalOnly
        Assert-True ($null -eq $script:req) 'no request'
        Assert-True (-not (Read-BridgeConfig)) 'config removed'
    } finally { Remove-RunHome $h; Remove-BridgeKey $keyName $prov }
}

# ---- autostart

Test-Case 'autostart registers a logon task for the current user in the interactive session, and removes it' {
    $taskName = 'WorbitBridge-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    try {
        Install-BridgeAutostart -TaskName $taskName -ScriptPath 'C:\Bridge\bridge.ps1'
        $t = Get-ScheduledTask -TaskName $taskName
        Assert-Equal @($t.Triggers).Count 1 'one trigger'
        Assert-True ($t.Triggers[0].CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger') 'logon trigger'
        Assert-Equal $t.Principal.LogonType 'Interactive' 'interactive session'
        Assert-Equal $t.Principal.RunLevel 'Limited' 'not elevated'
        Assert-True ($t.Actions[0].Arguments -like '*bridge.ps1*run*') "arguments: $($t.Actions[0].Arguments)"
        Assert-True ($t.Actions[0].Execute -like '*powershell.exe') 'Windows PowerShell'
        Assert-True ((Get-BridgeAutostart -TaskName $taskName).Installed) 'reported installed'
        Remove-BridgeAutostart -TaskName $taskName
        Assert-True (-not (Get-BridgeAutostart -TaskName $taskName).Installed) 'removed'
    } finally { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue }
}

Set-BridgeHttpTransport $null
Write-Host "$script:passed passed, $script:failed failed"
if ($script:failed -gt 0) { exit 1 }
exit 0
