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
