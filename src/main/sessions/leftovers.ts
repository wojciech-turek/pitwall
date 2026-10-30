import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** pid -> start time text (`lstart`), which guards against a pid being reused later. */
export type Leftovers = Map<number, string>

interface Row { pid: number; ppid: number; start: string }

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

async function psRows(): Promise<Row[]> {
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,lstart='], { env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 32 * 1024 * 1024 })
  return parsePs(stdout)
}

/** Best effort: never throws. Call before the tmux sessions are killed. */
export async function snapshotLeftovers(rootPids: number[]): Promise<Leftovers> {
  if (!rootPids.length) return new Map()
  try {
    return descendants(await psRows(), rootPids, [process.pid, process.ppid])
  } catch {
    return new Map()
  }
}

async function stillThere(snap: Leftovers): Promise<number[]> {
  try {
    const now = new Map((await psRows()).map((r) => [r.pid, r.start]))
    return [...snap].filter(([pid, start]) => now.get(pid) === start).map(([pid]) => pid)
  } catch {
    return []
  }
}

const signal = (pids: number[], sig: NodeJS.Signals): void => {
  for (const p of pids) {
    try { process.kill(p, sig) } catch { /* already gone */ }
  }
}

/** SIGTERM what is still running from the snapshot, wait up to `graceMs`, then SIGKILL the rest. Never throws. */
export async function stopLeftovers(snap: Leftovers, graceMs = 2000): Promise<void> {
  let alive = await stillThere(snap)
  if (!alive.length) return
  signal(alive, 'SIGTERM')
  const end = Date.now() + graceMs
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 100))
    alive = await stillThere(new Map(alive.map((p) => [p, snap.get(p)!])))
    if (!alive.length) return
  }
  signal(alive, 'SIGKILL')
}
