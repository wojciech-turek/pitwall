import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { windowsPowerShell } from '../platform'

const run = promisify(execFile)

const safePid = (p: number): boolean => Number.isInteger(p) && p > 1 && p !== process.pid

/** pid -> start time text (`lstart`; on Windows the creation FILETIME), which guards against a pid being reused later. */
export type Leftovers = Map<number, string>

/** Returns the raw process list (`ps -axo pid=,ppid=,lstart=`; on Windows WINDOWS_PS_SCRIPT's). Injectable for tests. */
export type PsFn = () => Promise<string>
export type KillFn = (pid: number, sig: NodeJS.Signals) => void
/** Windows: ends each [pid, creation time] that is still that process (see windowsEndScript). Injectable for tests. */
export type EndFn = (targets: Array<[number, string]>) => Promise<void>

export interface Row { pid: number; ppid: number; start: string }

/** Parses `ps -axo pid=,ppid=,lstart=` output. Lines that don't fit are skipped. */
export function parsePs(text: string): Row[] {
  const rows: Row[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s*$/.exec(line)
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), start: m[3].replace(/\s+/g, ' ') })
  }
  return rows
}

/**
 * The roots and everything below them. Never includes `exclude`. With `bornAfterParent` (Windows), a child counts
 * only if it was created after its parent: Windows never re-parents, so a process whose parent died still names that
 * pid, which a newer, unrelated process may have taken since.
 */
export function descendants(rows: Row[], roots: number[], exclude: number[] = [], o: { bornAfterParent?: boolean } = {}): Leftovers {
  roots = roots.filter(safePid)
  const kids = new Map<number, Row[]>()
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r])
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const out: Leftovers = new Map()
  const stack = roots.filter((p) => byPid.has(p))
  while (stack.length) {
    const p = stack.pop()!
    if (out.has(p) || exclude.includes(p)) continue
    const parent = byPid.get(p)!
    out.set(p, parent.start)
    for (const k of kids.get(p) ?? []) {
      if (!o.bornAfterParent || BigInt(k.start) >= BigInt(parent.start)) stack.push(k.pid)
    }
  }
  return out
}

const defaultPs: PsFn = async () => {
  const { stdout } = await run('/bin/ps', ['-axo', 'pid=,ppid=,lstart='], {
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, maxBuffer: 32 * 1024 * 1024, timeout: 5000
  })
  return stdout
}
const defaultKill: KillFn = (pid, sig) => process.kill(pid, sig)

/**
 * Pitwall itself and every process above it. With `bornAfterParent` (Windows) the walk stops at a parent pid that is
 * newer than its child: the real parent is gone and an unrelated process has its pid.
 */
function ancestors(rows: Row[], pid: number, o: { bornAfterParent?: boolean } = {}): number[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const out = [pid]
  for (let child = byPid.get(pid), p = child?.ppid; p && p > 0 && !out.includes(p); child = byPid.get(p), p = child?.ppid) {
    const parent = byPid.get(p)
    if (o.bornAfterParent && child && parent && BigInt(parent.start) > BigInt(child.start)) break
    out.push(p)
  }
  return out
}

// ---- Windows (no ps, no signals) ----------------------------------------------------------

/**
 * Every process with its parent and creation time (FILETIME: 100 ns since 1601, UTC), one `pid ppid created` line
 * each. Processes without a creation time (the System Idle Process) are left out.
 */
export const WINDOWS_PS_SCRIPT =
  "Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToFileTimeUtc() } }"

export function parseWindowsPs(text: string): Row[] {
  const rows: Row[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line)
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), start: m[3] })
  }
  return rows
}

/**
 * Ends each target with `%SystemRoot%\System32\taskkill.exe /F /PID <pid>` (never /T: a tree is walked here, by
 * creation time), and only if it is still the process recorded: it is first opened (so its pid can't be reused while
 * it is checked and ended), then its creation time must match.
 */
export function windowsEndScript(targets: Array<[number, string]>): string {
  const pids = targets.map(([pid]) => String(Math.trunc(pid))).join(',')
  const starts = targets.map(([, start]) => `'${start.replace(/\D/g, '')}'`).join(',')
  return [
    "$taskkill = Join-Path $env:SystemRoot 'System32\\taskkill.exe'",
    `$pids = @(${pids})`,
    `$starts = @(${starts})`,
    'for ($i = 0; $i -lt $pids.Count; $i++) {',
    '  try {',
    '    $p = [System.Diagnostics.Process]::GetProcessById([int]$pids[$i])',
    '    $null = $p.Handle',
    "    $c = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$pids[$i])",
    '    if ($c -and $c.CreationDate -and $c.CreationDate.ToFileTimeUtc().ToString() -eq $starts[$i]) { & $taskkill /F /PID ([int]$pids[$i]) | Out-Null }',
    '    $p.Dispose()',
    '  } catch { }',
    '}'
  ].join('\n')
}

/** Runs a PowerShell script given inline (not a script file, so no execution policy applies). */
function runPowerShell(script: string): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return run(windowsPowerShell(process.env), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 60_000
  }).then((r) => r.stdout)
}

const windowsPs: PsFn = () => runPowerShell(WINDOWS_PS_SCRIPT)
const windowsEnd: EndFn = async (targets) => { if (targets.length) await runPowerShell(windowsEndScript(targets)) }

export interface LeftoverOptions {
  platform?: NodeJS.Platform
  ps?: PsFn
  kill?: KillFn
  end?: EndFn
  graceMs?: number
}

const isWindows = (o: LeftoverOptions): boolean => (o.platform ?? process.platform) === 'win32'

/**
 * Best effort: never throws. Call before the sessions are killed.
 * Only panes whose parent is the session server (tmux, or the Pitwall host) count as roots, so a stale pane pid
 * (remain-on-exit) that was reused by an unrelated process is ignored. On Windows a pane must also be newer than the
 * host, every process below it newer than its parent, and the host is never included.
 */
export async function snapshotLeftovers(
  panePids: number[], serverPid: number | null, o: LeftoverOptions = {}
): Promise<Leftovers> {
  if (!panePids.length || !serverPid) return new Map()
  try {
    const windows = isWindows(o)
    const rows = windows ? parseWindowsPs(await (o.ps ?? windowsPs)()) : parsePs(await (o.ps ?? defaultPs)())
    const byPid = new Map(rows.map((r) => [r.pid, r]))
    const server = byPid.get(serverPid)
    const roots = panePids.filter((p) => {
      const r = byPid.get(p)
      if (r?.ppid !== serverPid) return false
      return !windows || (!!server && BigInt(r.start) >= BigInt(server.start))
    })
    // Pitwall, its parents and its own children are never touched (ppid too, in case ps missed our row).
    const exclude = [...ancestors(rows, process.pid, { bornAfterParent: windows }), process.pid, process.ppid, ...(windows ? [serverPid] : [])]
    return descendants(rows, roots, exclude, { bornAfterParent: windows })
  } catch {
    return new Map()
  }
}

async function stillThere(snap: Leftovers, ps: PsFn, parse: (text: string) => Row[]): Promise<number[]> {
  try {
    const now = new Map(parse(await ps()).map((r) => [r.pid, r.start]))
    return [...snap].filter(([pid, start]) => safePid(pid) && now.get(pid) === start).map(([pid]) => pid)
  } catch {
    return []
  }
}

function signal(pids: number[], sig: NodeJS.Signals, kill: KillFn): void {
  for (const p of pids) {
    if (!safePid(p)) continue
    try { kill(p, sig) } catch { /* already gone */ }
  }
}

/**
 * SIGTERM what is still running from the snapshot, wait up to `graceMs`, then SIGKILL what still matches. Windows:
 * what is still running with the same creation time is ended at once (each checked again as it is ended). Never throws.
 */
export async function stopLeftovers(snap: Leftovers, o: LeftoverOptions = {}): Promise<void> {
  if (snap.size === 0) return
  if (isWindows(o)) {
    const alive = await stillThere(snap, o.ps ?? windowsPs, parseWindowsPs)
    try {
      await (o.end ?? windowsEnd)(alive.map((p) => [p, snap.get(p)!]))
    } catch {
      // best effort
    }
    return
  }
  const ps = o.ps ?? defaultPs
  const kill = o.kill ?? defaultKill
  let alive = await stillThere(snap, ps, parsePs)
  if (!alive.length) return
  signal(alive, 'SIGTERM', kill)
  const end = Date.now() + (o.graceMs ?? 2000)
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, Math.min(100, Math.max(1, end - Date.now()))))
    alive = await stillThere(new Map(alive.map((p) => [p, snap.get(p)!])), ps, parsePs)
    if (!alive.length) return
  }
  alive = await stillThere(new Map(alive.map((p) => [p, snap.get(p)!])), ps, parsePs)
  signal(alive, 'SIGKILL', kill)
}

/**
 * Windows: ends `root` (a process of ours that is still running, such as a teardown command that ran too long) and
 * everything it started, walked by creation time. Never throws.
 */
export async function stopProcessTree(root: number, o: Pick<LeftoverOptions, 'ps' | 'end'> = {}): Promise<void> {
  try {
    const rows = parseWindowsPs(await (o.ps ?? windowsPs)())
    const exclude = [...ancestors(rows, process.pid, { bornAfterParent: true }), process.pid, process.ppid]
    const tree = descendants(rows, [root], exclude, { bornAfterParent: true })
    await (o.end ?? windowsEnd)([...tree])
  } catch {
    // best effort
  }
}
