import { describe, expect, test } from 'vitest'
import { defaultBranchName, slugify } from '../../src/shared/slug'

describe('slugify', () => {
  test('basic cases', () => {
    expect(slugify('Fix tax rounding')).toBe('fix-tax-rounding')
    expect(slugify("Fix 'tax' $ rounding 🧾")).toBe('fix-tax-rounding')
    expect(slugify('Żółw łapie ćmę')).toBe('zolw-lapie-cme')
    expect(slugify('Øl Straße Đa ŁÓDŹ')).toBe('ol-strasse-da-lodz')
    expect(slugify('🧾')).toBe('session')
    expect(slugify('--x--')).toBe('x')
  })
  test('length capped at 40 without trailing dash', () => {
    const s = slugify('a'.repeat(30) + ' ' + 'b'.repeat(30))
    expect(s.length).toBeLessThanOrEqual(40)
    expect(s.endsWith('-')).toBe(false)
  })
  test('defaultBranchName', () => {
    expect(defaultBranchName('fix')).toBe('pitwall/fix')
  })
})
