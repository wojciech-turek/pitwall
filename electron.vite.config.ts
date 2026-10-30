import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = { '@shared': resolve('src/shared') }
const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
const define = { __APP_VERSION__: JSON.stringify(version) }

export default defineConfig({
  main: { resolve: { alias: shared }, define },
  // Sandboxed preload scripts must be CommonJS.
  preload: {
    resolve: { alias: shared },
    define,
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } }
  },
  renderer: { resolve: { alias: shared }, define, plugins: [react()] }
})
