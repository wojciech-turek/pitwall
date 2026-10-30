import { useEffect, useRef, useState } from 'react'
import type { AppSnapshot } from '@shared/types'

/**
 * A counter that bumps when the window regains focus and (debounced 1s) whenever the
 * session's activity changes, so file lists and clean editors can re-read the disk.
 */
export function useDiskRefresh(snap: AppSnapshot, sessionId: string): number {
  const [tick, setTick] = useState(0)
  const s = snap.sessions.find((x) => x.id === sessionId)
  // SessionView carries no lastEventAt; status, last message and diff stat change with agent activity.
  const activity = s ? `${s.status}|${s.lastMessage ?? ''}|${s.diffStat?.additions ?? ''}|${s.diffStat?.deletions ?? ''}` : ''
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    const h = setTimeout(() => setTick((n) => n + 1), 1000)
    return () => clearTimeout(h)
  }, [activity])
  useEffect(() => {
    const onFocus = (): void => setTick((n) => n + 1)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])
  return tick
}
