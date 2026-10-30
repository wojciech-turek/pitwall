import { describe, test, expect } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '@shared/api'
import { buildMenuTemplate } from '../../src/main/menu'

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? flatten(i.submenu) : [])])
}
function press(accel: string, isDev = false): MenuCommand[] {
  const sent: MenuCommand[] = []
  const item = flatten(buildMenuTemplate((c) => sent.push(c), isDev)).find((i) => i.accelerator === accel)
  expect(item, `no item with ${accel}`).toBeDefined()
  ;(item!.click as (...a: unknown[]) => void)(undefined, undefined, undefined)
  return sent
}

describe('menu', () => {
  test('menu accelerators map to commands', () => {
    expect(press('CmdOrCtrl+J')).toEqual([{ type: 'next-attention' }])
    expect(press('CmdOrCtrl+3')).toEqual([{ type: 'select-index', index: 2 }])
    expect(press('CmdOrCtrl+1')).toEqual([{ type: 'select-index', index: 0 }])
    expect(press('CmdOrCtrl+9')).toEqual([{ type: 'select-index', index: 8 }])
    expect(press('CmdOrCtrl+W')).toEqual([{ type: 'close-tab' }])
    expect(press('CmdOrCtrl+N')).toEqual([{ type: 'new-session' }])
    expect(press('CmdOrCtrl+S')).toEqual([{ type: 'save' }])
    expect(press('CmdOrCtrl+,')).toEqual([{ type: 'settings' }])
    expect(press('CmdOrCtrl+K')).toEqual([{ type: 'command-palette' }])
    expect(press('CmdOrCtrl+P')).toEqual([{ type: 'quick-open' }])
  })

  test('⌘W is never the window-closing role', () => {
    const all = flatten(buildMenuTemplate(() => undefined, true))
    expect(all.filter((i) => i.role === 'close' || i.role === 'quit' && i.accelerator === 'CmdOrCtrl+W')).toEqual([])
    expect(all.filter((i) => i.accelerator === 'CmdOrCtrl+W')).toHaveLength(1)
  })

  test('devtools and reload only in dev', () => {
    const roles = (dev: boolean): unknown[] => flatten(buildMenuTemplate(() => undefined, dev)).map((i) => i.role)
    expect(roles(true)).toContain('toggleDevTools')
    expect(roles(false)).not.toContain('toggleDevTools')
    expect(roles(false)).not.toContain('reload')
  })

  test('standard edit roles are present', () => {
    const roles = flatten(buildMenuTemplate(() => undefined, false)).map((i) => i.role)
    for (const r of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) expect(roles).toContain(r)
  })
})
