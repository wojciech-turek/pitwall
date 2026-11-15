import { useEffect } from 'react'
import { create } from 'zustand'
import type { PitwallApi } from '@shared/api'
import type { ProcStats, SystemStats } from '@shared/types'
import { formatBytes } from './strays'

const KEEP = 3
const GB = 1024 ** 3
const useSystemStore = create<{ history: SystemStats[] }>()(() => ({ history: [] }))
let started = false
let pushed = false // a push is newer than the initial fetch
const api = (): PitwallApi => (globalThis as unknown as { pitwall: PitwallApi }).pitwall

export function __pushSystem(s: SystemStats): void {
  pushed = true
  useSystemStore.setState((st) => ({ history: [...st.history, s].slice(-KEEP) }))
}
export const __systemStore = useSystemStore

function start(): void {
  if (started) return
  started = true
  api().onSystemStats(__pushSystem)
  void api().getSystemStats().then((s) => {
    if (s && !pushed) __pushSystem(s)
  })
}

/** The last few samples, oldest first; empty where nothing is sampled (Windows). One IPC subscription for the renderer. */
export function useSystemHistory(): SystemStats[] {
  useEffect(start, [])
  return useSystemStore((s) => s.history)
}

/** One session's last few samples (sessions missing from a sample are skipped). */
export function useSessionHistory(id: string): ProcStats[] {
  const h = useSystemHistory()
  return h.flatMap((s) => (s.sessions[id] ? [s.sessions[id]] : []))
}

/** `CPU 35% · 1.2 GB · 14 processes` */
export function formatProc(p: ProcStats): string {
  return `CPU ${Math.round(p.cpu)}% · ${formatBytes(p.rssBytes)} · ${p.procs} ${p.procs === 1 ? 'process' : 'processes'}`
}

/** Heavy means the last 3 samples all agree: 2 GiB or more of memory (`2.4 GB`), else 150% cpu or more (`180%`). */
export function heavyLabel(history: ProcStats[]): string | null {
  const last = history.slice(-KEEP)
  if (last.length < KEEP) return null
  if (last.every((p) => p.rssBytes >= 2 * GB)) return formatBytes(last[KEEP - 1].rssBytes)
  if (last.every((p) => p.cpu >= 150)) return `${Math.round(last[KEEP - 1].cpu)}%`
  return null
}

const diskLow = (s: SystemStats): boolean => s.diskTotalBytes > 0 && (s.diskFreeBytes < 0.1 * s.diskTotalBytes || s.diskFreeBytes < 20 * GB)
/** What one sample says on its own. */
function sampleLevel(s: SystemStats): 'warn' | 'critical' | null {
  if (s.pressure === 'critical') return 'critical'
  return s.pressure === 'warn' || diskLow(s) ? 'warn' : null
}

/** The pill turns on after 2 bad samples in a row and off after 2 good ones, so it doesn't flicker. */
export function pillLevel(history: SystemStats[]): 'warn' | 'critical' | null {
  let on = false
  let run = 0
  for (const s of history) {
    const bad = sampleLevel(s) !== null
    run = bad === on ? 0 : run + 1
    if (run >= 2) { on = bad; run = 0 }
  }
  if (!on) return null
  const last = history[history.length - 1]
  return sampleLevel(last) ?? 'warn'
}

/** Memory wins over disk. */
export function pillLabel(s: SystemStats, level: 'warn' | 'critical'): string {
  if (level === 'critical') return 'Memory pressure critical'
  if (s.pressure === 'warn') return 'Memory pressure high'
  return `Disk almost full · ${Math.round(s.diskFreeBytes / GB)} GB free`
}

export function topSessions(s: SystemStats, n: number): { id: string; stats: ProcStats }[] {
  return Object.entries(s.sessions).map(([id, stats]) => ({ id, stats }))
    .sort((a, b) => b.stats.rssBytes - a.stats.rssBytes).slice(0, n)
}
