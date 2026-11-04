import { beforeEach, expect, test, vi } from 'vitest'

const electron = vi.hoisted(() => ({ shown: [] as { title: string; body: string; silent?: boolean }[] }))
vi.mock('electron', () => ({
  app: { setBadgeCount: () => {} },
  nativeImage: { createFromBitmap: () => ({}) },
  Notification: class {
    static isSupported(): boolean { return true }
    constructor(o: { title: string; body: string; silent?: boolean }) { electron.shown.push(o) }
    on(): void {}
    show(): void {}
  }
}))

import { electronNotifier } from '../../src/main/notifier'
import type { SoundCue } from '../../src/shared/types'

const win = { isDestroyed: () => false } as never
let played: SoundCue[]
beforeEach(() => {
  electron.shown.length = 0
  played = []
})
const note = { sessionId: 's', title: 'T', body: 'B' }

test('sounds on: Pitwall plays its own sound and the notification stays silent (never two sounds)', () => {
  const n = electronNotifier(() => {}, false, { platform: 'darwin', window: () => win, play: (c) => played.push(c) })
  n.notify({ ...note, sound: 'needs_you' })
  expect(played).toEqual(['needs_you'])
  expect(electron.shown).toEqual([{ title: 'T', body: 'B', silent: true }])
})

test('sounds off: the notification is as before, with the system\'s sound', () => {
  const n = electronNotifier(() => {}, false, { platform: 'darwin', window: () => win, play: (c) => played.push(c) })
  n.notify(note)
  expect(played).toEqual([])
  expect(electron.shown).toEqual([{ title: 'T', body: 'B' }])
})

test('no window to play it in: the notification keeps the system\'s sound', () => {
  const n = electronNotifier(() => {}, false, { platform: 'darwin', window: () => null, play: (c) => played.push(c) })
  n.notify({ ...note, sound: 'done' })
  expect(played).toEqual([])
  expect(electron.shown).toEqual([{ title: 'T', body: 'B' }])
})

test('the sound plays even with notifications switched off for the app', () => {
  const n = electronNotifier(() => {}, true, { platform: 'darwin', window: () => win, play: (c) => played.push(c) })
  n.notify({ ...note, sound: 'done' })
  expect(played).toEqual(['done'])
  expect(electron.shown).toEqual([])
})

test('silent: sounds are on but this one has none, so it makes no sound at all', () => {
  const n = electronNotifier(() => {}, false, { platform: 'darwin', window: () => win, play: (c) => played.push(c) })
  n.notify({ ...note, silent: true })
  expect(played).toEqual([])
  expect(electron.shown).toEqual([{ title: 'T', body: 'B', silent: true }])
})

test('a burst makes one sound; every notification in it stays silent', () => {
  const n = electronNotifier(() => {}, false, { platform: 'darwin', window: () => win, play: (c) => played.push(c) })
  n.notify({ ...note, sound: 'done' })
  n.notify({ ...note, sessionId: 's2', sound: 'done' })
  expect(played).toEqual(['done'])
  expect(electron.shown.map((s) => s.silent)).toEqual([true, true])
})
