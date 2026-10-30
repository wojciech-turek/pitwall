import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { windowsPowerShell } from '../../src/main/platform'

const run = promisify(execFile)

/**
 * Windows has no tmux, sh or ps, no POSIX file modes and no Unix socket files: tests that need them are skipped
 * there (`describe.skipIf(WINDOWS)`, or vitest.config.ts for whole files), and Windows runs its twins instead.
 */
export const WINDOWS = process.platform === 'win32'

/** A PowerShell script's output (UTF-8; no profile, no progress bars). */
async function powershell(script: string): Promise<string> {
  const full = `$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`
  const { stdout } = await run(windowsPowerShell(process.env), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(full, 'utf16le').toString('base64')], {
    maxBuffer: 32 * 1024 * 1024, windowsHide: true
  })
  return stdout
}

/**
 * Processes whose command line mentions `hint` (Windows filters on it; ps lists everything), with their command
 * lines: from ps, or on Windows from Win32_Process.
 */
export async function commandLines(hint: string): Promise<Array<{ pid: number; cmd: string }>> {
  // WQL: \ and ' are escaped in the string; [ _ % are LIKE's wildcards, taken literally in brackets.
  const like = hint.replace(/[\\']/g, '\\$&').replace(/[[_%]/g, '[$&]')
  const text = WINDOWS
    ? await powershell(
      `Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${like.replace(/"/g, '`"')}%'" | ` +
      "ForEach-Object { '{0} {1}' -f $_.ProcessId, ($_.CommandLine -replace '[\\r\\n]+', ' ') }")
    : (await run('/bin/ps', ['-axww', '-o', 'pid=,command='], { maxBuffer: 32 * 1024 * 1024 })).stdout
  return text.split(/\r?\n/).map((l) => /^\s*(\d+)\s+(.*?)\s*$/.exec(l)).filter((m) => m !== null)
    .map((m) => ({ pid: Number(m[1]), cmd: m[2] }))
}

/**
 * Whether a command line runs `script` with `--data <dataDir>` last (or followed by more `--` options): a host for
 * that data dir. On Windows the argument is quoted when it has a space, and paths compare whatever their case.
 */
export function runsHost(cmd: string, script: string, dataDir: string): boolean {
  const norm = (s: string): string => (WINDOWS ? s.replace(/\//g, '\\').toLowerCase() : s)
  const data = WINDOWS && /[\s"]/.test(dataDir) ? `"${dataDir}"` : dataDir
  const c = norm(cmd)
  const arg = norm(`--data ${data}`)
  return c.includes(norm(script)) && (c.endsWith(arg) || c.includes(`${arg} --`))
}

/** A process's resident memory in KB: ps's rss, or on Windows its working set. */
export async function residentKb(pid: number): Promise<number> {
  if (WINDOWS) return Math.round(Number((await powershell(`(Get-Process -Id ${pid}).WorkingSet64`)).trim()) / 1024)
  return Number((await run('/bin/ps', ['-o', 'rss=', '-p', String(pid)])).stdout.trim())
}

/**
 * Ends every process whose command line mentions `text` (a test's own temp folder name: its host, and the agents and
 * shells in it, all name a path under it), never this one. What a test started must not outlive it.
 */
export async function killMentioning(text: string): Promise<number[]> {
  const norm = (s: string): string => (WINDOWS ? s.toLowerCase() : s)
  const pids = (await commandLines(text).catch(() => []))
    .filter((p) => p.pid !== process.pid && norm(p.cmd).includes(norm(text))).map((p) => p.pid)
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  }
  return pids
}
