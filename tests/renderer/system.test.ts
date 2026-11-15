import { describe, expect, test } from 'vitest'
import type { ProcStats, SystemStats } from '../../src/shared/types'
import { formatProc, heavyLabel, pillLabel, pillLevel, topSessions } from '../../src/renderer/src/state/system'

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

describe('pillLevel', () => {
  const warn = sys({ pressure: 'warn' })
  const ok = sys()
  test('turns on after 2 warn samples and off after 2 normal ones', () => {
    expect(pillLevel([ok, warn])).toBeNull()
    expect(pillLevel([ok, warn, warn])).toBe('warn')
    expect(pillLevel([warn, warn, ok])).toBe('warn')
    expect(pillLevel([warn, ok, ok])).toBeNull()
    expect(pillLevel([ok, ok, ok])).toBeNull()
  })
  test('critical shows as critical', () => {
    expect(pillLevel([ok, sys({ pressure: 'critical' }), sys({ pressure: 'critical' })])).toBe('critical')
  })
  test('a nearly full disk is a warn: under 10% or under 20 GB free', () => {
    const full = sys({ diskFreeBytes: 15 * GB })
    expect(pillLevel([full, full])).toBe('warn')
    const low = sys({ diskFreeBytes: 80 * GB })
    expect(pillLevel([low, low])).toBe('warn')
    const fine = sys({ diskFreeBytes: 200 * GB })
    expect(pillLevel([fine, fine])).toBeNull()
  })
})

describe('pillLabel', () => {
  test('memory wins over disk', () => {
    expect(pillLabel(sys({ pressure: 'warn', diskFreeBytes: 15 * GB }), 'warn')).toBe('Memory pressure high')
    expect(pillLabel(sys({ pressure: 'critical' }), 'critical')).toBe('Memory pressure critical')
    expect(pillLabel(sys({ diskFreeBytes: 54 * GB }), 'warn')).toBe('Disk almost full · 54 GB free')
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
