import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = { '@shared': resolve('src/shared') }
const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
const define = { __APP_VERSION__: JSON.stringify(version) }

export default defineConfig({
  main: {
    resolve: { alias: shared },
    define,
    // Two entries: the app's main process (out/main/index.js) and the host (out/host/index.js), which the app runs
    // as Node to keep agents' terminals alive (src/host). Shared code goes to out/main/chunks.
    build: {
      outDir: 'out',
      emptyOutDir: false, // out/ also holds preload and renderer; each entry overwrites its own files
      rolldownOptions: {
        input: { 'main/index': resolve('src/main/index.ts'), 'host/index': resolve('src/host/index.ts') },
        output: { chunkFileNames: 'main/chunks/[name].js' }
      }
    }
  },
  // Sandboxed preload scripts must be CommonJS.
  preload: {
    resolve: { alias: shared },
    define,
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } }
  },
  renderer: { resolve: { alias: shared }, define, plugins: [react()] }
})
