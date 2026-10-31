import { expect, test } from 'vitest'
import { baseName } from '@shared/base-name'

test('the last part of a path, with either separator', () => {
  expect(baseName('/Users/w/.ssh/id_ed25519')).toBe('id_ed25519')
  expect(baseName('C:\\Users\\Zoë Ł\\.ssh\\id_work')).toBe('id_work')
  expect(baseName('src/tax/rounding.ts')).toBe('rounding.ts')
  expect(baseName('C:/mixed\\dir/')).toBe('dir')
  expect(baseName('plain')).toBe('plain')
})
