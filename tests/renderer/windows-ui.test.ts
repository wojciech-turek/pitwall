import { describe, expect, test } from 'vitest'
import { formatAgentReference } from '../../src/shared/agent-ref'
import { isMac, modDown, modKey, platform, shortcut } from '../../src/renderer/src/platform'
import { paletteActions } from '../../src/renderer/src/state/palette'
import { appShortcutFor, shouldPassToApp } from '../../src/renderer/src/terminal/keys'
import { buildMenuTemplate } from '../../src/main/menu'
import type { MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '../../src/shared/api'
import { dropText, formatDroppedPaths, shellEscapePath } from '../../src/renderer/src/terminal/paths'
import type { AppSnapshot } from '../../src/shared/types'

describe('platform helpers', () => {
  test('macOS without a window (tests); shortcut labels say ⌘ there and Ctrl+ on Windows', () => {
    expect(platform()).toBe('darwin')
    expect(isMac()).toBe(true)
    expect([modKey('darwin'), shortcut('K', 'darwin'), shortcut(',', 'darwin')]).toEqual(['⌘', '⌘K', '⌘,'])
    expect([modKey('win32'), shortcut('K', 'win32'), shortcut('↵', 'win32')]).toEqual(['Ctrl+', 'Ctrl+K', 'Ctrl+↵'])
    expect(modDown({ metaKey: true, ctrlKey: false }, 'darwin')).toBe(true)
    expect(modDown({ metaKey: false, ctrlKey: true }, 'darwin')).toBe(false)
    expect(modDown({ metaKey: false, ctrlKey: true }, 'win32')).toBe(true)
  })

  test('the palette\'s shortcut labels follow the platform', () => {
    const snap = {
      projects: [{ id: 'p', name: 'P', createdAt: 0, extraEnv: [], identity: { sshKeyPath: '', ghAccount: '', gitName: '', gitEmail: '' } }],
      subProjects: [{ id: 'f', projectId: 'p', name: 'Repo', kind: 'folder' as const, path: '/r', createdAt: 0 }],
      sessions: [
        { id: 'a', subProjectId: 'f', title: 'A', slug: 'a', claudeSessionId: 'c', cwd: '/r', branchCreatedByPitwall: false, createdAt: 1, lastViewedAt: 0, status: 'read' },
        { id: 'b', subProjectId: 'f', title: 'B', slug: 'b', claudeSessionId: 'd', cwd: '/r', branchCreatedByPitwall: false, createdAt: 2, lastViewedAt: 0, status: 'needs_you' }
      ],
      archived: []
    } as unknown as Pick<AppSnapshot, 'projects' | 'subProjects' | 'sessions' | 'archived'>
    const labels = (p?: string) => paletteActions({ snap, activeSessionId: 'a', paneCount: 1, rightTab: 'files', canCheckUpdates: false, platform: p })
      .filter((a) => a.shortcut).map((a) => a.shortcut)
    expect(labels()).toEqual(['⌘N', '⌘J', '⌘,'])
    expect(labels('win32')).toEqual(['Ctrl+N', 'Ctrl+J', 'Ctrl+,'])
  })
})

describe('shortcuts on Windows', () => {
  type K = { code: string; key?: string; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean }
  const key = (o: K) => ({ key: o.key ?? o.code.replace(/^(Key|Digit)/, '').toLowerCase(), metaKey: false, ctrlKey: true, shiftKey: false, altKey: false, ...o })
  const win = (inTerminal: boolean) => ({ platform: 'win32', inTerminal })

  /** Every `CmdOrCtrl+<key>` in the menu, with the command it sends. */
  function menuShortcuts(): Array<[string, MenuCommand]> {
    const out: Array<[string, MenuCommand]> = []
    let sent: MenuCommand | null = null
    const walk = (items: MenuItemConstructorOptions[]): void => {
      for (const it of items) {
        if (Array.isArray(it.submenu)) walk(it.submenu)
        const m = /^CmdOrCtrl\+(.)$/.exec(String(it.accelerator ?? ''))
        if (!m || !it.click) continue
        ;(it.click as () => void)()
        out.push([m[1], sent!])
      }
    }
    walk(buildMenuTemplate((c) => { sent = c }, false, 'win32'))
    return out
  }
  const codeOf = (k: string) => (k === ',' ? 'Comma' : /\d/.test(k) ? `Digit${k}` : `Key${k.toUpperCase()}`)

  test('every menu shortcut but Save has a renderer mapping: plain Ctrl outside terminals, Ctrl+Shift in them', () => {
    const menu = menuShortcuts()
    expect(menu).toHaveLength(16)
    for (const [k, command] of menu) {
      const code = codeOf(k)
      if (k === 'S') {
        // Ctrl+S is never taken: CodeMirror's Mod-s saves the open file.
        expect(appShortcutFor(key({ code }), win(false))).toBeNull()
        expect(appShortcutFor(key({ code, shiftKey: true }), win(true))).toBeNull()
        continue
      }
      expect(appShortcutFor(key({ code }), win(false))).toEqual(command)
      expect(appShortcutFor(key({ code, shiftKey: true }), win(false))).toEqual(command) // Shift tolerated
      expect(appShortcutFor(key({ code, shiftKey: true }), win(true))).toEqual(command)
      expect(appShortcutFor(key({ code }), win(true))).toBeNull() // plain Ctrl+<key> is the program's
    }
  })

  test('by physical key, whatever the layout prints; AltGr (Ctrl+Alt) types characters; nothing on macOS', () => {
    expect(appShortcutFor(key({ code: 'Digit3', key: '#' }), win(false))).toEqual({ type: 'select-index', index: 2 })
    expect(appShortcutFor(key({ code: 'KeyK', key: 'л' }), win(false))).toEqual({ type: 'command-palette' })
    expect(appShortcutFor(key({ code: 'KeyN', altKey: true }), win(false))).toBeNull() // AltGr+N is ń in Polish
    expect(appShortcutFor(key({ code: 'KeyK', metaKey: true }), win(false))).toBeNull()
    expect(appShortcutFor(key({ code: 'KeyK', ctrlKey: false }), win(false))).toBeNull()
    expect(appShortcutFor(key({ code: 'Digit0' }), win(false))).toBeNull()
    expect(appShortcutFor(key({ code: 'KeyK' }), { platform: 'darwin', inTerminal: false })).toBeNull()
  })

  test('in a terminal: Ctrl+Shift+<app key> goes to the app; plain Ctrl+<letter> to the program, except the clipboard', () => {
    const t = { platform: 'win32' }
    for (const code of ['KeyK', 'KeyP', 'KeyN', 'KeyW', 'KeyJ', 'Comma', 'Digit1', 'Digit9']) {
      expect(shouldPassToApp(key({ code, shiftKey: true }), t)).toBe(true)
      expect(shouldPassToApp(key({ code }), t)).toBe(false)
    }
    for (const code of ['KeyS', 'KeyR', 'KeyD', 'KeyZ', 'KeyA']) expect(shouldPassToApp(key({ code }), t)).toBe(false)
    expect(shouldPassToApp(key({ code: 'KeyS', shiftKey: true }), t)).toBe(false)
    expect(shouldPassToApp(key({ code: 'KeyV' }), t)).toBe(true)
    expect(shouldPassToApp(key({ code: 'KeyV', shiftKey: true }), t)).toBe(true)
    expect(shouldPassToApp(key({ code: 'KeyC' }), { ...t, hasSelection: true })).toBe(true)
    expect(shouldPassToApp(key({ code: 'KeyC' }), { ...t, hasSelection: false })).toBe(false)
    expect(shouldPassToApp(key({ code: 'KeyC', shiftKey: true }), t)).toBe(true)
    expect(shouldPassToApp(key({ code: 'KeyK', shiftKey: true, altKey: true }), t)).toBe(false)
  })

  test('macOS is unchanged', () => {
    expect(shouldPassToApp({ metaKey: true, key: 'k' }, { platform: 'darwin' })).toBe(true)
    expect(shouldPassToApp({ metaKey: false, ctrlKey: true, key: 'v' }, { platform: 'darwin', hasSelection: true })).toBe(false)
  })
})

describe('paths crossing into a prompt on Windows', () => {
  test('dropped paths: as they are when nothing needs quoting, else in double quotes', () => {
    expect(shellEscapePath('C:\\Users\\me\\src\\a-b_c.v2\\x.ts', 'win32')).toBe('C:\\Users\\me\\src\\a-b_c.v2\\x.ts')
    expect(shellEscapePath('C:\\Users\\Zoë Łukasz\\My Repo\\a b.png', 'win32')).toBe('"C:\\Users\\Zoë Łukasz\\My Repo\\a b.png"')
    expect(shellEscapePath("C:\\Users\\O'Brien\\x.txt", 'win32')).toBe('"C:\\Users\\O\'Brien\\x.txt"')
    expect(formatDroppedPaths(['C:\\a\\b.txt', 'D:\\c d\\e.txt'], 'win32')).toBe('C:\\a\\b.txt "D:\\c d\\e.txt" ')
    // macOS unchanged.
    expect(formatDroppedPaths(['/a/b.txt', '/c/d e.txt'], 'darwin')).toBe("/a/b.txt '/c/d e.txt' ")
  })

  test('dropped on the Shell tab (PowerShell): single quotes, a quote inside doubled; bare only when nothing could split it', () => {
    expect(shellEscapePath('C:\\Users\\me\\x.ts', 'win32', 'shell')).toBe('C:\\Users\\me\\x.ts')
    expect(shellEscapePath('C:\\My Repo\\a,b@c.png', 'win32', 'shell')).toBe("'C:\\My Repo\\a,b@c.png'")
    expect(shellEscapePath("C:\\Users\\O'Brien\\$x.txt", 'win32', 'shell')).toBe("'C:\\Users\\O''Brien\\$x.txt'")
    expect(shellEscapePath('C:\\it’s.txt', 'win32', 'shell')).toBe("'C:\\it’’s.txt'")
    expect(dropText({ filePaths: ['C:\\x y\\f.png'], uriList: '', text: '' }, 'win32', 'shell')).toBe("'C:\\x y\\f.png' ")
    // Claude's prompt keeps double quotes; macOS is the same for both tabs.
    expect(dropText({ filePaths: ['C:\\x y\\f.png'], uriList: '', text: '' }, 'win32', 'claude')).toBe('"C:\\x y\\f.png" ')
    expect(dropText({ filePaths: ['/x y/f.png'], uriList: '', text: '' }, 'darwin', 'shell')).toBe("'/x y/f.png' ")
  })

  test('file links (a drag from an editor) become Windows paths, drive letters and network shares included', () => {
    expect(dropText({ filePaths: [], uriList: 'file:///C:/Users/me/My%20Repo/a.ts\r\nfile://server/share/z%C4%99.png', text: '' }, 'win32'))
      .toBe('"C:\\Users\\me\\My Repo\\a.ts" "\\\\server\\share\\zę.png" ')
    expect(dropText({ filePaths: [], uriList: 'file://server/share/x.png', text: '' }, 'win32')).toBe('\\\\server\\share\\x.png ')
    expect(dropText({ filePaths: ['C:\\x y\\f.png'], uriList: '', text: '' }, 'win32')).toBe('"C:\\x y\\f.png" ')
  })

  test('Send to agent: @path relative, with forward slashes on Windows', () => {
    expect(formatAgentReference('src\\main\\index.ts', undefined, 'win32')).toBe('@src/main/index.ts ')
    expect(formatAgentReference('docs\\My Notes.md', { fromLine: 3, toLine: 9 }, 'win32')).toBe('@"docs/My Notes.md" (lines 3-9) ')
    expect(formatAgentReference('src/a\\b.ts')).toBe('@src/a\\b.ts ') // elsewhere a backslash is part of a name
  })
})
