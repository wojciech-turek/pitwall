import { describe, expect, test } from 'vitest'
import { descendants, parsePs, snapshotLeftovers, stopLeftovers } from '../../src/main/sessions/leftovers'

const SAMPLE = `    1     0 Thu Oct 30 08:00:01 2026
  100     1 Thu Oct 30 08:00:02 2026
  101   100 Thu Oct 30 16:02:49 2026
  102   101 Fri Oct  3 09:05:07 2026
  200     1 Thu Oct 30 08:00:05 2026
garbage line
`

describe('leftovers', () => {
  test('parses ps output with padded dates', () => {
    const rows = parsePs(SAMPLE)
    expect(rows).toHaveLength(5)
    expect(rows[3]).toEqual({ pid: 102, ppid: 101, start: 'Fri Oct 3 09:05:07 2026' })
  })
  test('collects roots and descendants, honours exclude, ignores unknown roots', () => {
    const rows = parsePs(SAMPLE)
    expect([...descendants(rows, [100, 999]).keys()].sort()).toEqual([100, 101, 102])
    expect([...descendants(rows, [100], [101]).keys()].sort()).toEqual([100])
  })

  const T = 'Thu Oct 30 16:02:49 2026'
  const psText = (rows: Array<[number, number, string?]>) => rows.map(([p, pp, t]) => `${p} ${pp} ${t ?? T}`).join('\n')
  const recorder = () => {
    const sent: Array<[number, string]> = []
    return { sent, kill: (pid: number, sig: NodeJS.Signals) => { sent.push([pid, sig]) } }
  }

  test('roots whose parent is not the tmux server are ignored (stale pane pid)', async () => {
    const ps = async () => psText([[500, 1], [600, 500], [700, 1], [701, 700]])
    // 500 is the server; pane 600 is live; 700 is a reused pid that is not a child of the server.
    expect([...(await snapshotLeftovers([600, 700], 500, { ps })).keys()]).toEqual([600])
    expect((await snapshotLeftovers([600], null, { ps })).size).toBe(0)
  })

  test('Pitwall and its ancestors are never in a snapshot', async () => {
    const me = process.pid
    const ps = async () => psText([[500, 1], [600, 500], [me, 600]])
    expect([...(await snapshotLeftovers([600], 500, { ps })).keys()]).toEqual([])
  })

  test('same pid with a different start time is never signalled', async () => {
    const r = recorder()
    await stopLeftovers(new Map([[900, T]]), { ps: async () => psText([[900, 1, 'Fri Oct 31 01:00:00 2026']]), kill: r.kill, graceMs: 200 })
    expect(r.sent).toEqual([])
  })

  test('ps failing or printing garbage sends no signals', async () => {
    for (const ps of [async () => { throw new Error('no ps') }, async () => 'nonsense\n\x00\x01']) {
      const r = recorder()
      await stopLeftovers(new Map([[900, T]]), { ps, kill: r.kill, graceMs: 200 })
      expect(r.sent).toEqual([])
      expect((await snapshotLeftovers([600], 500, { ps })).size).toBe(0)
    }
  })

  test('0, 1 and our own pid are never signalled', async () => {
    const r = recorder()
    const me = process.pid
    const snap = new Map([[0, T], [1, T], [me, T]])
    await stopLeftovers(snap, { ps: async () => psText([[0, 0], [1, 0], [me, 1]]), kill: r.kill, graceMs: 200 })
    expect(r.sent).toEqual([])
    expect((await snapshotLeftovers([0, 1, me], 1, { ps: async () => psText([[0, 1], [1, 1], [me, 1]]) })).size).toBe(0)
  })

  test('SIGTERM first; SIGKILL only reaches pids that still match after the grace period', async () => {
    const r = recorder()
    let call = 0
    const ps = async () => {
      call++
      if (call === 1) return psText([[900, 1], [901, 1]]) // both alive: SIGTERM both
      if (call === 2) return psText([[900, 1], [901, 1]]) // still alive after first poll
      return psText([[900, 1, 'Fri Oct 31 01:00:00 2026'], [901, 1]]) // 900's pid was reused
    }
    await stopLeftovers(new Map([[900, T], [901, T]]), { ps, kill: r.kill, graceMs: 150 })
    expect(r.sent.filter(([, s]) => s === 'SIGTERM').map(([p]) => p).sort()).toEqual([900, 901])
    expect(r.sent.filter(([, s]) => s === 'SIGKILL').map(([p]) => p)).toEqual([901])
  })
})
