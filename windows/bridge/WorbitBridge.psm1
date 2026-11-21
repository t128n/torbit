#requires -Version 5.1
# Worbit Outlook bridge core. Windows PowerShell 5.1 compatible.
# Extension points for the run/backfill/status/revoke commands:
#   - Outlook adapter contract: New-OutlookAdapter / any object with the same members (see below)
#   - Config and state: Get-BridgeHome, Read/Write-BridgeConfig, Read/Write-BridgeState
#   - Item pipeline: ConvertTo-MimeMessage, Send-BridgeItem, Send-BridgeMessage
#   - Transport seam: Set-BridgeHttpTransport
# Never log keys, credentials, message bodies or MIME bytes.
Set-StrictMode -Version 2.0

$script:SignatureFormat = 'worbit-bridge-v1'
$script:MaxBodyBytes = 2097152
$script:HttpTransport = $null
$script:TpmProvider = 'Microsoft Platform Crypto Provider'
$script:SoftwareProvider = 'Microsoft Software Key Storage Provider'
$script:CRLF = "`r`n"
$script:DroppedHeaders = @('content-type', 'content-transfer-encoding', 'mime-version', 'content-disposition',
    'content-id', 'content-description', 'content-length', 'content-language')

# ---------------------------------------------------------------- config and state

function Get-BridgeHome {
    if ($env:WORBIT_BRIDGE_HOME) { $dir = $env:WORBIT_BRIDGE_HOME }
    else { $dir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Worbit\Bridge' }
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    return $dir
}

function Write-BridgeJsonFile([string]$Path, $Object) {
    $json = $Object | ConvertTo-Json -Depth 6
    $tmp = $Path + '.tmp'
    [IO.File]::WriteAllText($tmp, $json, (New-Object Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
    Move-Item -LiteralPath $tmp -Destination $Path
}

function Read-BridgeJsonFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return (Get-Content -Raw -Encoding UTF8 -LiteralPath $Path | ConvertFrom-Json)
}

# config.json: server, workspace_id, device_id, address, device_name, key_name, key_provider, enrolled_at.
# Holds no secrets: the private key stays in the key store, the enrollment credential is never saved.
function Get-BridgeConfigPath { Join-Path (Get-BridgeHome) 'config.json' }
function Read-BridgeConfig { Read-BridgeJsonFile (Get-BridgeConfigPath) }
function Write-BridgeConfig($Config) { Write-BridgeJsonFile (Get-BridgeConfigPath) $Config }

# state.json: free-form local state for the run loop (delivered ids, cursors). Owned by the run command.
function Get-BridgeStatePath { Join-Path (Get-BridgeHome) 'state.json' }
function Read-BridgeState { Read-BridgeJsonFile (Get-BridgeStatePath) }
function Write-BridgeState($State) { Write-BridgeJsonFile (Get-BridgeStatePath) $State }

# Log lines carry events and ids only. Callers must never pass keys, credentials or bodies.
function Write-BridgeLog([string]$Message) {
    $line = '{0} {1}' -f ([DateTime]::UtcNow.ToString('o')), $Message
    try { Add-Content -LiteralPath (Join-Path (Get-BridgeHome) 'bridge.log') -Value $line -Encoding UTF8 } catch { }
    Write-Verbose $Message
}

# ---------------------------------------------------------------- key (CNG)

# Creates a non-exportable P-256 signing key. Tries the TPM provider first, then the software KSP.
# Returns the provider name that was used.
function New-BridgeKey {
    param([Parameter(Mandatory)][string]$Name, [string]$Provider)
    if ($Provider) { $candidates = @($Provider) } else { $candidates = @($script:TpmProvider, $script:SoftwareProvider) }
    $lastError = $null
    foreach ($p in $candidates) {
        try {
            $params = New-Object Security.Cryptography.CngKeyCreationParameters
            $params.Provider = New-Object Security.Cryptography.CngProvider($p)
            $params.ExportPolicy = [Security.Cryptography.CngExportPolicies]::None
            $params.KeyUsage = [Security.Cryptography.CngKeyUsages]::Signing
            $key = [Security.Cryptography.CngKey]::Create([Security.Cryptography.CngAlgorithm]::ECDsaP256, $Name, $params)
            $key.Dispose()
            return $p
        } catch { $lastError = $_ }
    }
    throw "Could not create the signing key in the Windows key store: $($lastError.Exception.Message)"
}

function Open-BridgeKey([string]$Name, [string]$Provider) {
    return [Security.Cryptography.CngKey]::Open($Name, (New-Object Security.Cryptography.CngProvider($Provider)))
}

function Remove-BridgeKey([string]$Name, [string]$Provider) {
    try { $k = Open-BridgeKey $Name $Provider; $k.Delete() } catch { }
}

# SubjectPublicKeyInfo DER (91 bytes), base64, from a CNG key. Works for non-exportable keys.
function Get-BridgePublicKeySpki([Security.Cryptography.CngKey]$Key) {
    $blob = $Key.Export([Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
    if ($blob.Length -ne 72) { throw 'Unexpected public key blob; expected P-256.' }
    $prefix = [byte[]](0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01, 0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04)
    $spki = New-Object byte[] 91
    [Array]::Copy($prefix, 0, $spki, 0, 27)
    [Array]::Copy($blob, 8, $spki, 27, 64)
    return [Convert]::ToBase64String($spki)
}

# A signer is a scriptblock: 32-byte SHA-256 digest in, 64-byte P1363 r||s out.
function New-BridgeSigner([Security.Cryptography.CngKey]$Key) {
    $ecdsa = New-Object Security.Cryptography.ECDsaCng($Key)
    return { param([byte[]]$Digest) , $ecdsa.SignHash($Digest) }.GetNewClosure()
}

function Get-BridgeSigner($Config) {
    return (New-BridgeSigner (Open-BridgeKey $Config.key_name $Config.key_provider))
}

# ---------------------------------------------------------------- signing

function Get-Sha256([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return , $sha.ComputeHash($Bytes) } finally { $sha.Dispose() }
}

function ConvertTo-Hex([byte[]]$Bytes) {
    return ([BitConverter]::ToString($Bytes)).Replace('-', '').ToLowerInvariant()
}

function New-BridgeNonce {
    $b = New-Object byte[] 16
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($b) } finally { $rng.Dispose() }
    return [Convert]::ToBase64String($b).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Get-UnixNow {
    $epoch = New-Object DateTime(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
    return [int64][Math]::Floor(([DateTime]::UtcNow - $epoch).TotalSeconds)
}

function Get-BridgeSignedString([string]$Timestamp, [string]$Nonce, [string]$DeviceId, [byte[]]$Body) {
    $hash = ConvertTo-Hex (Get-Sha256 $Body)
    return ($script:SignatureFormat + "`n" + $Timestamp + "`n" + $Nonce + "`n" + $DeviceId + "`n" + $hash)
}

# Returns the three X-Worbit-* headers for a body (docs/bridge-signing.md).
function New-BridgeRequestHeaders {
    param([Parameter(Mandatory)][string]$DeviceId, [Parameter(Mandatory)][AllowEmptyCollection()][byte[]]$Body,
        [Parameter(Mandatory)][scriptblock]$Signer, [string]$Timestamp, [string]$Nonce)
    if (-not $Timestamp) { $Timestamp = (Get-UnixNow).ToString([Globalization.CultureInfo]::InvariantCulture) }
    if (-not $Nonce) { $Nonce = New-BridgeNonce }
    $str = Get-BridgeSignedString $Timestamp $Nonce $DeviceId $Body
    $digest = Get-Sha256 ([Text.Encoding]::UTF8.GetBytes($str))
    $sig = & $Signer $digest
    if ($sig.Length -ne 64) { throw 'Signer did not return a 64-byte IEEE-P1363 signature.' }
    return @{
        'X-Worbit-Timestamp' = $Timestamp
        'X-Worbit-Nonce'     = $Nonce
        'X-Worbit-Signature' = [Convert]::ToBase64String($sig)
    }
}

# ---------------------------------------------------------------- MIME rebuild

function ConvertTo-Base64Lines([byte[]]$Bytes) {
    $b64 = [Convert]::ToBase64String($Bytes)
    $lines = New-Object Collections.Generic.List[string]
    for ($i = 0; $i -lt $b64.Length; $i += 76) { $lines.Add($b64.Substring($i, [Math]::Min(76, $b64.Length - $i))) }
    return ($lines -join $script:CRLF)
}

function Test-PlainAscii([string]$s) { return ($s -cmatch '^[\x20-\x7E]*$') }

# RFC 2047 encoded word for header text that is not ASCII.
function Format-HeaderText([string]$Text) {
    if (Test-PlainAscii $Text) { return $Text }
    return '=?UTF-8?B?' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Text)) + '?='
}

# name="ascii", plus RFC 2231 name*=UTF-8''.. when the value is not plain ASCII.
function Format-HeaderParam([string]$Name, [string]$Value) {
    $pct = New-Object Text.StringBuilder
    foreach ($b in [Text.Encoding]::UTF8.GetBytes($Value)) {
        if (($b -ge 0x30 -and $b -le 0x39) -or ($b -ge 0x41 -and $b -le 0x5A) -or ($b -ge 0x61 -and $b -le 0x7A) -or $b -eq 0x2E -or $b -eq 0x2D -or $b -eq 0x5F) { [void]$pct.Append([char]$b) }
        else { [void]$pct.Append('%' + $b.ToString('X2')) }
    }
    $fallback = -join ($Value.ToCharArray() | ForEach-Object { if ([int]$_ -ge 0x20 -and [int]$_ -le 0x7E) { $_ } else { '_' } })
    $fallback = $fallback.Replace('\', '_').Replace('"', "'")
    if (Test-PlainAscii $Value) { return ('{0}="{1}"' -f $Name, $fallback) }
    return ('{0}="{1}"; {0}*=UTF-8''''{2}' -f $Name, $fallback, $pct.ToString())
}

function New-MimeEntity([string[]]$HeaderLines, [string]$Body) {
    return [pscustomobject]@{ Headers = ($HeaderLines -join $script:CRLF); Body = $Body }
}

function New-MimeMultipart([string]$Subtype, [string]$Boundary, $Entities) {
    $parts = foreach ($e in $Entities) { $e.Headers + $script:CRLF + $script:CRLF + $e.Body }
    $body = '--' + $Boundary + $script:CRLF + ($parts -join ($script:CRLF + '--' + $Boundary + $script:CRLF)) + $script:CRLF + '--' + $Boundary + '--'
    return (New-MimeEntity @("Content-Type: multipart/$Subtype; boundary=`"$Boundary`"") $body)
}

function New-MimeTextEntity([string]$Subtype, [string]$Text) {
    if ($null -eq $Text) { $Text = '' }
    return (New-MimeEntity @("Content-Type: text/$Subtype; charset=utf-8", 'Content-Transfer-Encoding: base64') (ConvertTo-Base64Lines ([Text.Encoding]::UTF8.GetBytes($Text))))
}

function New-MimeAttachmentEntity($Att, [bool]$AsInline) {
    $name = [string]$Att.FileName
    if (-not $name) { $name = 'attachment' }
    $type = [string]$Att.MimeType
    if (-not $type -or $type -notmatch '^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$') { $type = 'application/octet-stream' }
    $disp = 'attachment'
    if ($AsInline) { $disp = 'inline' }
    $h = @(
        ('Content-Type: {0}; {1}' -f $type, (Format-HeaderParam 'name' $name)),
        ('Content-Disposition: {0}; {1}' -f $disp, (Format-HeaderParam 'filename' $name)),
        'Content-Transfer-Encoding: base64'
    )
    if ($Att.ContentId) { $h += ('Content-ID: <{0}>' -f ([string]$Att.ContentId).Trim('<', '>')) }
    [byte[]]$bytes = $Att.Bytes
    if ($null -eq $bytes) { $bytes = New-Object byte[] 0 }
    return (New-MimeEntity $h (ConvertTo-Base64Lines $bytes))
}

# Keep original transport header lines (folding included), drop content-structure headers, CRLF-normalise.
function Get-KeptTransportHeaders([string]$Raw) {
    $kept = New-Object Collections.Generic.List[string]
    if (-not $Raw) { return , $kept.ToArray() }
    $skip = $false
    foreach ($line in ($Raw -split "\r\n|\n|\r")) {
        if ($line -eq '') { break }
        if ($line -match '^[ \t]') {
            if (-not $skip -and $kept.Count -gt 0) { $kept.Add((Format-HeaderText $line)) }
            continue
        }
        $idx = $line.IndexOf(':')
        if ($idx -lt 1) { $skip = $true; continue }
        $name = $line.Substring(0, $idx).Trim().ToLowerInvariant()
        if ($script:DroppedHeaders -contains $name) { $skip = $true; continue }
        $skip = $false
        $kept.Add((Format-HeaderText $line))
    }
    return , $kept.ToArray()
}

function Test-HasHeader($Lines, [string]$Name) {
    foreach ($l in $Lines) { if ($l -match ('^(?i)' + [regex]::Escape($Name) + ':')) { return $true } }
    return $false
}

function Format-MimeDate([DateTime]$Utc) {
    return $Utc.ToUniversalTime().ToString('ddd, dd MMM yyyy HH:mm:ss', [Globalization.CultureInfo]::InvariantCulture) + ' +0000'
}

# Item contract (what an Outlook adapter returns): EntryId, Subject, SenderName, SenderEmail, To,
# ReceivedTime (UTC), TransportHeaders, Body (text), HtmlBody, Attachments[] { FileName, MimeType,
# ContentId, IsInline, Bytes }. Same item in, same bytes out. Output is pure 7-bit ASCII with CRLF.
function ConvertTo-MimeMessage {
    param([Parameter(Mandatory)]$Item)
    $lines = New-Object Collections.Generic.List[string]
    foreach ($l in (Get-KeptTransportHeaders ([string]$Item.TransportHeaders))) { $lines.Add($l) }
    $seed = [string]$Item.EntryId
    if (-not $seed) { $seed = [string]$Item.Subject + '|' + [string]$Item.ReceivedTime }
    $seedHash = ConvertTo-Hex (Get-Sha256 ([Text.Encoding]::UTF8.GetBytes($seed)))
    $received = [DateTime]::UtcNow
    if ($Item.ReceivedTime) { $received = ([DateTime]$Item.ReceivedTime).ToUniversalTime() }
    if (-not (Test-HasHeader $lines 'Date')) { $lines.Add('Date: ' + (Format-MimeDate $received)) }
    if (-not (Test-HasHeader $lines 'Message-ID')) { $lines.Add('Message-ID: <' + $seedHash.Substring(0, 32) + '@worbit-bridge.invalid>') }
    if (-not (Test-HasHeader $lines 'Subject')) { $lines.Add('Subject: ' + (Format-HeaderText ([string]$Item.Subject))) }
    if (-not (Test-HasHeader $lines 'From')) {
        $addr = [string]$Item.SenderEmail
        if (-not $addr) { $addr = 'unknown@worbit-bridge.invalid' }
        $from = $addr
        if ($Item.SenderName) { $from = (Format-HeaderText ('"' + ([string]$Item.SenderName).Replace('\', '').Replace('"', '') + '"')) + ' <' + $addr + '>' }
        $lines.Add('From: ' + $from)
    }
    if (-not (Test-HasHeader $lines 'To') -and $Item.To) { $lines.Add('To: ' + (Format-HeaderText ([string]$Item.To))) }
    $lines.Add('MIME-Version: 1.0')

    $text = [string]$Item.Body
    $html = [string]$Item.HtmlBody
    $atts = @($Item.Attachments | Where-Object { $_ })
    $hasHtml = [bool]$html
    $hasText = [bool]$text

    if ($hasHtml -and $hasText) {
        $root = New-MimeMultipart 'alternative' ('=_worbit_a_' + $seedHash.Substring(0, 24)) @((New-MimeTextEntity 'plain' $text), (New-MimeTextEntity 'html' $html))
    } elseif ($hasHtml) { $root = New-MimeTextEntity 'html' $html }
    else { $root = New-MimeTextEntity 'plain' $text }

    $inline = @($atts | Where-Object { $hasHtml -and $_.IsInline -and $_.ContentId })
    $regular = @($atts | Where-Object { -not ($hasHtml -and $_.IsInline -and $_.ContentId) })
    if ($inline.Count -gt 0) {
        $ents = @($root) + @($inline | ForEach-Object { New-MimeAttachmentEntity $_ $true })
        $root = New-MimeMultipart 'related' ('=_worbit_r_' + $seedHash.Substring(0, 24)) $ents
    }
    if ($regular.Count -gt 0) {
        $ents = @($root) + @($regular | ForEach-Object { New-MimeAttachmentEntity $_ ([bool]$_.IsInline) })
        $root = New-MimeMultipart 'mixed' ('=_worbit_m_' + $seedHash.Substring(0, 24)) $ents
    }
    $msg = ($lines.ToArray() -join $script:CRLF) + $script:CRLF + $root.Headers + $script:CRLF + $script:CRLF + $root.Body + $script:CRLF
    return , ([Text.Encoding]::ASCII.GetBytes($msg))
}

# ---------------------------------------------------------------- HTTP (system proxy)

# Test seam. A transport is a scriptblock taking the request below and returning the response; $null resets.
function Set-BridgeHttpTransport($Transport) { $script:HttpTransport = $Transport }

# Request: @{ Method; Url; Headers; ContentType; Body (byte[]) }. Response: @{ Status; Body (string) }.
function Invoke-BridgeHttp($Request) {
    if ($script:HttpTransport) { return (& $script:HttpTransport $Request) }
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
    $req = [Net.HttpWebRequest]::Create($Request.Url)
    $req.Method = $Request.Method
    $req.Timeout = 60000
    $req.AllowAutoRedirect = $false
    # System proxy (default WebProxy), with the signed-in user's credentials for authenticating proxies.
    $proxy = [Net.WebRequest]::DefaultWebProxy
    if ($proxy) { $proxy.Credentials = [Net.CredentialCache]::DefaultCredentials }
    $req.Proxy = $proxy
    foreach ($k in $Request.Headers.Keys) { $req.Headers[$k] = [string]$Request.Headers[$k] }
    if ($Request.ContentType) { $req.ContentType = $Request.ContentType }
    if ($null -ne $Request.Body) {
        $req.ContentLength = $Request.Body.Length
        $s = $req.GetRequestStream()
        try { $s.Write($Request.Body, 0, $Request.Body.Length) } finally { $s.Dispose() }
    }
    try { $resp = $req.GetResponse() }
    catch [Net.WebException] {
        if ($_.Exception.Response) { $resp = $_.Exception.Response }
        else { return @{ Status = 0; Body = '' } }
    }
    try {
        $reader = New-Object IO.StreamReader($resp.GetResponseStream())
        try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
        return @{ Status = [int]$resp.StatusCode; Body = $text }
    } finally { $resp.Dispose() }
}

function Get-OriginOf([string]$Server) {
    $u = [Uri]$Server
    return ('{0}://{1}' -f $u.Scheme, $u.Authority)
}

function Assert-BridgeServerUrl([string]$Server) {
    $u = $null
    if (-not [Uri]::TryCreate($Server, [UriKind]::Absolute, [ref]$u)) { throw 'Server must be a full URL such as https://worbit.example.com.' }
    if ($u.Scheme -ne 'https' -and -not ($u.Scheme -eq 'http' -and $u.IsLoopback)) { throw 'Server must use https (http only for localhost).' }
}

# ---------------------------------------------------------------- delivery

# Outcome: Delivered | Retry (5xx, network) | Permanent (401/404 may mean re-enroll; 413; other 4xx).
function Send-BridgeMessage {
    param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)][scriptblock]$Signer, [Parameter(Mandatory)][byte[]]$Mime)
    if ($Mime.Length -gt $script:MaxBodyBytes) {
        return [pscustomobject]@{ Outcome = 'Permanent'; Status = 413; Reason = 'Message is larger than 2 MiB.' }
    }
    $headers = New-BridgeRequestHeaders -DeviceId $Config.device_id -Body $Mime -Signer $Signer
    $url = ([string]$Config.server).TrimEnd('/') + '/api/v1/mail/inbound/bridge/' + $Config.device_id
    $res = Invoke-BridgeHttp @{ Method = 'POST'; Url = $url; Headers = $headers; ContentType = 'message/rfc822'; Body = $Mime }
    $status = [int]$res.Status
    if ($status -eq 200) { $outcome = 'Delivered'; $reason = '' }
    elseif ($status -eq 0 -or $status -ge 500 -or $status -eq 429 -or $status -eq 408) { $outcome = 'Retry'; $reason = 'Orbit or the network is not available; try again later.' }
    elseif ($status -eq 401 -or $status -eq 404) { $outcome = 'Permanent'; $reason = 'Orbit rejected this device. It may be revoked; enroll again.' }
    elseif ($status -eq 413) { $outcome = 'Permanent'; $reason = 'Message is too large for Orbit.' }
    else { $outcome = 'Permanent'; $reason = "Orbit answered $status." }
    return [pscustomobject]@{ Outcome = $outcome; Status = $status; Reason = $reason }
}

function Send-BridgeItem {
    param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)][scriptblock]$Signer, [Parameter(Mandatory)]$Item)
    $mime = ConvertTo-MimeMessage -Item $Item
    $r = Send-BridgeMessage -Config $Config -Signer $Signer -Mime $mime
    Write-BridgeLog ('item {0} -> {1} ({2})' -f $Item.EntryId, $r.Outcome, $r.Status)
    return $r
}

# ---------------------------------------------------------------- enrollment

# Credential is an Orbit session token (sent as the session cookie) or an API token (Bearer).
# It is used for this call only and is never stored or logged.
function Invoke-BridgeEnroll {
    param([Parameter(Mandatory)][string]$Server, [Parameter(Mandatory)][string]$WorkspaceId,
        [Parameter(Mandatory)][string]$Credential, [ValidateSet('session', 'api')][string]$CredentialKind = 'session',
        [string]$Name, [string]$Provider, [switch]$Force)
    Assert-BridgeServerUrl $Server
    if (-not $Name) { $Name = $env:COMPUTERNAME }
    if (-not $Name) { $Name = 'Outlook bridge' }
    if ($Name.Length -gt 80) { $Name = $Name.Substring(0, 80) }
    if ((Read-BridgeConfig) -and -not $Force) { throw 'This computer is already enrolled. Use -Force to enroll again.' }
    $keyName = 'Worbit-Bridge-' + [guid]::NewGuid().ToString('N')
    $usedProvider = New-BridgeKey -Name $keyName -Provider $Provider
    try {
        $key = Open-BridgeKey $keyName $usedProvider
        try { $spki = Get-BridgePublicKeySpki $key } finally { $key.Dispose() }
        $json = (@{ name = $Name; public_key = $spki } | ConvertTo-Json -Compress)
        $headers = @{ Origin = (Get-OriginOf $Server); Accept = 'application/json' }
        if ($CredentialKind -eq 'api') { $headers['Authorization'] = 'Bearer ' + $Credential }
        else { $headers['Cookie'] = '__Host-orbit_session=' + $Credential }
        $url = $Server.TrimEnd('/') + '/api/v1/workspaces/' + [uri]::EscapeDataString($WorkspaceId) + '/mail/bridge/devices'
        $res = Invoke-BridgeHttp @{ Method = 'POST'; Url = $url; Headers = $headers; ContentType = 'application/json'; Body = [Text.Encoding]::UTF8.GetBytes($json) }
        $status = [int]$res.Status
        if ($status -ne 201) {
            if ($status -eq 401 -or $status -eq 403) { throw 'Orbit did not accept the credential. Sign in again and use a fresh session token.' }
            if ($status -eq 404) { throw 'Orbit answered 404. Check the workspace id and that the bridge is turned on for this server.' }
            if ($status -eq 0) { throw 'Could not reach Orbit. Check the server URL and your network or proxy.' }
            throw ('Enrollment failed with status {0}.' -f $status)
        }
        $dev = $res.Body | ConvertFrom-Json
        $config = [pscustomobject]@{
            server = $Server.TrimEnd('/'); workspace_id = $WorkspaceId; device_id = [string]$dev.id
            address = [string]$dev.address; device_name = [string]$dev.name
            key_name = $keyName; key_provider = $usedProvider
            enrolled_at = [DateTime]::UtcNow.ToString('o')
        }
        Write-BridgeConfig $config
        Write-BridgeLog ('enrolled device {0} with {1}' -f $config.device_id, $usedProvider)
        return $config
    } catch {
        Remove-BridgeKey $keyName $usedProvider
        throw
    }
}

# ---------------------------------------------------------------- Outlook adapter

function Get-OutlookErrorMessage($ErrorRecord) {
    $ex = $ErrorRecord.Exception
    $hr = $null
    while ($ex) {
        if ($ex -is [Runtime.InteropServices.COMException]) { $hr = $ex.ErrorCode; break }
        $ex = $ex.InnerException
    }
    if ($hr -eq -2147221164) { return 'Outlook (classic desktop version) is not installed. The bridge needs classic Outlook; new Outlook is not supported.' }
    if ($null -ne $hr -and ($hr -eq -2146959355 -or $hr -eq -2147024891 -or $hr -eq -2147467259)) {
        return 'Windows or your administrator blocked the bridge from using Outlook. Ask your IT team to allow this script to use Outlook automation, then start Outlook and try again.'
    }
    return 'The bridge could not talk to Outlook. Make sure classic Outlook is installed and signed in, then try again.'
}

# Adapter contract used by the run command: an object with
#   GetInboxItems([DateTime]$Since) -> items (shape: see ConvertTo-MimeMessage), oldest first.
# This is the real Outlook COM adapter (manual testing only). Tests pass a fake with the same method.
function New-OutlookAdapter {
    $adapter = New-Object psobject
    $adapter | Add-Member -MemberType ScriptMethod -Name GetInboxItems -Value {
        param([DateTime]$Since)
        try {
            $app = New-Object -ComObject Outlook.Application
            $ns = $app.GetNamespace('MAPI')
            $inbox = $ns.GetDefaultFolder(6)
            $filter = "[ReceivedTime] >= '" + $Since.ToLocalTime().ToString('g', [Globalization.CultureInfo]::GetCultureInfo('en-US')) + "'"
            $items = $inbox.Items.Restrict($filter)
            $items.Sort('[ReceivedTime]')
        } catch { throw (Get-OutlookErrorMessage $_) }
        $out = New-Object Collections.Generic.List[object]
        foreach ($mi in $items) {
            if ($mi.Class -ne 43) { continue }
            try {
                $headers = ''
                try { $headers = [string]$mi.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x007D001F') } catch { }
                $atts = New-Object Collections.Generic.List[object]
                foreach ($a in $mi.Attachments) {
                    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('worbit-' + [guid]::NewGuid().ToString('N'))
                    try {
                        $a.SaveAsFile($tmp)
                        $cid = ''
                        $mime = ''
                        try { $cid = [string]$a.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x3712001F') } catch { }
                        try { $mime = [string]$a.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x370E001F') } catch { }
                        $atts.Add([pscustomobject]@{ FileName = [string]$a.FileName; MimeType = $mime; ContentId = $cid
                                IsInline = [bool]$cid; Bytes = [IO.File]::ReadAllBytes($tmp) })
                    } finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
                }
                $out.Add([pscustomobject]@{ EntryId = [string]$mi.EntryID; Subject = [string]$mi.Subject
                        SenderName = [string]$mi.SenderName; SenderEmail = [string]$mi.SenderEmailAddress; To = [string]$mi.To
                        ReceivedTime = ([DateTime]$mi.ReceivedTime).ToUniversalTime(); TransportHeaders = $headers
                        Body = [string]$mi.Body; HtmlBody = [string]$mi.HTMLBody; Attachments = $atts.ToArray() })
            } catch { Write-BridgeLog ('skipped one item: ' + $_.Exception.GetType().Name) }
        }
        return , $out.ToArray()
    }
    return $adapter
}

Export-ModuleMember -Function Get-BridgeHome, Get-BridgeConfigPath, Read-BridgeConfig, Write-BridgeConfig,
Get-BridgeStatePath, Read-BridgeState, Write-BridgeState, Write-BridgeLog,
New-BridgeKey, Open-BridgeKey, Remove-BridgeKey, Get-BridgePublicKeySpki, New-BridgeSigner, Get-BridgeSigner,
New-BridgeNonce, Get-BridgeSignedString, New-BridgeRequestHeaders,
ConvertTo-MimeMessage, Set-BridgeHttpTransport, Send-BridgeMessage, Send-BridgeItem,
Invoke-BridgeEnroll, Get-OutlookErrorMessage, New-OutlookAdapter
