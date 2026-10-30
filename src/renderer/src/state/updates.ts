import { useEffect } from 'react'
import { create } from 'zustand'
import type { PitwallApi } from '@shared/api'
import type { UpdateState } from '@shared/types'

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

/** What the last update check found; null until main answers. One IPC subscription for the whole renderer. */
export function useUpdates(): UpdateState | null {
  useEffect(start, [])
  return useUpdateStore((s) => s.state)
}
