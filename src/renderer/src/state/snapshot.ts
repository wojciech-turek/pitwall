import { useEffect } from 'react'
import { create } from 'zustand'
import type { AppSnapshot } from '@shared/types'
import type { PitwallApi } from '@shared/api'

const useSnapStore = create<{ snap: AppSnapshot | null }>()(() => ({ snap: null }))
let started = false
const api = (): PitwallApi => (globalThis as unknown as { pitwall: PitwallApi }).pitwall
let pushSeq = 0 // bumped on every pushed snapshot

/**
 * Fetch a fresh snapshot and store it, unless a push arrived while the fetch was in
 * flight (that push is newer than the fetch's read, so it must win).
 */
export async function refreshSnapshot(fetch: () => Promise<AppSnapshot> = () => api().getSnapshot()): Promise<void> {
  const seq = pushSeq
  const snap = await fetch()
  if (seq === pushSeq) useSnapStore.setState({ snap })
}

export function __pushSnapshot(snap: AppSnapshot): void {
  pushSeq++
  useSnapStore.setState({ snap })
}
export const __snapStore = useSnapStore

function start(): void {
  if (started) return
  started = true
  api().onSnapshot(__pushSnapshot)
  void api().getSnapshot().then((snap) => {
    if (!useSnapStore.getState().snap) useSnapStore.setState({ snap })
  })
}

/** Shared app snapshot; one IPC subscription for the whole renderer. */
export function useSnapshot(): AppSnapshot | null {
  useEffect(start, [])
  return useSnapStore((s) => s.snap)
}
