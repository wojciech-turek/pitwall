import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const safePid = (p: number): boolean => Number.isInteger(p) && p > 1 && p !== process.pid

/** pid -> start time text (`lstart`), which guards against a pid being reused later. */
export type Leftovers = Map<number, string>

/** Returns the raw `ps -axo pid=,ppid=,lstart=` text. Injectable for tests. */
export type PsFn = () => Promise<string>
export type KillFn = (pid: number, sig: NodeJS.Signals) => void

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

/** The roots and everything below them. Never includes `exclude`. */
export function descendants(rows: Row[], roots: number[], exclude: number[] = []): Leftovers {
  roots = roots.filter(safePid)
  const kids = new Map<number, Row[]>()
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r])
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const out: Leftovers = new Map()
  const stack = roots.filter((p) => byPid.has(p))
  while (stack.length) {
    const p = stack.pop()!
    if (out.has(p) || exclude.includes(p)) continue
    out.set(p, byPid.get(p)!.start)
    for (const k of kids.get(p) ?? []) stack.push(k.pid)
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

/** Pitwall itself and every process above it. */
function ancestors(rows: Row[], pid: number): number[] {
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]))
  const out = [pid]
  for (let p = parent.get(pid); p && p > 0 && !out.includes(p); p = parent.get(p)) out.push(p)
  return out
}

/**
 * Best effort: never throws. Call before the tmux sessions are killed.
 * Only panes whose parent is the tmux server count as roots, so a stale pane pid (remain-on-exit) that
 * was reused by an unrelated process is ignored.
 */
export async function snapshotLeftovers(
  panePids: number[], serverPid: number | null, o: { ps?: PsFn } = {}
): Promise<Leftovers> {
  if (!panePids.length || !serverPid) return new Map()
  try {
    const rows = parsePs(await (o.ps ?? defaultPs)())
    const byPid = new Map(rows.map((r) => [r.pid, r]))
    const roots = panePids.filter((p) => byPid.get(p)?.ppid === serverPid)
    return descendants(rows, roots, ancestors(rows, process.pid))
  } catch {
    return new Map()
  }
}

async function stillThere(snap: Leftovers, ps: PsFn): Promise<number[]> {
  try {
    const now = new Map(parsePs(await ps()).map((r) => [r.pid, r.start]))
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

/** SIGTERM what is still running from the snapshot, wait up to `graceMs`, then SIGKILL what still matches. Never throws. */
export async function stopLeftovers(
  snap: Leftovers, o: { graceMs?: number; ps?: PsFn; kill?: KillFn } = {}
): Promise<void> {
  const ps = o.ps ?? defaultPs
  const kill = o.kill ?? defaultKill
  let alive = await stillThere(snap, ps)
  if (!alive.length) return
  signal(alive, 'SIGTERM', kill)
  const end = Date.now() + (o.graceMs ?? 2000)
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, Math.min(100, Math.max(1, end - Date.now()))))
    alive = await stillThere(new Map(alive.map((p) => [p, snap.get(p)!])), ps)
    if (!alive.length) return
  }
  alive = await stillThere(new Map(alive.map((p) => [p, snap.get(p)!])), ps)
  signal(alive, 'SIGKILL', kill)
}
