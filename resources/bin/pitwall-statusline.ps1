# Pitwall status line for Windows: usage pitwall-statusline.ps1 <sessionDir>. Claude Code pipes its status JSON on
# stdin; it is kept in <sessionDir>\statusline.json for the usage meter (replaced atomically). Then the user's own
# status line ($env:PITWALL_USER_STATUSLINE), if any, gets the same JSON and its output is passed through, byte for
# byte. It runs where Claude Code would run it: in Git Bash ($env:PITWALL_GIT_BASH, set when Claude Code finds one),
# else in PowerShell. The same as resources/bin/pitwall-statusline. Always exits 0; never writes to stderr.
# Written for Windows PowerShell 5.1 (every Windows 10/11 has it); also runs in PowerShell 7.

$ErrorActionPreference = 'Stop'
# No progress bars (they would be drawn on the host's console and cost time).
$ProgressPreference = 'SilentlyContinue'

# One argument as the C runtime splits a command line (Git Bash reads its command line the same way).
function ConvertTo-QuotedArg([string]$s) {
  if ($s -and $s -notmatch '[\s"]') { return $s }
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('"')
  $backslashes = 0
  foreach ($ch in $s.ToCharArray()) {
    $n = [int]$ch
    if ($n -eq 92) { $backslashes++; continue }
    if ($n -eq 34) { [void]$sb.Append('\' * ($backslashes * 2 + 1)); [void]$sb.Append('"') }
    else { [void]$sb.Append('\' * $backslashes); [void]$sb.Append($ch) }
    $backslashes = 0
  }
  [void]$sb.Append('\' * ($backslashes * 2))
  [void]$sb.Append('"')
  return $sb.ToString()
}

try {
  $dir = [string]$args[0]
  $utf8 = New-Object System.Text.UTF8Encoding $false

  # Raw bytes: the console's code page would garble anything that isn't ASCII.
  $stdin = [Console]::OpenStandardInput()
  $buf = New-Object System.IO.MemoryStream
  $stdin.CopyTo($buf)
  $text = $utf8.GetString($buf.ToArray())
  if ($text.Length -gt 0 -and [int]$text[0] -eq 0xFEFF) { $text = $text.Substring(1) }
  $text = $text -replace '[\r\n]+$', ''

  if ($dir -and [System.IO.Directory]::Exists($dir)) {
    $target = [System.IO.Path]::Combine($dir, 'statusline.json')
    $tmp = [System.IO.Path]::Combine($dir, ".statusline.$PID.tmp")
    try {
      # A rename over the old file (MoveFileEx, as mv -f): readers see the old file or the new one, never neither, and
      # nothing else is left beside it. Not [IO.File]::Replace: that moves the old file aside first, and when another run
      # replaces it at that moment, the old one is left behind as statusline.json~RF<hex>.TMP.
      Add-Type -AssemblyName Microsoft.VisualBasic
      [System.IO.File]::WriteAllText($tmp, $text + "`n", $utf8)
      # Windows refuses while another process has the file open at that instant (a reader, a scanner, another run):
      # tried again briefly, else this update is dropped (Claude Code sends the next one soon).
      for ($attempt = 0; $attempt -lt 4; $attempt++) {
        if ($attempt -gt 0) { Start-Sleep -Milliseconds (25 * $attempt) }
        try { [Microsoft.VisualBasic.FileIO.FileSystem]::MoveFile($tmp, $target, $true); break } catch { }
      }
    } catch {
      # Best effort, like the usage meter it feeds: the user's own line below still runs.
    } finally {
      # This run's temp file never stays, whatever happened above.
      try { if ([System.IO.File]::Exists($tmp)) { [System.IO.File]::Delete($tmp) } } catch { }
    }
  }

  $command = $env:PITWALL_USER_STATUSLINE
  if ($command) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $bash = $env:PITWALL_GIT_BASH
    if ($bash -and [System.IO.File]::Exists($bash)) {
      $psi.FileName = $bash
      $psi.Arguments = '-c ' + (ConvertTo-QuotedArg $command)
    } else {
      $root = $env:SystemRoot
      if ($root) { $psi.FileName = [System.IO.Path]::Combine($root, 'System32\WindowsPowerShell\v1.0\powershell.exe') } else { $psi.FileName = 'powershell.exe' }
      # Encoded, so the command reaches PowerShell exactly as written, whatever quotes it has.
      $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($command))
      $psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + $encoded
    }
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    # Its errors are read (so it never blocks on a full pipe) and dropped, as the sh version sends them nowhere.
    $errors = $proc.StandardError.ReadToEndAsync()
    $out = [Console]::OpenStandardOutput()
    $copy = $proc.StandardOutput.BaseStream.CopyToAsync($out)
    $in = $utf8.GetBytes($text + "`n")
    try { $proc.StandardInput.BaseStream.Write($in, 0, $in.Length) } catch { }
    try { $proc.StandardInput.Close() } catch { }
    if (-not $proc.WaitForExit(30000)) { try { $proc.Kill() } catch { } }
    try { [void]$copy.Wait(5000) } catch { }
    try { $out.Flush() } catch { }
  }
} catch {
  # The usage meter and the user's line are best effort: whatever went wrong, exit 0.
  # Pitwall's check of the scripts (before Claude starts) asks for the reason in a file of its own; never otherwise.
  if ($env:PITWALL_SCRIPT_ERRORS) { try { [System.IO.File]::AppendAllText($env:PITWALL_SCRIPT_ERRORS, ($_ | Out-String)) } catch { } }
}
exit 0
