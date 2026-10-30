import { describe, expect, test } from 'vitest'
import { shouldPassToApp } from '../../src/renderer/src/terminal/keys'

const key = (o: { metaKey?: boolean; ctrlKey?: boolean; key: string }) => ({ metaKey: false, ctrlKey: false, ...o })

describe('shouldPassToApp', () => {
  test('meta combos go to the app except copy/paste/select-all', () => {
    expect(shouldPassToApp(key({ metaKey: true, key: 'n' }))).toBe(true)
    expect(shouldPassToApp(key({ metaKey: true, key: 'c' }))).toBe(false)
    expect(shouldPassToApp(key({ metaKey: true, key: 'v' }))).toBe(false)
    expect(shouldPassToApp(key({ metaKey: true, key: 'a' }))).toBe(false)
    expect(shouldPassToApp(key({ metaKey: true, key: '3' }))).toBe(true)
  })
  test('plain keys stay in the terminal', () => {
    expect(shouldPassToApp(key({ key: 'Escape' }))).toBe(false)
    expect(shouldPassToApp(key({ ctrlKey: true, key: 'c' }))).toBe(false)
    expect(shouldPassToApp(key({ key: 'n' }))).toBe(false)
  })
})
