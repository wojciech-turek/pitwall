import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { APP_VERSION } from '@shared/version'

describe('APP_VERSION', () => {
  test('equals the package.json version', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
    expect(APP_VERSION).toBe(pkg.version)
  })
})
