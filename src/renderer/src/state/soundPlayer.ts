import type { SoundCue } from '@shared/types'
import { CUE_NOTES } from './sounds'

let ctx: AudioContext | null = null

export function playCue(cue: SoundCue): void {
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    const { volume, notes } = CUE_NOTES[cue]
    const t0 = ctx.currentTime + 0.01
    for (const n of notes) {
      const start = t0 + n.at
      const end = start + n.dur
      // The note and a quieter octave above it that dies away sooner: a soft bell rather than a beep.
      for (const [mult, gainOf, ring] of [[1, 1, 1], [2, 0.25, 0.6]] as const) {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = n.freq * mult
        gain.gain.setValueAtTime(0, start)
        gain.gain.linearRampToValueAtTime(volume * gainOf, start + 0.008)
        gain.gain.exponentialRampToValueAtTime(0.0001, start + n.dur * ring)
        osc.connect(gain).connect(ctx.destination)
        osc.start(start)
        osc.stop(end + 0.02)
      }
    }
  } catch {
    // No audio output: nothing to play.
  }
}

/** Both sounds, the way they'll be heard: played when sounds are turned on. */
export function previewSounds(): void {
  playCue('needs_you')
  setTimeout(() => playCue('done'), 700)
}
