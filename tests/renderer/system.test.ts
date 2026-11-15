import { describe, expect, test } from 'vitest'
import type { ProcStats, SystemStats } from '../../src/shared/types'
import { formatProc, heavyLabel, pillLabel, stepPill, type PillState, topSessions } from '../../src/renderer/src/state/system'

const GB = 1024 ** 3
const p = (cpu: number, rssGb: number, procs = 3): ProcStats => ({ cpu, rssBytes: rssGb * GB, procs })
const sys = (over: Partial<SystemStats> = {}): SystemStats => ({
  at: 0, pressure: 'normal', swapUsedBytes: 0, memTotalBytes: 16 * GB, diskFreeBytes: 500 * GB, diskTotalBytes: 926 * GB,
  pitwall: p(1, 0.3), sessions: {}, ...over
})

describe('heavyLabel', () => {
  test('needs 3 samples in a row at 2 GiB or more', () => {
    const big = p(10, 2.4)
    expect(heavyLabel([big, big])).toBeNull()
    expect(heavyLabel([big, p(10, 1), big])).toBeNull()
    expect(heavyLabel([big, big, big])).toBe('2.4 GB')
  })
  test('or 3 samples at 150% cpu or more', () => {
    expect(heavyLabel([p(180, 1), p(200, 1), p(180.4, 1)])).toBe('180%')
    expect(heavyLabel([p(180, 1), p(100, 1), p(180, 1)])).toBeNull()
  })
  test('only the last 3 count', () => {
    expect(heavyLabel([p(0, 0), p(180, 1), p(180, 1), p(180, 1)])).toBe('180%')
  })
})

const OFF: PillState = { level: null, reason: null, run: 0 }
const run = (samples: SystemStats[], from: PillState = OFF): PillState[] => {
  const out: PillState[] = []
  let st = from
  for (const x of samples) { st = stepPill(st, x); out.push(st) }
  return out
}

describe('stepPill', () => {
  const warn = sys({ pressure: 'warn' })
  const ok = sys()
  test('one warn sample is not enough; two turn it on', () => {
    expect(run([warn])[0].level).toBeNull()
    expect(run([warn, warn])[1].level).toBe('warn')
  })
  test('stays on through a single normal sample after a long warn run', () => {
    const levels = run([warn, warn, warn, warn, warn, ok, warn, ok, warn]).map((x) => x.level)
    expect(levels).toEqual([null, 'warn', 'warn', 'warn', 'warn', 'warn', 'warn', 'warn', 'warn'])
  })
  test('two normal samples in a row clear it', () => {
    const on = run([warn, warn])[1]
    expect(run([ok, ok], on).map((x) => x.level)).toEqual(['warn', null])
  })
  test('a lone warn between normal samples stays off', () => {
    expect(run([ok, warn, ok, warn, ok]).map((x) => x.level)).toEqual([null, null, null, null, null])
  })
  test('critical shows as critical and follows the latest bad sample', () => {
    const crit = sys({ pressure: 'critical' })
    expect(run([warn, warn, crit]).map((x) => x.level)).toEqual([null, 'warn', 'critical'])
    expect(run([crit, crit, warn])[2].level).toBe('warn')
  })
  test('a nearly full disk is a warn: under 10% or under 20 GB free', () => {
    const full = sys({ diskFreeBytes: 15 * GB })
    expect(run([full, full])[1]).toMatchObject({ level: 'warn', reason: 'disk' })
    const low = sys({ diskFreeBytes: 80 * GB })
    expect(run([low, low])[1].level).toBe('warn')
    const fine = sys({ diskFreeBytes: 200 * GB })
    expect(run([fine, fine])[1].level).toBeNull()
  })
  test('memory is the reason when both apply', () => {
    const both = sys({ pressure: 'warn', diskFreeBytes: 15 * GB })
    expect(run([both, both])[1].reason).toBe('memory')
  })
})

describe('pillLabel', () => {
  const st = (level: 'warn' | 'critical', reason: 'memory' | 'disk'): PillState => ({ level, reason, run: 0 })
  test('comes from the stored reason, not the latest sample', () => {
    expect(pillLabel(st('warn', 'memory'), sys({ diskFreeBytes: 15 * GB }))).toBe('Memory pressure high')
    expect(pillLabel(st('critical', 'memory'), sys())).toBe('Memory pressure critical')
    expect(pillLabel(st('warn', 'disk'), sys({ diskFreeBytes: 54 * GB }))).toBe('Disk almost full · 54 GB free')
  })
})

describe('topSessions and formatProc', () => {
  test('orders by rss and cuts to n', () => {
    const s = sys({ sessions: { a: p(1, 1), b: p(1, 3), c: p(1, 2) } })
    expect(topSessions(s, 2).map((x) => x.id)).toEqual(['b', 'c'])
  })
  test('formats cpu, size and process count', () => {
    expect(formatProc({ cpu: 34.6, rssBytes: 1.2 * GB, procs: 14 })).toBe('CPU 35% · 1.2 GB · 14 processes')
    expect(formatProc({ cpu: 0, rssBytes: 640 * 1024 ** 2, procs: 1 })).toBe('CPU 0% · 640 MB · 1 process')
  })
})
