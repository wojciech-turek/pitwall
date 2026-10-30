/**
 * The Pitwall host: `ELECTRON_RUN_AS_NODE=1 <Pitwall> out/host/index.js --data <dataDir> [--idle-ms <ms>]`.
 * Started detached by the app (HostBackend) when it needs one; keeps agents' terminals alive while the app is closed.
 */
import { parseArgs } from 'node:util'
import { APP_VERSION } from '@shared/version'
import { Host } from './server'

const { values } = parseArgs({
  options: { data: { type: 'string' }, 'idle-ms': { type: 'string' } },
  strict: true
})
if (!values.data) {
  console.error('usage: pitwall host --data <dataDir> [--idle-ms <ms>]')
  process.exit(2)
}
const idleMs = values['idle-ms'] ? Number(values['idle-ms']) : undefined
if (idleMs !== undefined && !(Number.isFinite(idleMs) && idleMs > 0)) {
  console.error('--idle-ms must be a positive number')
  process.exit(2)
}

// Set only to start this process as Node; agents and their tools must not inherit it.
delete process.env.ELECTRON_RUN_AS_NODE
const env: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v

const host = new Host({ dataDir: values.data, appVersion: APP_VERSION, idleMs, env })

// Losing the host loses every agent: log anything unexpected and carry on.
process.on('uncaughtException', (e) => host.log(`uncaught: ${e.stack ?? e}`))
process.on('unhandledRejection', (e) => host.log(`unhandled rejection: ${e instanceof Error ? e.stack : String(e)}`))
process.on('SIGHUP', () => { /* detached: no terminal to lose */ })
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => void host.stop(sig))

void (async () => {
  try {
    if (!(await host.start())) process.exit(0)
    await host.stopped
    process.exit(0)
  } catch (e) {
    host.log(`failed to start: ${e instanceof Error ? e.stack : String(e)}`)
    process.exit(1)
  }
})()
