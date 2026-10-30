import { useEffect } from 'react'
import { create } from 'zustand'
import type { PitwallApi } from '@shared/api'
import type { ClaudeUsage, UsageWindow } from '@shared/types'

const useUsageStore = create<{ usage: ClaudeUsage | null }>()(() => ({ usage: null }))
let started = false
let pushed = false // a push is newer than the initial fetch
const api = (): PitwallApi => (globalThis as unknown as { pitwall: PitwallApi }).pitwall

export function __pushUsage(usage: ClaudeUsage | null): void {
  pushed = true
  useUsageStore.setState({ usage })
}
export const __usageStore = useUsageStore

function start(): void {
  if (started) return
  started = true
  api().onUsage(__pushUsage)
  void api().getUsage().then((usage) => {
    if (!pushed) useUsageStore.setState({ usage })
  })
}

/** Claude subscription usage; one IPC subscription for the whole renderer. */
export function useUsage(): ClaudeUsage | null {
  useEffect(start, [])
  return useUsageStore((s) => s.usage)
}

export type UsageLevel = 'ok' | 'warn' | 'high'
export interface UsageRowView { percent: number; pct: string; reset: string; level: UsageLevel }

export const usageLevel = (percent: number): UsageLevel => (percent >= 90 ? 'high' : percent >= 75 ? 'warn' : 'ok')

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n: number): string => String(n).padStart(2, '0')

/** Local time to the nearest minute, 24h: "14:10" today, "Tue 09:00" on another day. */
export function formatResetTime(at: number, now: number): string {
  const d = new Date(Math.round(at / 60_000) * 60_000)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return d.toDateString() === new Date(now).toDateString() ? hm : `${DAYS[d.getDay()]} ${hm}`
}

/** One meter row. A window past its reset time shows as reset; one Claude didn't report shows a dash. */
export function usageRow(w: UsageWindow | undefined, now: number): UsageRowView {
  if (!w) return { percent: 0, pct: '—', reset: '', level: 'ok' }
  if (w.resetsAt <= now) return { percent: 0, pct: '', reset: 'reset', level: 'ok' }
  const percent = Math.min(100, Math.max(0, Math.round(w.usedPercentage)))
  return { percent, pct: `${percent}%`, reset: `resets ${formatResetTime(w.resetsAt, now)}`, level: usageLevel(percent) }
}
