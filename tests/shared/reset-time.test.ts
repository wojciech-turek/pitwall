import { describe, expect, test } from 'vitest'
import { resetTimeFor } from '../../src/shared/reset-time'

const NOW = 1_000_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN

describe('resetTimeFor', () => {
  test('the latest reset among windows that are full', () => {
    const usage = {
      fiveHour: { usedPercentage: 100, resetsAt: NOW + HOUR },
      sevenDay: { usedPercentage: 100, resetsAt: NOW + 5 * HOUR },
      updatedAt: NOW
    }
    expect(resetTimeFor(usage, NOW)).toBe(NOW + 5 * HOUR + 2 * MIN)
  })
  test('a full window that has already reset is ignored', () => {
    const usage = {
      fiveHour: { usedPercentage: 100, resetsAt: NOW - HOUR },
      sevenDay: { usedPercentage: 40, resetsAt: NOW + 3 * HOUR },
      updatedAt: NOW
    }
    expect(resetTimeFor(usage, NOW)).toBe(NOW + 3 * HOUR + 2 * MIN)
  })
  test('with no full window, the earliest reset in the future', () => {
    const usage = {
      fiveHour: { usedPercentage: 60, resetsAt: NOW + 2 * HOUR },
      sevenDay: { usedPercentage: 30, resetsAt: NOW + 50 * HOUR },
      updatedAt: NOW
    }
    expect(resetTimeFor(usage, NOW)).toBe(NOW + 2 * HOUR + 2 * MIN)
  })
  test('with nothing known, an hour from now', () => {
    expect(resetTimeFor(undefined, NOW)).toBe(NOW + 62 * MIN)
    expect(resetTimeFor({ updatedAt: NOW }, NOW)).toBe(NOW + 62 * MIN)
  })
})
