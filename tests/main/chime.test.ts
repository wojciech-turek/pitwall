import { expect, test } from 'vitest'
import { CHIME_QUIET_MS, chimer } from '../../src/main/chime'
import type { SoundCue } from '../../src/shared/types'

function setup() {
  let t = 1000
  const played: SoundCue[] = []
  const chime = chimer((c) => played.push(c), () => t)
  return { chime, played, at: (ms: number) => { t = 1000 + ms } }
}

test('the first change plays at once', () => {
  const { chime, played } = setup()
  chime('done')
  expect(played).toEqual(['done'])
})

test('several sessions finishing together make one sound', () => {
  const { chime, played, at } = setup()
  chime('done')
  at(300); chime('done')
  at(CHIME_QUIET_MS - 1); chime('done')
  expect(played).toEqual(['done'])
  at(CHIME_QUIET_MS + 10); chime('done')
  expect(played).toEqual(['done', 'done'])
})

test('one that needs you is never swallowed by a finish just before it', () => {
  const { chime, played, at } = setup()
  chime('done')
  at(200); chime('needs_you')
  at(400); chime('done')
  at(600); chime('needs_you')
  expect(played).toEqual(['done', 'needs_you'])
})

test('a finish right after one that needs you adds nothing', () => {
  const { chime, played, at } = setup()
  chime('needs_you')
  at(100); chime('done')
  expect(played).toEqual(['needs_you'])
})
