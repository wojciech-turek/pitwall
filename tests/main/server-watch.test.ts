import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Exec } from '../../src/main/exec'
import { ServerWatcher } from '../../src/main/server-watch'
import type { Store } from '../../src/main/store'

const PS = `  100     1 Thu Oct 30 08:00:02 2026
  101   100 Thu Oct 30 08:00:03 2026
  200     1 Thu Oct 30 08:00:04 2026
  201   200 Thu Oct 30 08:00:05 2026
`

function make(o: { devCommand?: string; platform?: NodeJS.Platform; intervalMs?: number } = { devCommand: 'npm run dev' }) {
  const state = {
    subProjects: [{ id: 'sp', projectId: 'p', name: 'F', kind: 'folder', path: '/x', createdAt: 0, devCommand: o.devCommand }],
    sessions: [
      { id: 'a', subProjectId: 'sp' },
      { id: 'gone', subProjectId: 'sp', archivedAt: 5 }
    ]
  }
  /** The backend's sessions, by name. */
  const running = new Set(['pw-a', 'pw-a-srv', 'pw-gone-srv'])
  const ports = { value: '' }
  const calls: string[][] = []
  const published: Array<[string, unknown]> = []
  let listed = 0
  const backend = {
    listSessions: async () => { listed++; return [...running] },
    hasSession: async () => { throw new Error('one listSessions per tick, never a hasSession per session') },
    processRoots: async (n: string) => ({ serverPid: 1, panePids: n === 'pw-b-srv' ? [200] : [100] })
  }
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args])
    if (file === 'ps') return { code: 0, stdout: PS, stderr: '' }
    return { code: 0, stdout: ports.value, stderr: '' }
  }
  const w = new ServerWatcher({
    store: { state } as unknown as Store,
    manager: { updateSessionExtras: (id: string, patch: unknown) => { published.push([id, patch]) } },
    backend: backend as never, exec, platform: o.platform, intervalMs: o.intervalMs
  })
  return { w, state, running, ports, calls, published, backend, listed: () => listed }
}

afterEach(() => { vi.useRealTimers() })

describe('ServerWatcher', () => {
  test('publishes once when the state changes, not again when nothing changed', async () => {
    const m = make()
    m.ports.value = 'p101\nf3\nn*:5173\n'
    await m.w.tick()
    expect(m.published).toEqual([['a', { server: { running: true, ports: [5173] } }]])
    expect(m.calls.filter((c) => c[0] === 'ps')).toHaveLength(1)
    expect(m.calls.find((c) => c[0] === 'lsof')?.join(' ')).toContain('100,101')
    await m.w.tick()
    expect(m.published).toHaveLength(1)
    m.ports.value = 'p101\nf3\nn*:5173\nf4\nn*:24678\n'
    await m.w.tick()
    expect(m.published.at(-1)).toEqual(['a', { server: { running: true, ports: [5173, 24678] } }])
    m.running.delete('pw-a-srv')
    await m.w.tick()
    expect(m.published.at(-1)).toEqual(['a', { server: { running: false, ports: [] } }])
    expect(m.published).toHaveLength(3)
  })

  test('each tick: one listSessions, one ps and one lsof for every running server, ports given back by pid', async () => {
    const m = make()
    m.state.sessions.push({ id: 'b', subProjectId: 'sp' }, { id: 'c', subProjectId: 'sp' })
    m.running.add('pw-b-srv') // c's server isn't running
    m.ports.value = 'p101\nf3\nn*:5173\np201\nf4\nn127.0.0.1:3000\nf5\nn[::1]:3001\n'
    await m.w.tick()
    expect(m.listed()).toBe(1)
    expect(m.calls.filter((c) => c[0] === 'ps')).toHaveLength(1)
    const lsof = m.calls.filter((c) => c[0] === 'lsof')
    expect(lsof).toHaveLength(1)
    expect(lsof[0].slice(1)).toEqual(['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', '100,101,200,201', '-Fn'])
    expect(m.published).toEqual([
      ['a', { server: { running: true, ports: [5173] } }],
      ['b', { server: { running: true, ports: [3000, 3001] } }],
      ['c', { server: { running: false, ports: [] } }]
    ])
  })

  test('no server running: no ps and no lsof', async () => {
    const m = make()
    m.running.clear()
    await m.w.tick()
    expect(m.calls).toEqual([])
    expect(m.published).toEqual([['a', { server: { running: false, ports: [] } }]])
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

  test('looks every 5 seconds by default', async () => {
    vi.useFakeTimers()
    const m = make()
    m.w.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(m.listed()).toBe(1)
    await vi.advanceTimersByTimeAsync(4900)
    expect(m.listed()).toBe(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(m.listed()).toBe(2)
    m.w.stop()
  })

  test('never throws, and does nothing on Windows', async () => {
    const m = make()
    m.backend.listSessions = async () => { throw new Error('boom') }
    await expect(m.w.tick()).resolves.toBeUndefined()
    const win = make({ devCommand: 'x', platform: 'win32' })
    win.w.start()
    await new Promise((r) => setTimeout(r, 20))
    win.w.stop()
    expect(win.listed()).toBe(0)
  })
})
