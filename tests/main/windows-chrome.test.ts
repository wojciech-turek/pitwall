import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, test } from 'vitest'
import type { MenuCommand } from '../../src/shared/api'
import { badgeBitmap, badgeDescription, badgeText } from '../../src/main/badge'
import { appShortcut, buildMenuTemplate, type KeyInput } from '../../src/main/menu'
import { TITLE_BAR, windowChrome } from '../../src/main/window-chrome'

describe('window chrome', () => {
  test('Windows: no title bar of its own, the window buttons drawn over the app\'s in its colours; macOS unchanged', () => {
    expect(windowChrome('win32')).toEqual({ titleBarStyle: 'hidden', titleBarOverlay: { color: '#1c1b1a', symbolColor: '#9c9893', height: 37 } })
    expect(windowChrome('darwin')).toEqual({ titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } })
  })

  test('the overlay\'s colours are the theme\'s, and it stops above the title bar\'s bottom border', () => {
    const css = readFileSync(resolve(__dirname, '../../src/renderer/src/theme.css'), 'utf8')
    expect(css).toContain(`--bg-sidebar:${TITLE_BAR.color};`)
    expect(css).toContain(`--text-muted:${TITLE_BAR.symbolColor};`)
    expect(css).toMatch(new RegExp(`\\.titlebar \\{ height: ${TITLE_BAR.height + 1}px;[^}]*border-bottom: 1px`))
    expect(css).toMatch(/:root\[data-platform="win32"\] \.titlebar \{[^}]*env\(titlebar-area-width/)
  })
})

describe('Ctrl shortcuts on Windows', () => {
  const press = (key: string, o: Partial<KeyInput> = {}): KeyInput =>
    ({ type: 'keyDown', key, control: true, meta: false, alt: false, shift: false, ...o })

  /** Every `CmdOrCtrl+<key>` in the menu, with the command it sends. */
  function menuShortcuts(): Map<string, MenuCommand> {
    const out = new Map<string, MenuCommand>()
    let sent: MenuCommand | null = null
    const walk = (items: MenuItemConstructorOptions[]): void => {
      for (const it of items) {
        if (Array.isArray(it.submenu)) walk(it.submenu)
        const m = /^CmdOrCtrl\+(.)$/.exec(String(it.accelerator ?? ''))
        if (!m || !it.click) continue
        ;(it.click as () => void)()
        out.set(m[1], sent!)
      }
    }
    walk(buildMenuTemplate((c) => { sent = c }, false))
    return out
  }

  test('each of the menu\'s shortcuts, and only those, goes to the app', () => {
    const menu = menuShortcuts()
    expect(menu.size).toBe(16)
    for (const [key, command] of menu) {
      expect(appShortcut(press(key), 'win32')).toEqual(command)
      expect(appShortcut(press(key.toUpperCase()), 'win32')).toEqual(command)
    }
    for (const key of ['c', 'v', 'a', 'd', 'r', 'u', 'l', 'Enter', 'Tab', '0']) expect(appShortcut(press(key), 'win32')).toBeNull()
  })

  test('only Ctrl alone, on key down, on Windows', () => {
    expect(appShortcut(press('k', { shift: true }), 'win32')).toBeNull()
    expect(appShortcut(press('k', { alt: true }), 'win32')).toBeNull()
    expect(appShortcut(press('k', { meta: true }), 'win32')).toBeNull()
    expect(appShortcut(press('k', { control: false }), 'win32')).toBeNull()
    expect(appShortcut(press('k', { type: 'keyUp' }), 'win32')).toBeNull()
    expect(appShortcut(press('k'), 'darwin')).toBeNull() // the menu handles ⌘ there
    expect(appShortcut(press('k', { control: false, meta: true }), 'darwin')).toBeNull()
  })
})

describe('the taskbar badge', () => {
  const px = (b: { data: Buffer; width: number }, x: number, y: number) => [...b.data.subarray((y * b.width + x) * 4, (y * b.width + x) * 4 + 4)]

  test('none at zero; 1–9; 9+ beyond; said in words for screen readers', () => {
    expect(badgeBitmap(0)).toBeNull()
    expect(badgeText(3)).toBe('3')
    expect(badgeText(12)).toBe('9+')
    expect(badgeDescription(1)).toBe('1 session needs you')
    expect(badgeDescription(4)).toBe('4 sessions need you')
  })

  test('a red disc with the count in white, transparent outside, as premultiplied BGRA', () => {
    for (const n of [1, 8, 42]) {
      const b = badgeBitmap(n)!
      expect(b.width).toBe(32)
      expect(b.data.length).toBe(32 * 32 * 4)
      expect(px(b, 0, 0)).toEqual([0, 0, 0, 0])
      expect(px(b, 31, 31)).toEqual([0, 0, 0, 0])
      expect(px(b, 16, 2)).toEqual([0x5c, 0x67, 0xe5, 255]) // inside the disc, above the text
      let white = 0
      for (let i = 0; i < b.data.length; i += 4) if (b.data[i] === 255 && b.data[i + 1] === 255 && b.data[i + 2] === 255) white++
      expect(white).toBeGreaterThan(40)
      // Premultiplied: no channel above its alpha.
      for (let i = 0; i < b.data.length; i += 4) expect(Math.max(b.data[i], b.data[i + 1], b.data[i + 2])).toBeLessThanOrEqual(b.data[i + 3])
    }
    expect(badgeBitmap(3)!.data.equals(badgeBitmap(4)!.data)).toBe(false)
  })
})
