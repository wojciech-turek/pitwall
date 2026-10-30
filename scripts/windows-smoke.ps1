<#
.SYNOPSIS
  Pitwall's Windows smoke check: the items of the Windows verification checklist that a script can check, on this
  machine. Numbers in brackets are the checklist's items.

.DESCRIPTION
  It changes nothing: no setting is written, Claude is never started and no token is ever printed. It writes only to a
  temporary folder, which it removes. Every line says PASS, FAIL, WARN, INFO or SKIP. Exit code 1 if anything failed.

  Installed Pitwall (%LOCALAPPDATA%\Programs\pitwall) and its data (%APPDATA%\pitwall), plus the repository's
  Windows-only unit suites when run from a checkout whose dependencies are installed (pnpm install):
      powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows-smoke.ps1

  A build that isn't installed (CI):
      powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows-smoke.ps1 -AppDir release\win-unpacked -SkipUnitTests

  Works in Windows PowerShell 5.1 and PowerShell 7.
#>
[CmdletBinding()]
param(
  [string]$AppDir = (Join-Path $env:LOCALAPPDATA 'Programs\pitwall'),
  [string]$DataDir = (Join-Path $env:APPDATA 'pitwall'),
  [string]$Repo = (Split-Path -Parent $PSScriptRoot),
  [switch]$SkipUnitTests
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Relative paths from here on mean the current folder, for .NET calls too.
$AppDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($AppDir)
$DataDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DataDir)
$Repo = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Repo)
$script:Failures = 0
$script:Warnings = 0

function Report([string]$Status, [string]$Item, [string]$Text) {
  $colors = @{ PASS = 'Green'; FAIL = 'Red'; WARN = 'Yellow'; INFO = 'Gray'; SKIP = 'DarkGray' }
  Write-Host ('{0}  {1,-6} {2}' -f $Status, "[$Item]", $Text) -ForegroundColor $colors[$Status]
  if ($Status -eq 'FAIL') { $script:Failures++ }
  if ($Status -eq 'WARN') { $script:Warnings++ }
}

# One argument as the C runtime reads it back (quotes only where needed).
function Format-Argument([string]$Value) {
  if ($Value -eq '') { return '""' }
  if ($Value -notmatch '[\s"]') { return $Value }
  $s = $Value -replace '(\\*)"', '$1$1\"'
  $s = $s -replace '(\\+)$', '$1$1'
  return '"' + $s + '"'
}

# Runs a program directly (no shell), feeding it UTF-8 input; its exit code, output and time.
function Invoke-Program([string]$File, [string[]]$Arguments, [string]$InputText = '', [hashtable]$Environment = @{},
                        [int]$TimeoutMs = 120000) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $File
  $psi.Arguments = (@($Arguments) | ForEach-Object { Format-Argument $_ }) -join ' '
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding $false
  $psi.StandardErrorEncoding = New-Object System.Text.UTF8Encoding $false
  foreach ($k in $Environment.Keys) {
    if ($null -eq $Environment[$k]) { $psi.EnvironmentVariables.Remove($k) } else { $psi.EnvironmentVariables[$k] = $Environment[$k] }
  }
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $p = [System.Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEndAsync()
  $err = $p.StandardError.ReadToEndAsync()
  try {
    $bytes = (New-Object System.Text.UTF8Encoding $false).GetBytes($InputText)
    $p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $p.StandardInput.Close()
  } catch { }
  if (-not $p.WaitForExit($TimeoutMs)) {
    try { $p.Kill() } catch { }
    throw "$File did not finish within $($TimeoutMs / 1000) s"
  }
  $p.WaitForExit()
  $watch.Stop()
  return [pscustomobject]@{ Code = $p.ExitCode; Out = $out.Result; Err = $err.Result; Ms = [int]$watch.ElapsedMilliseconds }
}

# The machine a Windows program or DLL is built for: x64, arm64, x86 or the raw value.
function Get-PeMachine([string]$Path) {
  $fs = [System.IO.File]::OpenRead($Path)
  try {
    $head = New-Object byte[] 4096
    [void]$fs.Read($head, 0, 4096)
    $pe = [BitConverter]::ToInt32($head, 0x3c)
    $machine = [BitConverter]::ToUInt16($head, $pe + 4)
    switch ($machine) { 0x8664 { return 'x64' } 0xAA64 { return 'arm64' } 0x14C { return 'x86' } default { return ('0x{0:x}' -f $machine) } }
  } finally {
    $fs.Dispose()
  }
}

# The first <name>.com/.exe/.bat/.cmd on PATH, as Pitwall looks programs up.
function Find-OnPath([string]$Name) {
  foreach ($dir in ($env:Path -split ';')) {
    $dir = $dir.Trim().Trim('"')
    if (-not $dir) { continue }
    foreach ($ext in @('.com', '.exe', '.bat', '.cmd')) {
      try {
        $candidate = Join-Path $dir ($Name + $ext)
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
      } catch { }
    }
  }
  return $null
}

$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$hookFlags = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File')
$work = $null
# Windows PowerShell feeds a program's redirected input in the console's input encoding, with a byte order mark when
# that is UTF-8. Claude Code sends plain UTF-8: so does this check (the console's own setting is put back at the end).
$consoleInput = $null
try { $consoleInput = [Console]::InputEncoding; [Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }

try {
  # ---- the machine -------------------------------------------------------------------------------------------
  $os = Get-CimInstance Win32_OperatingSystem
  $build = [int]$os.BuildNumber
  $osArch = $env:PROCESSOR_ARCHITECTURE
  if ($env:PROCESSOR_ARCHITEW6432) { $osArch = $env:PROCESSOR_ARCHITEW6432 }
  Report 'INFO' '-' ("{0} (build {1}), {2}; PowerShell {3}" -f $os.Caption, $build, $osArch, $PSVersionTable.PSVersion)
  if ($build -ge 17763) { Report 'PASS' '-' 'Windows 10 1809 or later (ConPTY)' }
  else { Report 'FAIL' '-' 'Pitwall needs Windows 10 1809 or later (ConPTY)' }

  # ---- the app -------------------------------------------------------------------------------------------------
  $exe = Join-Path $AppDir 'Pitwall.exe'
  $bin = Join-Path $AppDir 'resources\resources\bin'
  if (Test-Path -LiteralPath $exe) {
    $appArch = Get-PeMachine $exe
    Report 'PASS' '6' "Pitwall.exe ($appArch) in $AppDir"
    if ($osArch -eq 'ARM64' -and $appArch -eq 'x64') { Report 'INFO' '14' 'an x64 Pitwall on ARM64 Windows: it runs under emulation' }
    foreach ($f in @('resources\app.asar', 'resources\resources\bin\pitwall-hook.ps1', 'resources\resources\bin\pitwall-statusline.ps1')) {
      if (Test-Path -LiteralPath (Join-Path $AppDir $f)) { Report 'PASS' '6' "$f" } else { Report 'FAIL' '6' "$f is missing" }
    }
    $prebuilds = Join-Path $AppDir "resources\app.asar.unpacked\node_modules\node-pty\prebuilds\win32-$appArch"
    foreach ($f in @('conpty.node', 'conpty_console_list.node')) {
      $p = Join-Path $prebuilds $f
      if (-not (Test-Path -LiteralPath $p)) { Report 'FAIL' '14' "node-pty's $f for $appArch is missing ($prebuilds)" }
      elseif ((Get-PeMachine $p) -ne $appArch) { Report 'FAIL' '14' "node-pty's $f is built for $(Get-PeMachine $p), not $appArch" }
      else { Report 'PASS' '14' "node-pty's $f ($appArch), unpacked from app.asar" }
    }
  } else {
    Report 'SKIP' '6' "no Pitwall.exe in $AppDir (not installed?); the repository's scripts are used below"
    $bin = Join-Path $Repo 'resources\bin'
  }

  # ---- the repository's Windows-only unit suites -----------------------------------------------------------
  if ($SkipUnitTests) {
    Report 'SKIP' '1' 'unit suites (-SkipUnitTests)'
  } elseif (-not (Test-Path -LiteralPath (Join-Path $Repo 'node_modules'))) {
    Report 'SKIP' '1' "unit suites: no checkout with dependencies at $Repo (run pnpm install there)"
  } else {
    $pnpm = Find-OnPath 'pnpm'
    if (-not $pnpm) {
      Report 'SKIP' '1' 'unit suites: pnpm is not on PATH'
    } else {
      Push-Location $Repo
      try {
        & $pnpm exec vitest run tests/main/windows-scripts.test.ts tests/main/windows-only.test.ts
        if ($LASTEXITCODE -eq 0) { Report 'PASS' '1' 'windows-scripts and windows-only unit suites' }
        else { Report 'FAIL' '1' "windows-scripts / windows-only unit suites (exit $LASTEXITCODE; output above)" }
      } finally {
        Pop-Location
      }
    }
  }

  # ---- the hook, as Claude Code runs it (exec form), from a folder like a profile with a space and an accent ----
  $work = Join-Path ([System.IO.Path]::GetTempPath()) ('pitwall smoke w' + [char]0x00EF + 'n ' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $scripts = Join-Path $work 'App Data\bin'
  $session = Join-Path $work 'App Data\sessions\s_smoke'
  New-Item -ItemType Directory -Force -Path $scripts, $session | Out-Null
  Copy-Item -LiteralPath (Join-Path $bin 'pitwall-hook.ps1'), (Join-Path $bin 'pitwall-statusline.ps1') -Destination $scripts
  $hook = (Join-Path $scripts 'pitwall-hook.ps1').Replace('\', '/')
  $events = (Join-Path $session 'events.jsonl').Replace('\', '/')
  $payload = '{"hook_event_name":"PreToolUse","session_id":"smoke","tool_name":"Bash","tool_input":{"command":"ls"}}'
  $times = @()
  $hookOk = $true
  for ($i = 0; $i -lt 3; $i++) {
    $r = Invoke-Program $powershell ($hookFlags + @($hook, $events, 's_smoke')) $payload
    $times += $r.Ms
    if ($r.Code -ne 0 -or $r.Out -ne '') { $hookOk = $false; Report 'FAIL' '2' "hook run $($i + 1): exit $($r.Code), output '$($r.Out.Trim())', errors '$($r.Err.Trim())'" }
  }
  $lines = @()
  if (Test-Path -LiteralPath $events) { $lines = @(Get-Content -LiteralPath $events -Encoding UTF8 | Where-Object { $_ }) }
  $parsed = @($lines | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.c -eq 's_smoke' -and $_.e -eq 'PreToolUse' -and $_.tool -eq 'Bash' })
  if ($hookOk -and $parsed.Count -eq 3) { Report 'PASS' '2' 'hook: 3 runs, 3 event lines, nothing on stdout, exit 0' }
  elseif ($hookOk) { Report 'FAIL' '2' "hook: $($lines.Count) lines written for 3 runs" }
  $warm = [int](($times[1] + $times[2]) / 2)
  Report 'INFO' '2' ("hook time: first {0} ms, then {1} ms (PreToolUse and PostToolUse wait for it)" -f $times[0], $warm)
  if ($warm -gt 1500) { Report 'WARN' '2' 'hooks take over 1.5 s each here (antivirus scanning PowerShell?)' }

  # ---- the status line: in PowerShell, and in Git Bash when there is one ------------------------------------
  $sl = (Join-Path $scripts 'pitwall-statusline.ps1').Replace('\', '/')
  $sd = $session.Replace('\', '/')
  $command = "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '$sl' '$sd'"
  $line = '{"session_id":"smoke","rate_limits":{"five_hour":{"used_percentage":42,"resets_at":1900000000}}}'
  $userLine = '$j = [Console]::In.ReadToEnd() | ConvertFrom-Json; [Console]::Out.Write("5h " + $j.rate_limits.five_hour.used_percentage)'
  $r = Invoke-Program $powershell @('-NoProfile', '-NonInteractive', '-Command', $command) $line @{ PITWALL_USER_STATUSLINE = $userLine; PITWALL_GIT_BASH = $null }
  $saved = Join-Path $session 'statusline.json'
  $savedOk = (Test-Path -LiteralPath $saved) -and ((Get-Content -LiteralPath $saved -Raw -Encoding UTF8 | ConvertFrom-Json).rate_limits.five_hour.used_percentage -eq 42)
  if ($r.Code -eq 0 -and $savedOk -and $r.Out -eq '5h 42') { Report 'PASS' '4' "status line in PowerShell: statusline.json kept, the user's line chained ($($r.Ms) ms)" }
  else { Report 'FAIL' '4' "status line in PowerShell: exit $($r.Code), saved $savedOk, output '$($r.Out)', errors '$($r.Err.Trim())'" }

  $bash = $env:CLAUDE_CODE_GIT_BASH_PATH
  if (-not $bash) {
    $git = Find-OnPath 'git'
    if ($git) {
      foreach ($c in @((Join-Path (Split-Path $git) '..\bin\bash.exe'), (Join-Path (Split-Path $git) 'bash.exe'))) {
        if (Test-Path -LiteralPath $c) { $bash = (Resolve-Path -LiteralPath $c).Path; break }
      }
    }
  }
  if ($bash -and (Test-Path -LiteralPath $bash)) {
    Remove-Item -LiteralPath $saved -Force -ErrorAction SilentlyContinue
    $r = Invoke-Program $bash @('-c', $command) $line @{ PITWALL_USER_STATUSLINE = "read -r j; printf '%s' `"`$j`" | grep -o '`"used_percentage`":[0-9]*'"; PITWALL_GIT_BASH = $bash }
    $savedOk = Test-Path -LiteralPath $saved
    if ($r.Code -eq 0 -and $savedOk -and $r.Out.Trim() -eq '"used_percentage":42') { Report 'PASS' '4' "status line in Git Bash ($bash): kept and chained ($($r.Ms) ms)" }
    else { Report 'FAIL' '4' "status line in Git Bash: exit $($r.Code), saved $savedOk, output '$($r.Out)', errors '$($r.Err.Trim())'" }
  } else {
    Report 'INFO' '4' 'no Git Bash: Claude Code runs hooks and the status line in PowerShell (Git for Windows is recommended)'
  }

  # ---- execution policy ------------------------------------------------------------------------------------
  $policies = Get-ExecutionPolicy -List
  $forced = @($policies | Where-Object { ($_.Scope -eq 'MachinePolicy' -or $_.Scope -eq 'UserPolicy') -and $_.ExecutionPolicy -ne 'Undefined' })
  $summary = ($policies | ForEach-Object { "$($_.Scope)=$($_.ExecutionPolicy)" }) -join ', '
  if ($forced.Count -gt 0 -and -not ($forced | Where-Object { 'Bypass', 'Unrestricted' -contains $_.ExecutionPolicy })) {
    Report 'WARN' '3' "Group Policy sets the execution policy ($summary): -ExecutionPolicy Bypass doesn't apply, so status won't update (Pitwall shows a banner)"
  } else {
    Report 'INFO' '3' "execution policy: $summary"
  }

  # ---- Claude Code, found as Pitwall finds it --------------------------------------------------------------
  $claude = Find-OnPath 'claude'
  if (-not $claude) { Report 'WARN' '5' 'claude is not on PATH (Pitwall needs Claude Code: https://docs.claude.com/en/docs/claude-code)' }
  elseif ($claude -like '*\.local\bin\claude.exe') { Report 'PASS' '5' "claude: the native install ($claude)" }
  elseif ($claude -like '*\WinGet\Links\*') { Report 'PASS' '5' "claude: WinGet ($claude)" }
  elseif ($claude -like '*.cmd') { Report 'PASS' '5' "claude: npm's claude.cmd ($claude)" }
  else { Report 'PASS' '5' "claude: $claude" }

  # ---- the host and tokens in command lines ------------------------------------------------------------------
  $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine)
  $hosts = @($all | Where-Object { $_.CommandLine -and $_.CommandLine -match 'host[\\/]index\.js"? --data ' })
  $apps = @($all | Where-Object { $_.Name -eq 'Pitwall.exe' -and $_.CommandLine -and $_.CommandLine -notmatch 'host[\\/]index\.js' -and $_.CommandLine -notmatch '--type=' })
  if ($hosts.Count -gt 0) {
    foreach ($h in $hosts) { Report 'INFO' '6' "host pid $($h.ProcessId) ($($h.Name)): $($h.CommandLine)" }
    Report 'INFO' '6' "Pitwall windows running: $($apps.Count) (quit Pitwall: the host keeps the agents)"
  } else {
    Report 'INFO' '6' 'no Pitwall host running (it starts with the first session)'
  }
  $leaks = @($all | Where-Object { $_.CommandLine -and $_.CommandLine -cmatch '\b(gh[opsru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})' })
  if ($leaks.Count -eq 0) { Report 'PASS' '6' "no GitHub token in any of $($all.Count) command lines" }
  else { foreach ($l in $leaks) { Report 'FAIL' '6' "a GitHub token is in the command line of pid $($l.ProcessId) ($($l.Name))" } }

  # ---- the data folder: only this user may read it -----------------------------------------------------------
  if (Test-Path -LiteralPath $DataDir) {
    foreach ($p in @($DataDir, (Join-Path $DataDir 'host.key'))) {
      if (-not (Test-Path -LiteralPath $p)) { continue }
      # ReadData is bit 1 of the rights.
      $open = @((Get-Acl -LiteralPath $p).Access | Where-Object {
        ($_.AccessControlType -eq 'Allow') -and
        ($_.IdentityReference.Value -match '^(Everyone|BUILTIN\\Users|NT AUTHORITY\\Authenticated Users)$') -and
        ((([int]$_.FileSystemRights) -band 1) -ne 0)
      })
      if ($open.Count -eq 0) { Report 'PASS' '13' "$p is readable only by this user, administrators and SYSTEM" }
      else { Report 'FAIL' '13' "$p is readable by $(($open | ForEach-Object { $_.IdentityReference.Value }) -join ', ')" }
    }
  } else {
    Report 'SKIP' '13' "no data folder at $DataDir yet"
  }

  # ---- Start menu shortcut: notifications need its AppUserModelID ------------------------------------------
  $lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Pitwall.lnk'
  if (Test-Path -LiteralPath $lnk) {
    $shell = New-Object -ComObject Shell.Application
    $item = $shell.Namespace((Split-Path $lnk)).ParseName((Split-Path $lnk -Leaf))
    $aumid = $item.ExtendedProperty('System.AppUserModel.ID')
    if ($aumid -eq 'com.wojciechturek.pitwall') { Report 'PASS' '10' "Start menu shortcut with AppUserModelID $aumid" }
    else { Report 'FAIL' '10' "the Start menu shortcut's AppUserModelID is '$aumid', not com.wojciechturek.pitwall" }
  } else {
    Report 'SKIP' '10' 'no Start menu shortcut (not installed)'
  }

  # ---- things worth knowing --------------------------------------------------------------------------------
  $long = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -ErrorAction SilentlyContinue).LongPathsEnabled
  Report 'INFO' '8' "long paths: LongPathsEnabled=$long (Pitwall never sets core.longpaths)"
  $gitExe = Find-OnPath 'git'
  if ($gitExe) { Report 'INFO' '9' "$(& $gitExe --version) ($gitExe)" } else { Report 'WARN' '9' 'git is not on PATH' }
  $agent = Get-Service ssh-agent -ErrorAction SilentlyContinue
  if ($agent) { Report 'INFO' '9' "Windows ssh-agent: $($agent.Status) (Git for Windows' own ssh doesn't use it)" }
  $cursor = Find-OnPath 'cursor'
  if ($cursor) { Report 'INFO' '12' "Open in Cursor uses $cursor" } else { Report 'INFO' '12' 'cursor is not on PATH (Open in Cursor needs it)' }
} catch {
  Report 'FAIL' '-' "the smoke check itself failed: $($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))"
} finally {
  if ($work -and (Test-Path -LiteralPath $work)) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
  if ($consoleInput) { try { [Console]::InputEncoding = $consoleInput } catch { } }
}

Write-Host ''
Write-Host ("{0} failed, {1} warnings. The rest of the checklist needs a person: windows-checklist.md." -f $script:Failures, $script:Warnings)
if ($script:Failures -gt 0) { exit 1 }
exit 0
