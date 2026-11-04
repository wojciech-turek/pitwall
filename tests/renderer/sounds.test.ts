import { expect, test } from 'vitest'
import { CUE_NOTES } from '../../src/renderer/src/state/sounds'

test('needs you: two rising notes; finished: one softer, lower note', () => {
  const [a, b] = CUE_NOTES.needs_you.notes
  expect(CUE_NOTES.needs_you.notes).toHaveLength(2)
  expect(b.freq).toBeGreaterThan(a.freq)
  expect(b.at).toBeGreaterThan(a.at)
  expect(CUE_NOTES.done.notes).toHaveLength(1)
  expect(CUE_NOTES.done.notes[0].freq).toBeLessThan(a.freq)
  expect(CUE_NOTES.done.volume).toBeLessThan(CUE_NOTES.needs_you.volume)
})

test('short and quiet: under half a second, well below full volume', () => {
  for (const cue of Object.values(CUE_NOTES)) {
    expect(Math.max(...cue.notes.map((n) => n.at + n.dur))).toBeLessThan(0.5)
    expect(cue.volume).toBeLessThanOrEqual(0.25)
  }
})
