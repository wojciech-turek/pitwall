import { create } from 'zustand'
import type { SubagentRun } from '@shared/types'

const KEY = 'pitwall.subagents.v1'

/** "1 running · 3 done": what a session's subagents are up to, in a few words ('' for none). */
export function subagentSummary(runs: SubagentRun[]): string {
  const running = runs.filter((r) => r.state === 'running').length
  const done = runs.length - running
  return [running ? `${running} running` : '', done ? `${done} done` : ''].filter(Boolean).join(' · ')
}

/** Sessions whose subagent rows are hidden. Open is the default, so only the closed ones are kept. */
function load(): Record<string, true> {
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
    const v: unknown = raw == null ? {} : JSON.parse(raw)
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return {}
    const closed: Record<string, true> = {}
    for (const [id, open] of Object.entries(v)) if (open === false) closed[id] = true
    return closed
  } catch {
    return {}
  }
}

function store(closed: Record<string, true>): void {
  try {
    const out: Record<string, false> = {}
    for (const id of Object.keys(closed)) out[id] = false
    globalThis.localStorage?.setItem(KEY, JSON.stringify(out))
  } catch { /* storage unavailable or full */ }
}

const useClosed = create<{ closed: Record<string, true> }>(() => ({ closed: load() }))

export function isSubagentsOpen(sessionId: string): boolean {
  return !useClosed.getState().closed[sessionId]
}

export function setSubagentsOpen(sessionId: string, open: boolean): void {
  const closed = { ...useClosed.getState().closed }
  if (open) delete closed[sessionId]
  else closed[sessionId] = true
  useClosed.setState({ closed })
  store(closed)
}

/** Whether a session's subagent rows are showing; re-renders when it changes. */
export function useSubagentsOpen(sessionId: string): boolean {
  return useClosed((s) => !s.closed[sessionId])
}
