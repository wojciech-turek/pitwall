import { describe, expect, test } from 'vitest'
import { formatAgentReference } from '../../src/shared/agent-ref'
import { isMac, modDown, modKey, platform, shortcut } from '../../src/renderer/src/platform'
import { paletteActions } from '../../src/renderer/src/state/palette'
import { shouldPassToApp } from '../../src/renderer/src/terminal/keys'
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

describe('terminal keys on Windows', () => {
  const key = (k: string, o: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean } = {}) =>
    ({ key: k, metaKey: false, ctrlKey: true, shiftKey: false, altKey: false, ...o })
  const win = { platform: 'win32' }

  test('Ctrl+V pastes; Ctrl+C copies a selection and is the interrupt otherwise; Ctrl+Shift+C/V always copy/paste', () => {
    expect(shouldPassToApp(key('v'), win)).toBe(true)
    expect(shouldPassToApp(key('V', { shiftKey: true }), win)).toBe(true)
    expect(shouldPassToApp(key('c'), { ...win, hasSelection: true })).toBe(true)
    expect(shouldPassToApp(key('c'), { ...win, hasSelection: false })).toBe(false)
    expect(shouldPassToApp(key('C', { shiftKey: true }), win)).toBe(true)
  })

  test('every other Ctrl key, and Alt combinations, stay with the program', () => {
    for (const k of ['k', 'p', 'w', 'r', 'd', 'z', 'a', '[']) expect(shouldPassToApp(key(k), win)).toBe(false)
    expect(shouldPassToApp(key('v', { altKey: true }), win)).toBe(false)
    expect(shouldPassToApp(key('x', { ctrlKey: false }), win)).toBe(false)
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
