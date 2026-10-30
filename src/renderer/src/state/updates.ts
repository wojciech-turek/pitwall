import { useEffect } from 'react'
import { create } from 'zustand'
import type { PitwallApi } from '@shared/api'
import type { UpdateState } from '@shared/types'
import type { AppInfo } from './appInfo'

const useUpdateStore = create<{ state: UpdateState | null }>()(() => ({ state: null }))
let started = false
let pushed = false // a push is newer than the initial fetch
const api = (): PitwallApi => (globalThis as unknown as { pitwall: PitwallApi }).pitwall

/** Takes a state from main (a push, or the result of "Check now"). */
export function setUpdateState(state: UpdateState): void {
  pushed = true
  useUpdateStore.setState({ state })
}

function start(): void {
  if (started) return
  started = true
  api().onUpdateState(setUpdateState)
  void api().getUpdateState().then((state) => {
    if (!pushed) useUpdateStore.setState({ state })
  }).catch(() => undefined)
}

/** "Check now": asks GitHub and says what it found, in one short sentence. */
export async function checkForUpdatesNow(info: AppInfo | null): Promise<string> {
  if (info && !info.updateFeed) return info.dev ? 'Update checks are off in dev builds.' : 'Update checks are off.'
  try {
    const before = await api().getUpdateState()
    const after = await api().checkForUpdates()
    setUpdateState(after)
    // A failed check leaves checkedAt as it was.
    if (after.checkedAt === null || after.checkedAt === before.checkedAt) return "Couldn't reach GitHub."
    if (after.newer.length > 0) return `Pitwall ${after.newer[0].version} is available.`
    return "You're up to date."
  } catch {
    return "Couldn't reach GitHub."
  }
}

/** What the last update check found; null until main answers. One IPC subscription for the whole renderer. */
export function useUpdates(): UpdateState | null {
  useEffect(start, [])
  return useUpdateStore((s) => s.state)
}
