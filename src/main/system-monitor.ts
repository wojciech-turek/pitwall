import { totalmem } from 'node:os'
import { statfs } from 'node:fs/promises'
import type { ProcStats, SystemStats } from '../shared/types'
import type { SessionBackend } from './backend'
import type { Exec } from './exec'
import { sessionIdFromTmuxName } from './tmux'

export interface PsRow { ppid: number; rssKb: number; cpu: number }

/** Parses `ps -axo pid=,ppid=,rss=,%cpu=`. Lines that don't fit are skipped. */
export function parsePsUsage(text: string): Map<number, PsRow> {
  const rows = new Map<number, PsRow>()
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s*$/.exec(line)
    if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), rssKb: Number(m[3]), cpu: Number(m[4]) })
  }
  return rows
}

/** Each process's children, by parent pid: built once per sample and shared by every session's treeStats. */
export function childrenOf(rows: Map<number, PsRow>): Map<number, number[]> {
  const kids = new Map<number, number[]>()
  for (const [pid, r] of rows) {
    const list = kids.get(r.ppid)
    if (list) list.push(pid)
    else kids.set(r.ppid, [pid])
  }
  return kids
}

/** The roots and everything below them, each pid counted once. Roots missing from `rows` count for nothing. */
export function treeStats(rows: Map<number, PsRow>, roots: number[], kids: Map<number, number[]> = childrenOf(rows)): ProcStats {
  const seen = new Set<number>()
  const stack = roots.filter((p) => rows.has(p))
  const out: ProcStats = { cpu: 0, rssBytes: 0, procs: 0 }
  while (stack.length) {
    const pid = stack.pop()!
    if (seen.has(pid)) continue
    seen.add(pid)
    const r = rows.get(pid)!
    out.cpu += r.cpu
    out.rssBytes += r.rssKb * 1024
    out.procs++
    for (const k of kids.get(pid) ?? []) stack.push(k)
  }
  return out
}

/** `vm.swapusage`: `total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)` -> used bytes; 0 if unreadable. */
export function parseSwapUsed(text: string): number {
  const m = /used\s*=\s*([\d.]+)\s*([KMGT])/i.exec(text)
  if (!m) return 0
  const n = Number(m[1])
  if (!Number.isFinite(n)) return 0
  return n * 2 ** ({ K: 10, M: 20, G: 30, T: 40 }[m[2].toUpperCase()] as number)
}

/** `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. */
export function pressureFrom(level: number): SystemStats['pressure'] {
  return level === 2 ? 'warn' : level === 4 ? 'critical' : 'normal'
}

const sumStats = (a: ProcStats, b: ProcStats): ProcStats => ({ cpu: a.cpu + b.cpu, rssBytes: a.rssBytes + b.rssBytes, procs: a.procs + b.procs })

export interface SystemMonitorDeps {
  exec: Exec
  backend: Pick<SessionBackend, 'listPaneRoots'>
  liveSessionIds: () => string[]
  /** Must exist (statfs). */
  diskPath: string
  /** Pitwall's own processes (Electron's), summed. */
  appMetrics: () => ProcStats
  intervalMs?: number
  timers?: { setInterval: (fn: () => void, ms: number) => unknown; clearInterval: (t: unknown) => void }
  now?: () => number
}

/**
 * Samples what each session, Pitwall and the Mac cost, every few seconds. Per tick: one `ps`, one tmux listing, two
 * `sysctl`, one `statfs`, one `getAppMetrics`, however many sessions there are. Never throws; a failing command gives
 * defaults for what it would have said.
 */
export class SystemMonitor {
  private latest: SystemStats | null = null
  private readonly listeners = new Set<(s: SystemStats) => void>()
  private timer: unknown = null
  private running: Promise<void> | null = null
  private stopped = false

  constructor(private readonly d: SystemMonitorDeps) {}

  start(): void {
    if (this.timer !== null) return
    this.stopped = false
    const t = this.d.timers ?? { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (x) => clearInterval(x as NodeJS.Timeout) }
    this.timer = t.setInterval(() => { void this.sample() }, this.d.intervalMs ?? 5000)
    void this.sample()
  }

  stop(): void {
    this.stopped = true
    if (this.timer === null) return
    const t = this.d.timers ?? { clearInterval: (x: unknown) => clearInterval(x as NodeJS.Timeout) }
    t.clearInterval(this.timer)
    this.timer = null
  }

  current(): SystemStats | null {
    return this.latest
  }

  onChange(cb: (s: SystemStats) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  /** One sample; a tick that arrives while the last is still running is skipped. Never throws. */
  sample(): Promise<void> {
    this.running ??= this.take().catch(() => undefined).finally(() => { this.running = null })
    return this.running
  }

  private async cmd(file: string, args: string[]): Promise<string> {
    try {
      const r = await this.d.exec(file, args, { env: { ...process.env, LC_ALL: 'C' } as Record<string, string>, timeoutMs: 4000 })
      return r.code === 0 ? r.stdout : ''
    } catch {
      return ''
    }
  }

  private async take(): Promise<void> {
    const d = this.d
    const [ps, panes, level, swap, disk] = await Promise.all([
      this.cmd('/bin/ps', ['-axo', 'pid=,ppid=,rss=,%cpu=']),
      (d.backend.listPaneRoots?.() ?? Promise.resolve({ serverPid: null, panes: new Map<string, number[]>() })).catch(() => ({ serverPid: null, panes: new Map<string, number[]>() })),
      this.cmd('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
      this.cmd('sysctl', ['-n', 'vm.swapusage']),
      statfs(d.diskPath).catch(() => null)
    ])
    if (this.stopped) return
    const rows = parsePsUsage(ps)
    const live = new Set(d.liveSessionIds())
    const roots = new Map<string, number[]>()
    if (panes.serverPid !== null) {
      for (const [name, pids] of panes.panes) {
        const s = sessionIdFromTmuxName(name)
        if (!s || !live.has(s.id)) continue
        // Only a pane whose parent is the tmux server: a stale pid that was reused by something else isn't ours.
        const own = pids.filter((p) => rows.get(p)?.ppid === panes.serverPid)
        if (!own.length) continue
        const list = roots.get(s.id)
        if (list) list.push(...own)
        else roots.set(s.id, own)
      }
    }
    const sessions: Record<string, ProcStats> = {}
    const kids = childrenOf(rows)
    for (const [id, pids] of roots) {
      const st = treeStats(rows, pids, kids)
      sessions[id] = sessions[id] ? sumStats(sessions[id], st) : st
    }
    let pitwall: ProcStats = { cpu: 0, rssBytes: 0, procs: 0 }
    try { pitwall = d.appMetrics() } catch { /* keep zeros */ }
    this.latest = {
      at: (d.now ?? Date.now)(),
      pressure: pressureFrom(Number(level.trim())),
      swapUsedBytes: parseSwapUsed(swap),
      memTotalBytes: totalmem(),
      diskFreeBytes: disk ? disk.bavail * disk.bsize : 0,
      diskTotalBytes: disk ? disk.blocks * disk.bsize : 0,
      pitwall,
      sessions
    }
    for (const cb of this.listeners) {
      try { cb(this.latest) } catch { /* a listener's error is its own */ }
    }
  }
}
