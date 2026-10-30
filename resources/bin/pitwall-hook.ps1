# Pitwall hook for Windows: reads a Claude Code hook payload on stdin and appends one compact JSON line to the events
# file, the same line resources/bin/pitwall-hook writes with jq.
# Usage (exec form in hooks.json):
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File pitwall-hook.ps1 <eventsFile> <pitwallSessionId>
# Always exits 0 and never writes to stdout: on Windows a failing PreToolUse/PermissionRequest hook can block the call.
# Written for Windows PowerShell 5.1 (every Windows 10/11 has it); also runs in PowerShell 7.

$ErrorActionPreference = 'Stop'
# No progress bars (they would be drawn on the host's console and cost time).
$ProgressPreference = 'SilentlyContinue'

# A JSON string as jq writes it: quotes, backslashes and control characters escaped, everything else as is.
function Format-JsonString([string]$s) {
  $sb = New-Object System.Text.StringBuilder ($s.Length + 2)
  [void]$sb.Append('"')
  foreach ($ch in $s.ToCharArray()) {
    $n = [int]$ch
    if ($n -eq 34) { [void]$sb.Append('\"') }
    elseif ($n -eq 92) { [void]$sb.Append('\\') }
    elseif ($n -eq 10) { [void]$sb.Append('\n') }
    elseif ($n -eq 13) { [void]$sb.Append('\r') }
    elseif ($n -eq 9) { [void]$sb.Append('\t') }
    elseif ($n -eq 8) { [void]$sb.Append('\b') }
    elseif ($n -eq 12) { [void]$sb.Append('\f') }
    elseif ($n -lt 32 -or $n -eq 127) { [void]$sb.Append(('\u{0:x4}' -f $n)) }
    else { [void]$sb.Append($ch) }
  }
  [void]$sb.Append('"')
  return $sb.ToString()
}

# Any parsed JSON value back to compact JSON (jq's tojson), whichever parser produced it.
function Format-Json($v) {
  if ($null -eq $v) { return 'null' }
  if ($v -is [string]) { return (Format-JsonString $v) }
  if ($v -is [bool]) { if ($v) { return 'true' } else { return 'false' } }
  if ($v -is [char]) { return (Format-JsonString ([string]$v)) }
  if ($v -is [System.Collections.IDictionary]) {
    $parts = foreach ($k in $v.Keys) { (Format-JsonString ([string]$k)) + ':' + (Format-Json $v[$k]) }
    return '{' + ($parts -join ',') + '}'
  }
  if ($v -is [System.Management.Automation.PSCustomObject]) {
    $parts = foreach ($p in $v.PSObject.Properties) { (Format-JsonString $p.Name) + ':' + (Format-Json $p.Value) }
    return '{' + ($parts -join ',') + '}'
  }
  if ($v -is [System.Collections.IEnumerable]) {
    $parts = foreach ($x in $v) { Format-Json $x }
    return '[' + ($parts -join ',') + ']'
  }
  if ($v -is [System.IFormattable]) { return $v.ToString($null, [System.Globalization.CultureInfo]::InvariantCulture) }
  return (Format-JsonString ([string]$v))
}

# The first $n characters (code points, as jq's .[0:n] counts them).
function Get-Prefix([string]$s, [int]$n) {
  $i = 0
  $count = 0
  while ($i -lt $s.Length -and $count -lt $n) {
    if ([char]::IsHighSurrogate($s[$i]) -and $i + 1 -lt $s.Length -and [char]::IsLowSurrogate($s[$i + 1])) { $i += 2 } else { $i += 1 }
    $count++
  }
  return $s.Substring(0, $i)
}

# A field of the payload, or $null.
function Get-Field($o, [string]$name) {
  if ($null -eq $o) { return $null }
  $value = $null
  if ($o -is [System.Collections.IDictionary]) {
    if ($o.Contains($name)) { $value = $o[$name] }
  } else {
    $prop = $o.PSObject.Properties[$name]
    if ($prop) { $value = $prop.Value }
  }
  if ($null -eq $value) { return $null }
  return ,$value
}

# jq's `a // b`: a, unless it is null or false.
function Test-Missing($v) {
  return ($null -eq $v) -or ($v -is [bool] -and -not $v)
}

try {
  $file = [string]$args[0]
  $c = [string]$args[1]
  if (-not $file) { exit 0 }

  # Raw bytes: the console's code page would garble anything that isn't ASCII.
  $stdin = [Console]::OpenStandardInput()
  $buf = New-Object System.IO.MemoryStream
  $stdin.CopyTo($buf)
  $text = [System.Text.Encoding]::UTF8.GetString($buf.ToArray())
  if ($text.Length -gt 0 -and [int]$text[0] -eq 0xFEFF) { $text = $text.Substring(1) }

  # Windows PowerShell's ConvertFrom-Json stops at 2 MB (a Write tool's payload can be bigger): its own parser has no
  # such limit once asked. PowerShell 7 has neither that parser nor that limit.
  $p = $null
  try {
    Add-Type -AssemblyName System.Web.Extensions
    $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $serializer.MaxJsonLength = [int]::MaxValue
    $serializer.RecursionLimit = 10000
    $p = $serializer.DeserializeObject($text)
  } catch {
    $p = ConvertFrom-Json -InputObject $text
  }
  if (-not (($p -is [System.Collections.IDictionary]) -or ($p -is [System.Management.Automation.PSCustomObject]))) { exit 0 }

  $msg = Get-Field $p 'last_assistant_message'
  if (Test-Missing $msg) { $msg = Get-Field $p 'message' }
  if ($msg -is [string]) { $msg = Get-Prefix $msg 300 } else { $msg = $null }

  $err = Get-Field $p 'error'
  if (Test-Missing $err) { $err = $null }
  elseif ($err -is [string]) { $err = Get-Prefix $err 300 }
  else { $err = Get-Prefix (Format-Json $err) 300 }

  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $line = '{"c":' + (Format-JsonString $c) +
    ',"t":' + $now.ToString([System.Globalization.CultureInfo]::InvariantCulture) +
    ',"e":' + (Format-Json (Get-Field $p 'hook_event_name')) +
    ',"sid":' + (Format-Json (Get-Field $p 'session_id')) +
    ',"tool":' + (Format-Json (Get-Field $p 'tool_name')) +
    ',"nt":' + (Format-Json (Get-Field $p 'notification_type')) +
    ',"src":' + (Format-Json (Get-Field $p 'source')) +
    ',"reason":' + (Format-Json (Get-Field $p 'reason')) +
    ',"msg":' + (Format-Json $msg) +
    ',"err":' + (Format-Json $err) + '}'
  $bytes = (New-Object System.Text.UTF8Encoding $false).GetBytes($line + "`n")

  $dir = [System.IO.Path]::GetDirectoryName($file)
  if ($dir) { [void][System.IO.Directory]::CreateDirectory($dir) }

  # Append-only access: Windows then appends each write at the end, atomically, beside other writers (other hooks,
  # the app, the launcher), as >> does elsewhere.
  $fs = $null
  try {
    $fs = [System.IO.FileStream]::new($file, [System.IO.FileMode]::Append, [System.Security.AccessControl.FileSystemRights]::AppendData,
      ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete), 4096, [System.IO.FileOptions]::None)
  } catch {
    $fs = $null
  }
  if ($fs) {
    try { $fs.Write($bytes, 0, $bytes.Length) } finally { $fs.Dispose() }
  } else {
    # PowerShell 7 (.NET has no such constructor there): one writer at a time, retried while another holds the file.
    for ($i = 0; $i -lt 100; $i++) {
      try {
        $fs = [System.IO.FileStream]::new($file, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
        try { $fs.Write($bytes, 0, $bytes.Length) } finally { $fs.Dispose() }
        break
      } catch [System.IO.IOException] {
        Start-Sleep -Milliseconds 20
      }
    }
  }
} catch {
  # Never a verdict on Claude's tool call: whatever went wrong, exit 0.
}
exit 0
