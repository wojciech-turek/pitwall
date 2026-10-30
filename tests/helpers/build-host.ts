import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  export interface ProvidedContext {
    /** The host program built from src/host, runnable with Node: `node <hostScript> --data <dir>`. */
    hostScript: string
  }
}

const root = resolve(import.meta.dirname, '..', '..')

/**
 * vitest globalSetup: builds src/host once per run, as electron-vite does for out/host/index.js (node-pty stays
 * external), so tests run the real host as its own process without `pnpm build` first. The output sits inside the repo
 * so the host resolves node-pty from node_modules.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const outDir = join(root, 'node_modules', '.cache', 'pitwall-test-host', String(process.pid))
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
  await build({
    configFile: false,
    root,
    logLevel: 'warn',
    resolve: { alias: { '@shared': join(root, 'src/shared') } },
    define: { __APP_VERSION__: JSON.stringify(version) },
    build: {
      ssr: join(root, 'src/host/index.ts'),
      outDir,
      emptyOutDir: true,
      minify: false,
      target: 'node22',
      rolldownOptions: { output: { format: 'es', entryFileNames: 'index.mjs' } }
    }
  })
  project.provide('hostScript', join(outDir, 'index.mjs'))
  return async () => { await rm(outDir, { recursive: true, force: true }) }
}
