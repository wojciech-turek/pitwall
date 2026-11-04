import type { SoundCue } from '@shared/types'

/** One bell-like note: its pitch (Hz), when it starts and how long it rings (seconds). */
export interface Note { freq: number; at: number; dur: number }

/**
 * The two sounds, made here rather than shipped as files. Needs you: two quick rising notes, the one not to miss.
 * Finished: one softer, lower note.
 */
export const CUE_NOTES: Record<SoundCue, { volume: number; notes: Note[] }> = {
  needs_you: { volume: 0.2, notes: [{ freq: 880, at: 0, dur: 0.16 }, { freq: 1318.5, at: 0.11, dur: 0.32 }] }, // A5, E6
  done: { volume: 0.13, notes: [{ freq: 659.25, at: 0, dur: 0.4 }] } // E5
}
