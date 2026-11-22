/**
 * The PowerShell helper that drives classic desktop Outlook through COM. It is a long-lived process
 * that reads one JSON request per line from stdin and answers with one JSON line on stdout. Both
 * directions are pure ASCII (non-ASCII is \uXXXX-escaped), so the console code page does not matter.
 *
 * Requests:  {"id":1,"op":"ping"}
 *            {"id":2,"op":"list","sinceMs":1790000000000}     -> {items:[{id,receivedMs,size}]}, oldest first
 *            {"id":3,"op":"read","entryId":"..."}              -> the full item with base64 attachments
 * Answers:   {"id":1,"ok":true,"result":{...}}  or  {"id":1,"ok":false,"error":{"code":<hresult>,"message":"..."}}
 */
export const OUTLOOK_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }  # the answers are ASCII anyway
$script:app = $null

function Get-App {
  if ($null -eq $script:app) { $script:app = New-Object -ComObject Outlook.Application }
  return $script:app
}

function Send-Json($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 8
  $ascii = [regex]::Replace($json, '[^\x00-\x7E]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
  [Console]::Out.WriteLine($ascii)
  [Console]::Out.Flush()
}

function Get-Prop($item, [string]$tag) {
  try { return [string]$item.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/' + $tag) } catch { return '' }
}

function Op-List($req) {
  $inbox = (Get-App).GetNamespace('MAPI').GetDefaultFolder(6)
  $since = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$req.sinceMs).LocalDateTime
  # Outlook filters on local time at minute resolution; the caller re-checks exactly.
  $filter = "[ReceivedTime] >= '" + $since.ToString('M/d/yyyy h:mm tt', [Globalization.CultureInfo]::InvariantCulture) + "'"
  $list = $inbox.Items.Restrict($filter)
  $list.Sort('[ReceivedTime]')
  $out = New-Object System.Collections.ArrayList
  $count = [int]$list.Count
  for ($i = 1; $i -le $count; $i++) {
    $mi = $null
    try {
      $mi = $list.Item($i)
      if ([int]$mi.Class -ne 43) { continue }
      $received = ([DateTimeOffset]$mi.ReceivedTime).ToUnixTimeMilliseconds()
      [void]$out.Add([ordered]@{ id = [string]$mi.EntryID; receivedMs = $received; size = [int64]$mi.Size })
    } catch {
      # an item that cannot be read is left for the next sweep
    } finally {
      if ($null -ne $mi) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($mi) }
    }
  }
  return @{ items = @($out) }
}

function Op-Read($req) {
  $mi = (Get-App).GetNamespace('MAPI').GetItemFromID([string]$req.entryId)
  $received = ([DateTimeOffset]$mi.ReceivedTime).ToUnixTimeMilliseconds()
  $atts = New-Object System.Collections.ArrayList
  $all = $mi.Attachments
  $n = [int]$all.Count
  for ($i = 1; $i -le $n; $i++) {
    $a = $all.Item($i)
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('torbit-' + [guid]::NewGuid().ToString('N'))
    try {
      $a.SaveAsFile($tmp)
      [void]$atts.Add([ordered]@{
        name = [string]$a.FileName
        mime = Get-Prop $a '0x370E001F'
        cid = Get-Prop $a '0x3712001F'
        data = [Convert]::ToBase64String([IO.File]::ReadAllBytes($tmp))
      })
    } finally {
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
      [void][Runtime.InteropServices.Marshal]::ReleaseComObject($a)
    }
  }
  return @{
    id = [string]$mi.EntryID
    receivedMs = $received
    size = [int64]$mi.Size
    subject = [string]$mi.Subject
    senderName = [string]$mi.SenderName
    senderEmail = [string]$mi.SenderEmailAddress
    to = [string]$mi.To
    body = [string]$mi.Body
    html = [string]$mi.HTMLBody
    headers = Get-Prop $mi '0x007D001F'
    attachments = @($atts)
  }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $id = 0
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    switch ($req.op) {
      'ping' { [void](Get-App); $result = @{ pong = $true } }
      'list' { $result = Op-List $req }
      'read' { $result = Op-Read $req }
      default { throw ('unknown op ' + $req.op) }
    }
    Send-Json @{ id = $id; ok = $true; result = $result }
  } catch {
    $ex = $_.Exception
    $hr = [int]$ex.HResult
    $inner = $ex
    while ($null -ne $inner.InnerException) { $inner = $inner.InnerException; if ($inner.HResult) { $hr = [int]$inner.HResult } }
    $script:app = $null  # Outlook may have been closed: connect again next time
    Send-Json @{ id = $id; ok = $false; error = @{ code = $hr; message = [string]$ex.Message } }
  }
}
`;
