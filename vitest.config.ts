import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: { environment: 'node', testTimeout: 20000, include: ['tests/**/*.test.ts'], globalSetup: ['tests/helpers/build-host.ts'] }
})
