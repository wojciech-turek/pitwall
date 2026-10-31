import type { MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '@shared/api'

/**
 * The application menu. Pure (types only from electron) so it can be tested in node.
 * ⌘W closes the active tab, never the window.
 * Windows: no item registers its shortcut, the built-in ones (undo, copy, paste, minimize, reload…) included.
 * Ctrl+<key> belongs to the program in a terminal and to the editor or text field elsewhere (Chromium does undo and
 * the clipboard there itself); the renderer takes the app's own shortcuts (appShortcutFor).
 */
export function buildMenuTemplate(
  send: (c: MenuCommand) => void, isDev: boolean, platform: NodeJS.Platform = process.platform
): MenuItemConstructorOptions[] {
  const cmd = (label: string, accelerator: string, command: MenuCommand): MenuItemConstructorOptions => ({
    label, accelerator, click: () => send(command)
  })
  const sessionItems: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) =>
    cmd(`Session ${i + 1}`, `CmdOrCtrl+${i + 1}`, { type: 'select-index', index: i }))

  const template: MenuItemConstructorOptions[] = [
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
  return platform === 'win32' ? withoutAccelerators(template) : template
}

/** Every item with a role or a shortcut, shown but not registered. */
function withoutAccelerators(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.map((i) => ({
    ...i,
    ...(i.role || i.accelerator ? { registerAccelerator: false } : {}),
    ...(Array.isArray(i.submenu) ? { submenu: withoutAccelerators(i.submenu) } : {})
  }))
}


