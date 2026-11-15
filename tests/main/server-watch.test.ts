import { describe, expect, test } from 'vitest'
import type { Exec } from '../../src/main/exec'
import { ServerWatcher } from '../../src/main/server-watch'
import type { Store } from '../../src/main/store'

const PS = `  100     1 Thu Oct 30 08:00:02 2026
  101   100 Thu Oct 30 08:00:03 2026
`

function make(o: { devCommand?: string; platform?: NodeJS.Platform } = { devCommand: 'npm run dev' }) {
  const state = {
    subProjects: [{ id: 'sp', projectId: 'p', name: 'F', kind: 'folder', path: '/x', createdAt: 0, devCommand: o.devCommand }],
    sessions: [
      { id: 'a', subProjectId: 'sp' },
      { id: 'gone', subProjectId: 'sp', archivedAt: 5 }
    ]
  }
  const live = { running: true }
  const ports = { value: '' }
  const calls: string[][] = []
  const published: Array<[string, unknown]> = []
  const checked: string[] = []
  const backend = {
    hasSession: async (n: string) => { checked.push(n); return live.running },
    processRoots: async () => ({ serverPid: 1, panePids: [100] })
  }
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args])
    if (file === 'ps') return { code: 0, stdout: PS, stderr: '' }
    return { code: 0, stdout: ports.value, stderr: '' }
  }
  const w = new ServerWatcher({
    store: { state } as unknown as Store,
    manager: { updateSessionExtras: (id: string, patch: unknown) => { published.push([id, patch]) } },
    backend: backend as never, exec, platform: o.platform
  })
  return { w, state, live, ports, calls, published, checked }
}

describe('ServerWatcher', () => {
  test('publishes once when the state changes, not again when nothing changed', async () => {
    const m = make()
    m.ports.value = 'p101\nn*:5173\n'
    await m.w.tick()
    expect(m.published).toEqual([['a', { server: { running: true, ports: [5173] } }]])
    expect(m.calls.filter((c) => c[0] === 'ps')).toHaveLength(1)
    expect(m.calls.find((c) => c[0] === 'lsof')?.join(' ')).toContain('100,101')
    await m.w.tick()
    expect(m.published).toHaveLength(1)
    m.ports.value = 'p101\nn*:5173\nn*:24678\n'
    await m.w.tick()
    expect(m.published.at(-1)).toEqual(['a', { server: { running: true, ports: [5173, 24678] } }])
    m.live.running = false
    await m.w.tick()
    expect(m.published.at(-1)).toEqual(['a', { server: { running: false, ports: [] } }])
    expect(m.published).toHaveLength(3)
    expect(m.checked.every((n) => n === 'pw-a-srv')).toBe(true)
  })

  test('a folder without a dev command is skipped, and a published server is cleared', async () => {
    const m = make()
    await m.w.tick()
    expect(m.published).toHaveLength(1)
    delete m.state.subProjects[0].devCommand
    await m.w.tick()
    expect(m.published.at(-1)).toEqual(['a', { server: undefined }])
    await m.w.tick()
    expect(m.published).toHaveLength(2)
  })

  test('never throws, and does nothing on Windows', async () => {
    const m = make()
    m.w['deps'].backend.hasSession = async () => { throw new Error('boom') }
    await expect(m.w.tick()).resolves.toBeUndefined()
    const win = make({ devCommand: 'x', platform: 'win32' })
    win.w.start()
    await new Promise((r) => setTimeout(r, 20))
    win.w.stop()
    expect(win.checked).toEqual([])
  })
})
