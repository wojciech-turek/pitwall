import { describe, expect, test } from 'vitest'
import { descendants, parsePs } from '../../src/main/sessions/leftovers'

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
})
