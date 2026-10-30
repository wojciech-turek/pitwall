import { describe, expect, test } from 'vitest'
import { __pushUsage, __usageStore, formatResetTime, usageLevel, usageRow } from '../../src/renderer/src/state/usage'

// Local times, so the tests hold in any time zone.
const at = (day: number, h: number, m: number, s = 0) => new Date(2026, 9, day, h, m, s).getTime() // Oct 2026; the 27th is a Tuesday
const now = at(30, 9, 0) // Friday 09:00

describe('usage display', () => {
  test('reset time: hh:mm today, weekday + hh:mm on another day, 24h clock', () => {
    expect(formatResetTime(at(30, 14, 10), now)).toBe('14:10')
    expect(formatResetTime(at(30, 23, 59, 40), now)).toBe('Sat 00:00') // rounded to the minute
    expect(formatResetTime(at(31, 9, 5), now)).toBe('Sat 09:05')
    expect(formatResetTime(at(27 + 7, 9, 0), now)).toBe('Tue 09:00')
  })

  test('level: normal below 75%, warn from 75%, high from 90%', () => {
    expect([0, 74, 75, 89, 90, 100].map(usageLevel)).toEqual(['ok', 'ok', 'warn', 'warn', 'high', 'high'])
  })

  test('a live window shows its rounded percentage and reset time', () => {
    expect(usageRow({ usedPercentage: 41.6, resetsAt: at(30, 14, 10) }, now))
      .toEqual({ percent: 42, pct: '42%', reset: 'resets 14:10', level: 'ok' })
    expect(usageRow({ usedPercentage: 74.5, resetsAt: at(31, 9, 0) }, now))
      .toEqual({ percent: 75, pct: '75%', reset: 'resets Sat 09:00', level: 'warn' })
    expect(usageRow({ usedPercentage: 130, resetsAt: at(31, 9, 0) }, now)).toMatchObject({ percent: 100, pct: '100%', level: 'high' })
  })

  test('a window past its reset time shows as reset, not stale numbers', () => {
    expect(usageRow({ usedPercentage: 97, resetsAt: now }, now)).toEqual({ percent: 0, pct: '', reset: 'reset', level: 'ok' })
    expect(usageRow({ usedPercentage: 97, resetsAt: now - 60_000 }, now)).toMatchObject({ reset: 'reset', percent: 0 })
  })

  test('a window Claude did not report shows a dash', () => {
    expect(usageRow(undefined, now)).toEqual({ percent: 0, pct: '—', reset: '', level: 'ok' })
  })

  test('pushed usage replaces the stored value', () => {
    const u = { fiveHour: { usedPercentage: 5, resetsAt: now }, updatedAt: now }
    __pushUsage(u)
    expect(__usageStore.getState().usage).toEqual(u)
    __pushUsage(null)
    expect(__usageStore.getState().usage).toBeNull()
  })
})
