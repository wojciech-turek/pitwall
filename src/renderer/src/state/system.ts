import { useEffect } from 'react'
import { create } from 'zustand'
import type { PitwallApi } from '@shared/api'
import type { ProcStats, SystemStats } from '@shared/types'
import { formatBytes } from './strays'

const KEEP = 3
const GB = 1024 ** 3
export interface PillState { level: 'warn' | 'critical' | null; reason: 'memory' | 'disk' | null; /** samples in a row that disagree with the level */ run: number }
const OFF: PillState = { level: null, reason: null, run: 0 }

const useSystemStore = create<{ history: SystemStats[]; pill: PillState }>()(() => ({ history: [], pill: OFF }))
let started = false
let pushed = false // a push is newer than the initial fetch
const api = (): PitwallApi => (globalThis as unknown as { pitwall: PitwallApi }).pitwall

export function __pushSystem(s: SystemStats): void {
  pushed = true
  useSystemStore.setState((st) => ({ history: [...st.history, s].slice(-KEEP), pill: stepPill(st.pill, s) }))
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

/** The latest sample; null where nothing is sampled (Windows). One IPC subscription for the renderer. */
export function useLatestSystem(): SystemStats | null {
  useEffect(start, [])
  return useSystemStore((s) => s.history[s.history.length - 1] ?? null)
}

/** The title-bar pill's state. */
export function usePill(): PillState {
  useEffect(start, [])
  return useSystemStore((s) => s.pill)
}

const sessionHistory = (history: SystemStats[], id: string): ProcStats[] =>
  history.flatMap((s) => (s.sessions[id] ? [s.sessions[id]] : []))

/** The row chip text for a session. A string, so the row redraws only when it changes. */
export function useHeavyLabel(id: string): string | null {
  useEffect(start, [])
  return useSystemStore((s) => heavyLabel(sessionHistory(s.history, id)))
}

/** A session's latest figures, as text, so a hover card redraws only when they change. */
export function useSessionUsageText(id: string): string | null {
  useEffect(start, [])
  return useSystemStore((s) => {
    const p = s.history[s.history.length - 1]?.sessions[id]
    return p ? formatProc(p) : null
  })
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

/** Under 10% free and under 100 GB (10% of a big disk is still a lot), or under 10 GB on any disk. */
const diskLow = (s: SystemStats): boolean =>
  s.diskTotalBytes > 0 && ((s.diskFreeBytes < 0.1 * s.diskTotalBytes && s.diskFreeBytes < 100 * GB) || s.diskFreeBytes < 10 * GB)
/** What one sample says on its own. */
function sampleLevel(s: SystemStats): 'warn' | 'critical' | null {
  if (s.pressure === 'critical') return 'critical'
  return s.pressure === 'warn' || diskLow(s) ? 'warn' : null
}

/** Advance the pill by one sample: on after 2 bad samples in a row, off after 2 normal ones, so it doesn't flicker. */
export function stepPill(state: PillState, s: SystemStats): PillState {
  const level = sampleLevel(s)
  const reason = s.pressure !== 'normal' ? 'memory' : 'disk'
  const on = state.level !== null
  if (level && on) return { level, reason, run: 0 }
  if (!level && !on) return OFF
  if (state.run + 1 < 2) return { ...state, run: state.run + 1 }
  return level ? { level, reason, run: 0 } : OFF
}

/** The pill's text; memory wins over disk. */
export function pillLabel(pill: PillState, s: SystemStats): string {
  if (pill.level === 'critical') return 'Memory pressure critical'
  if (pill.reason === 'memory') return 'Memory pressure high'
  return `Disk almost full · ${Math.round(s.diskFreeBytes / GB)} GB free`
}

export function topSessions(s: SystemStats, n: number): { id: string; stats: ProcStats }[] {
  return Object.entries(s.sessions).map(([id, stats]) => ({ id, stats }))
    .sort((a, b) => b.stats.rssBytes - a.stats.rssBytes).slice(0, n)
}
