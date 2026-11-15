import { tmpdir } from 'node:os'
import { describe, expect, test, vi } from 'vitest'
import type { Exec } from '../../src/main/exec'
import { parsePsUsage, parseSwapUsed, pressureFrom, SystemMonitor, treeStats } from '../../src/main/system-monitor'
import { sessionIdFromTmuxName } from '../../src/main/tmux'

const PS = `
    1     0   1000  0.0
  100     1   2048  1.5
  101   100   4096  2.5
  102   101   1024 10.0
  200     1   9999 50.0
garbage line
`

describe('parsePsUsage', () => {
  test('reads pid, ppid, rss (KB) and cpu; skips lines that do not fit', () => {
    const rows = parsePsUsage(PS)
    expect(rows.size).toBe(5)
    expect(rows.get(101)).toEqual({ ppid: 100, rssKb: 4096, cpu: 2.5 })
  })
})

describe('treeStats', () => {
  test('sums roots and all descendants once; ignores unrelated processes', () => {
    const rows = parsePsUsage(PS)
    expect(treeStats(rows, [100])).toEqual({ cpu: 14, rssBytes: (2048 + 4096 + 1024) * 1024, procs: 3 })
    // a root that is also a descendant of another root is not counted twice
    expect(treeStats(rows, [100, 101]).procs).toBe(3)
    expect(treeStats(rows, [999])).toEqual({ cpu: 0, rssBytes: 0, procs: 0 })
  })
})

test('parseSwapUsed', () => {
  expect(parseSwapUsed('total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)')).toBe(1024.5 * 2 ** 20)
  expect(parseSwapUsed('total = 4.00G  used = 1.50G  free = 2.50G')).toBe(1.5 * 2 ** 30)
  expect(parseSwapUsed('nonsense')).toBe(0)
  expect(parseSwapUsed('')).toBe(0)
})

test('pressureFrom', () => {
  expect(pressureFrom(1)).toBe('normal')
  expect(pressureFrom(2)).toBe('warn')
  expect(pressureFrom(4)).toBe('critical')
  expect(pressureFrom(0)).toBe('normal')
  expect(pressureFrom(NaN)).toBe('normal')
})

test('sessionIdFromTmuxName reverses tmuxNameFor', () => {
  expect(sessionIdFromTmuxName('pw-a')).toEqual({ id: 'a', kind: 'claude' })
  expect(sessionIdFromTmuxName('pw-a-sh')).toEqual({ id: 'a', kind: 'shell' })
  expect(sessionIdFromTmuxName('pw-a-srv')).toEqual({ id: 'a', kind: 'server' })
  expect(sessionIdFromTmuxName('pw-s_ab12cd34-srv')).toEqual({ id: 's_ab12cd34', kind: 'server' })
  expect(sessionIdFromTmuxName('pw-my-id-sh')).toEqual({ id: 'my-id', kind: 'shell' })
  expect(sessionIdFromTmuxName('other')).toBeNull()
  expect(sessionIdFromTmuxName('pw-')).toBeNull()
})

describe('SystemMonitor', () => {
  const zero = { cpu: 0, rssBytes: 0, procs: 0 }
  const psText = `
    50     1    100  0.0
    60    50   1000  1.0
    61    60   2000  2.0
    70    50   3000  3.0
    80    50   5000  4.0
    90     1   7000  5.0
    91    90   8000  6.0
`
  const makeExec = (calls: string[][] = []): Exec => vi.fn(async (file: string, args: string[]) => {
    calls.push([file, ...args])
    if (file === 'sysctl' && args.includes('kern.memorystatus_vm_pressure_level')) return { code: 0, stdout: '2\n', stderr: '' }
    if (file === 'sysctl') return { code: 0, stdout: 'total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)\n', stderr: '' }
    return { code: 0, stdout: psText, stderr: '' }
  })

  test('a session sums its pw-<id> and pw-<id>-sh trees; skips panes whose parent is not the server', async () => {
    const calls: string[][] = []
    const mon = new SystemMonitor({
      exec: makeExec(calls),
      backend: {
        listPaneRoots: async () => ({
          serverPid: 50,
          panes: new Map([
            ['pw-a', [60]],
            ['pw-a-sh', [70]],
            ['pw-a-srv', [91]], // parent is 90, not the server: a reused pid
            ['pw-gone', [80]], // not a live session
            ['pw-b', [90]] // parent 1, not the server
          ])
        })
      },
      liveSessionIds: () => ['a', 'b'],
      diskPath: tmpdir(),
      appMetrics: () => ({ cpu: 7, rssBytes: 123, procs: 4 })
    })
    const seen = vi.fn()
    mon.onChange(seen)
    await mon.sample()
    const s = mon.current()!
    expect(s.sessions).toEqual({ a: { cpu: 6, rssBytes: (1000 + 2000 + 3000) * 1024, procs: 3 } })
    expect(s.pitwall).toEqual({ cpu: 7, rssBytes: 123, procs: 4 })
    expect(s.pressure).toBe('warn')
    expect(s.swapUsedBytes).toBe(1024.5 * 2 ** 20)
    expect(s.memTotalBytes).toBeGreaterThan(0)
    expect(s.diskTotalBytes).toBeGreaterThan(0)
    expect(s.diskFreeBytes).toBeGreaterThan(0)
    expect(seen).toHaveBeenCalledTimes(1)
    // one ps and two sysctl, whatever the number of sessions
    expect(calls.filter((c) => c[0] === '/bin/ps')).toHaveLength(1)
    expect(calls.filter((c) => c[0] === 'sysctl')).toHaveLength(2)
  })

  test('no tmux server: system fields are set and sessions is {}', async () => {
    const mon = new SystemMonitor({
      exec: makeExec(),
      backend: { listPaneRoots: async () => ({ serverPid: null, panes: new Map() }) },
      liveSessionIds: () => ['a'],
      diskPath: tmpdir(),
      appMetrics: () => zero
    })
    await mon.sample()
    const s = mon.current()!
    expect(s.sessions).toEqual({})
    expect(s.pressure).toBe('warn')
    expect(s.diskTotalBytes).toBeGreaterThan(0)
  })

  test('a backend without listPaneRoots still publishes the system fields', async () => {
    const mon = new SystemMonitor({ exec: makeExec(), backend: {}, liveSessionIds: () => ['a'], diskPath: tmpdir(), appMetrics: () => zero })
    await mon.sample()
    expect(mon.current()!.sessions).toEqual({})
    expect(mon.current()!.swapUsedBytes).toBeGreaterThan(0)
  })

  test('every failure degrades to defaults and never throws', async () => {
    const mon = new SystemMonitor({
      exec: async () => { throw new Error('boom') },
      backend: { listPaneRoots: async () => { throw new Error('boom') } },
      liveSessionIds: () => ['a'],
      diskPath: '/nonexistent/path/for/pitwall',
      appMetrics: () => { throw new Error('boom') }
    })
    await expect(mon.sample()).resolves.toBeUndefined()
    const s = mon.current()!
    expect(s).toMatchObject({ pressure: 'normal', swapUsedBytes: 0, diskFreeBytes: 0, diskTotalBytes: 0, sessions: {}, pitwall: zero })
  })

  test('ticks do not overlap; start samples at once and every interval; stop clears the timer', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const listPaneRoots = vi.fn(async () => { await gate; return { serverPid: null, panes: new Map<string, number[]>() } })
    let tick!: () => void
    const clear = vi.fn()
    const mon = new SystemMonitor({
      exec: makeExec(), backend: { listPaneRoots }, liveSessionIds: () => [], diskPath: tmpdir(), appMetrics: () => zero,
      intervalMs: 1234,
      timers: { setInterval: (fn, ms) => { expect(ms).toBe(1234); tick = fn; return 'T' }, clearInterval: clear }
    })
    mon.start()
    tick(); tick()
    expect(listPaneRoots).toHaveBeenCalledTimes(1)
    release()
    await mon.sample()
    expect(mon.current()).not.toBeNull()
    tick()
    expect(listPaneRoots).toHaveBeenCalledTimes(2)
    mon.stop()
    expect(clear).toHaveBeenCalledWith('T')
  })
})
