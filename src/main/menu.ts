import type { MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '@shared/api'

/**
 * The application menu. Pure (types only from electron) so it can be tested in node.
 * ⌘W closes the active tab, never the window.
 */
export function buildMenuTemplate(send: (c: MenuCommand) => void, isDev: boolean): MenuItemConstructorOptions[] {
  const cmd = (label: string, accelerator: string, command: MenuCommand): MenuItemConstructorOptions => ({
    label, accelerator, click: () => send(command)
  })
  const sessionItems: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) =>
    cmd(`Session ${i + 1}`, `CmdOrCtrl+${i + 1}`, { type: 'select-index', index: i }))

  return [
    {
      label: 'pitwall',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        cmd('Settings…', 'CmdOrCtrl+,', { type: 'settings' }),
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        cmd('New Session', 'CmdOrCtrl+N', { type: 'new-session' }),
        cmd('Save', 'CmdOrCtrl+S', { type: 'save' }),
        { type: 'separator' },
        cmd('Close Tab', 'CmdOrCtrl+W', { type: 'close-tab' })
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: 'Go',
      submenu: [
        cmd('Command Palette…', 'CmdOrCtrl+K', { type: 'command-palette' }),
        cmd('Go to File…', 'CmdOrCtrl+P', { type: 'quick-open' }),
        { type: 'separator' },
        cmd('Next Session Needing You', 'CmdOrCtrl+J', { type: 'next-attention' }),
        { type: 'separator' },
        ...sessionItems
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        ...(isDev ? [{ type: 'separator' as const }, { role: 'reload' as const }, { role: 'toggleDevTools' as const }] : [])
      ]
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] }
  ]
}

/** The menu's Ctrl shortcuts (accelerators `CmdOrCtrl+<key>` above); a test keeps the two in step. */
const SHORTCUTS: Record<string, MenuCommand> = {
  ',': { type: 'settings' }, n: { type: 'new-session' }, s: { type: 'save' }, w: { type: 'close-tab' },
  k: { type: 'command-palette' }, p: { type: 'quick-open' }, j: { type: 'next-attention' }
}

export interface KeyInput { type: string; key: string; control: boolean; meta: boolean; alt: boolean; shift: boolean }

/**
 * Windows: the menu's shortcuts (Ctrl there), taken before the page sees them, so they work while a terminal has the
 * keyboard (it would send Ctrl+K and the rest to the program as control characters) and with the menu bar hidden.
 * macOS: null; the menu takes ⌘ shortcuts itself, and ⌘ never reaches a terminal as a control key.
 */
export function appShortcut(input: KeyInput, platform: NodeJS.Platform): MenuCommand | null {
  if (platform === 'darwin' || input.type !== 'keyDown' || !input.control || input.meta || input.alt || input.shift) return null
  const key = input.key.toLowerCase()
  if (/^[1-9]$/.test(key)) return { type: 'select-index', index: Number(key) - 1 }
  return SHORTCUTS[key] ?? null
}
