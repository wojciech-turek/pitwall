import { describe, expect, test } from 'vitest'
import { isViewing, viewingAfter, type ViewingEvent } from '../../src/main/viewing'

const win = (o: { focused?: boolean; minimized?: boolean; visible?: boolean } = {}) => ({
  isFocused: () => o.focused ?? true,
  isMinimized: () => o.minimized ?? false,
  isVisible: () => o.visible ?? true
})

describe('whether the user is looking at the window', () => {
  test('focused, not minimized and shown: viewing', () => {
    expect(isViewing(win())).toBe(true)
  })

  test('minimized or hidden is not viewing, even while Electron still calls the window focused (Windows)', () => {
    expect(isViewing(win({ minimized: true }))).toBe(false)
    expect(isViewing(win({ visible: false }))).toBe(false)
    expect(isViewing(win({ focused: false }))).toBe(false)
    expect(isViewing(null)).toBe(false)
    expect(isViewing(undefined)).toBe(false)
  })

  test('minimize or hide with no blur: no longer viewing', () => {
    for (const e of ['minimize', 'hide', 'blur'] as ViewingEvent[]) {
      expect(viewingAfter(e, win({ focused: true, minimized: e === 'minimize', visible: e !== 'hide' }))).toBe(false)
      // Even if the window's state still reads as viewed when the event comes.
      expect(viewingAfter(e, win())).toBe(false)
    }
  })

  test('focus: viewing unless the window is minimized or hidden', () => {
    expect(viewingAfter('focus', win())).toBe(true)
    expect(viewingAfter('focus', win({ focused: false }))).toBe(true) // the event says it is
    expect(viewingAfter('focus', win({ minimized: true }))).toBe(false)
    expect(viewingAfter('focus', win({ visible: false }))).toBe(false)
  })

  test('restore or show: viewing only once it is also focused', () => {
    for (const e of ['restore', 'show'] as ViewingEvent[]) {
      expect(viewingAfter(e, win())).toBe(true)
      expect(viewingAfter(e, win({ focused: false }))).toBe(false)
    }
  })
})
