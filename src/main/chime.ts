import type { SoundCue } from '@shared/types'

/** Sessions changing within this long of a sound make no other. */
export const CHIME_QUIET_MS = 1500

/**
 * Several sessions changing together make one sound, not a burst of them: the first plays at once and the rest are
 * dropped for a moment. One that needs you still plays when only a finish was heard: it is the one not to miss.
 */
export function chimer(play: (c: SoundCue) => void, now: () => number = Date.now): (c: SoundCue) => void {
  let at = -Infinity
  let last: SoundCue = 'done'
  return (c) => {
    const t = now()
    if (t - at < CHIME_QUIET_MS && (c === 'done' || last === 'needs_you')) return
    at = t
    last = c
    play(c)
  }
}
