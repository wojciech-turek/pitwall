import { execFile } from 'node:child_process'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { inject } from 'vitest'
import { HostBackend, type HostLaunch } from '../../src/main/host-backend'
import { waitFor } from './wait'

const run = promisify(execFile)

/** A fresh data dir (its path has a space, like "Application Support") in a new temp folder. */
export async function makeHostDirs(): Promise<{ tmp: string; dataDir: string }> {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'pitwall-host-')))
  return { tmp, dataDir: join(tmp, 'data dir') }
}

/** Starts the test build of the host with Node, as the app starts out/host/index.js with its own executable. */
export function hostLaunch(dataDir: string, o: { idleMs?: number; env?: Record<string, string> } = {}): HostLaunch {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return {
    file: process.execPath,
    args: [inject('hostScript'), '--data', dataDir, ...(o.idleMs ? ['--idle-ms', String(o.idleMs)] : [])],
    env: { ...env, ...o.env }
  }
}

export function makeHostBackend(dataDir: string, o: { idleMs?: number; env?: Record<string, string>; start?: boolean } = {}): HostBackend {
  return new HostBackend({ dataDir, appVersion: 'test', launch: o.start === false ? null : hostLaunch(dataDir, o) })
}

/** Every host process running for `dataDir` (from ps), whether or not it is listening. */
export async function hostPids(dataDir: string): Promise<number[]> {
  const { stdout } = await run('/bin/ps', ['-axww', '-o', 'pid=,command='], { maxBuffer: 32 * 1024 * 1024 })
  const arg = `--data ${dataDir}`
  return stdout.split('\n')
    .filter((l) => l.includes(inject('hostScript')) && (l.endsWith(arg) || l.includes(`${arg} --`)))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
}

/** Stops the host for `dataDir` and makes sure no host process is left (killing any that won't stop). */
export async function stopHost(dataDir: string): Promise<void> {
  const b = new HostBackend({ dataDir, appVersion: 'test', launch: null })
  await b.shutdown().catch(() => {})
  b.disconnect()
  for (const pid of await hostPids(dataDir)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  }
  await waitFor(async () => (await hostPids(dataDir)).length === 0, 8000, `no host left for ${dataDir}`)
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
