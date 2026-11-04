import { beforeEach, describe, expect, test, vi } from 'vitest'

const electron = vi.hoisted(() => ({ dockIcons: [] as unknown[] }))
vi.mock('electron', () => ({
  app: { setBadgeCount: () => {}, dock: { setIcon: (i: unknown) => { electron.dockIcons.push(i) } } },
  nativeImage: { createFromBitmap: (data: Buffer, o: object) => ({ dotted: true, data, ...o }) },
  Notification: class { static isSupported(): boolean { return true } }
}))

import { electronNotifier } from '../../src/main/notifier'

beforeEach(() => { electron.dockIcons.length = 0 })

describe('the red dot on the Dock icon', () => {
  const size = 8
  const base = {
    plain: true,
    toBitmap: () => Buffer.alloc(size * size * 4, 0x20),
    getSize: () => ({ width: size, height: size })
  } as never
  const icons = () => electron.dockIcons.map((i) => ((i as { dotted?: boolean }).dotted ? 'dot' : 'plain'))

  test('macOS: shown while any session needs you or is unread, gone at zero; the icon changes only when that does', () => {
    const n = electronNotifier(() => {}, false, { platform: 'darwin', dockIcon: () => base })
    n.setBadge(0)
    expect(icons()).toEqual([]) // never shown: the icon is left alone
    n.setBadge(2)
    n.setBadge(3)
    n.setBadge(1)
    expect(icons()).toEqual(['dot'])
    n.setBadge(0)
    expect(icons()).toEqual(['dot', 'plain'])
    n.setBadge(1)
    expect(icons()).toEqual(['dot', 'plain', 'dot'])
    expect(electron.dockIcons[0]).toMatchObject({ width: size, height: size })
  })

  test('not in tests (quiet), not without an icon to draw on, not on Windows (the taskbar has its own badge)', () => {
    electronNotifier(() => {}, false, { platform: 'darwin', dockIcon: () => base, quiet: true }).setBadge(2)
    electronNotifier(() => {}, false, { platform: 'darwin' }).setBadge(2)
    electronNotifier(() => {}, false, { platform: 'darwin', dockIcon: () => null }).setBadge(2)
    electronNotifier(() => {}, false, { platform: 'win32', dockIcon: () => base }).setBadge(2)
    expect(icons()).toEqual([])
  })
})
