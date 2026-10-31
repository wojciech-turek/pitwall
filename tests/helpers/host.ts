import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as net from 'node:net'
import { expect, inject } from 'vitest'
import { checkProof, newNonce, proofFor, readHostKey } from '../../src/host/auth'
import { hostSocketPath } from '../../src/host/paths'
import { encodeJson, FrameDecoder, PROTOCOL, type Frame } from '../../src/host/protocol'
import { HostBackend, type HostLaunch } from '../../src/main/host-backend'
import { commandLines, runsHost } from './processes'
import { waitFor } from './wait'

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

/** Every host process running for `dataDir` (from ps, or Win32_Process), whether or not it is listening. */
export async function hostPids(dataDir: string): Promise<number[]> {
  return (await commandLines('--data')).filter((p) => runsHost(p.cmd, inject('hostScript'), dataDir)).map((p) => p.pid)
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

export interface RawClient {
  s: net.Socket
  /** Frames after the handshake (or every frame, without one). */
  frames: Frame[]
  closed(): boolean
}

/**
 * A raw protocol client, for what the app never does. With `handshake` (the default) it proves it knows the host key
 * first, as the app does.
 */
export async function rawClient(dataDir: string, o: { handshake?: boolean } = {}): Promise<RawClient> {
  const s = net.connect(hostSocketPath(dataDir))
  const frames: Frame[] = []
  const d = new FrameDecoder()
  let closed = false
  s.on('data', (c: Buffer) => { try { frames.push(...d.push(c)) } catch { /* ignore */ } })
  s.on('close', () => { closed = true })
  s.on('error', () => {})
  await new Promise<void>((r) => s.once('connect', () => r()))
  const c: RawClient = { s, frames, closed: () => closed }
  if (o.handshake === false) return c
  const nonce = newNonce()
  s.write(encodeJson({ t: 'hello', protocol: PROTOCOL, appVersion: 'raw', nonce }))
  const hello = (await waitFor(async () => frames[0], 5000, 'host hello')) as Frame & { type: 'json' }
  const m = hello.msg as { nonce: string; proof: string }
  const key = readHostKey(dataDir)
  if (!checkProof(key, 'host', nonce, m.proof)) throw new Error("the host's proof doesn't match")
  s.write(encodeJson({ t: 'auth', proof: proofFor(key, 'app', m.nonce) }))
  await waitFor(async () => frames.length === 2, 5000, 'ready')
  expect(frames[1]).toMatchObject({ type: 'json', msg: { t: 'ready' } })
  frames.length = 0
  return c
}
