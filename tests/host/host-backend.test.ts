import { randomBytes } from 'node:crypto'
import { chmodSync, rmSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import * as net from 'node:net'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { checkProof, newNonce, proofFor, writeHostKey } from '../../src/host/auth'
import { hostKeyFile, hostSocketPath } from '../../src/host/paths'
import { encodeJson, FrameDecoder, PROTOCOL } from '../../src/host/protocol'
import { sessionBackendKind } from '../../src/main/backend'
import { HostBackend } from '../../src/main/host-backend'
import { makeHostDirs } from '../helpers/host'
import { waitFor } from '../helpers/wait'

// HostBackend against fake hosts, for what a real host rarely does.

let tmp: string
let dataDir: string
let key: Buffer
let server: net.Server | null

beforeEach(async () => {
  ;({ tmp, dataDir } = await makeHostDirs())
  await mkdir(dataDir, { recursive: true })
  key = writeHostKey(dataDir)
  server = null
})
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r))
  await rm(tmp, { recursive: true, force: true })
})

type Msg = { t: string; id: number; [k: string]: unknown }

interface Fake {
  conns(): number
  /** Every JSON message each connection sent, in order. */
  received: Msg[][]
}

/**
 * A fake host: answers hello (proving itself with `proof`: the real key, another key, or none), checks the app's
 * proof, then hands each request (and its connection number) to `onRequest`.
 */
async function fakeHost(
  onRequest: (msg: Msg, conn: number, s: net.Socket) => void,
  o: { proof?: 'right' | 'wrong' | 'none'; hello?: boolean } = {}
): Promise<Fake> {
  let conns = 0
  const received: Msg[][] = []
  server = net.createServer((s) => {
    const n = ++conns
    const got: Msg[] = []
    received.push(got)
    const d = new FrameDecoder()
    let nonce = ''
    s.on('error', () => {})
    s.on('data', (c: Buffer) => {
      for (const f of d.push(c)) {
        if (f.type !== 'json') continue
        const msg = f.msg as Msg
        got.push(msg)
        if (msg.t === 'hello') {
          if (o.hello === false) continue
          nonce = newNonce()
          const proof = o.proof === 'none' ? undefined
            : proofFor(o.proof === 'wrong' ? randomBytes(32) : key, 'host', msg.nonce as string)
          s.write(encodeJson({ t: 'hello', protocol: PROTOCOL, appVersion: 'fake', pid: 4242, nonce, proof }))
        } else if (msg.t === 'auth') {
          if (checkProof(key, 'app', nonce, msg.proof)) s.write(encodeJson({ t: 'ready' }))
          else s.destroy()
        } else {
          onRequest(msg, n, s)
        }
      }
    })
  })
  await new Promise<void>((r) => server!.listen(hostSocketPath(dataDir), r))
  return { conns: () => conns, received }
}

const backend = (o: Partial<ConstructorParameters<typeof HostBackend>[0]> = {}): HostBackend =>
  new HostBackend({ dataDir, appVersion: 'test', launch: null, ...o })

test("a request the host leaves unanswered when it says goodbye is sent to the next host", async () => {
  const fake = await fakeHost((msg, n, s) => {
    if (n === 1) {
      s.end(encodeJson({ t: 'bye', reason: 'idle' })) // going away: never ran it
      return
    }
    s.write(encodeJson({ t: 'res', id: msg.id, ok: true, value: ['pw-next'] }))
  })
  const b = backend()
  expect(await b.listSessions()).toEqual(['pw-next'])
  expect(fake.conns()).toBe(2)
  b.disconnect()
})

test("a host that doesn't answer: the call fails and says so, and the next call connects afresh", async () => {
  const fake = await fakeHost(() => {})
  const b = backend({ requestTimeoutMs: 300 })
  await expect(b.hasSession('pw-a')).rejects.toThrow("The Pitwall host (pid 4242) didn't answer within 300 ms.")
  await expect(b.hasSession('pw-a')).rejects.toThrow(/didn't answer/)
  expect(fake.conns()).toBe(2)
  b.disconnect()
})

test('an error from the host reaches the caller with its message', async () => {
  await fakeHost((msg, _n, s) => s.write(encodeJson({ t: 'res', id: msg.id, ok: false, code: 'exists', error: 'duplicate session: pw-a' })))
  const b = backend()
  await expect(b.newSession({ name: 'pw-a', cwd: tmp, argv: ['true'] })).rejects.toThrow('duplicate session: pw-a')
  b.disconnect()
})

test.each([
  ['a wrong proof', { proof: 'wrong' as const }, () => {}, "its proof doesn't match the host key"],
  ['no proof', { proof: 'none' as const }, () => {}, "its proof doesn't match the host key"],
  ['no host key', {}, () => rmSync(hostKeyFile(dataDir)), 'there is no host key at'],
  ['a host key others can read', {}, () => chmodSync(hostKeyFile(dataDir), 0o644), 'can be read by other users']
])('an impostor (%s) is refused, and is sent nothing but hello', async (_what, o, arrange, why) => {
  const fake = await fakeHost(() => {}, o)
  arrange()
  const b = backend({ launch: { file: process.execPath, args: ['-e', ''], env: {} } })
  const refusal = `Something answering as Pitwall's background host at ${hostSocketPath(dataDir)} (pid 4242) couldn't prove it is one (`
  for (const call of [() => b.listSessions(), () => b.newSession({ name: 'pw-secret', cwd: tmp, argv: ['claude'], env: { GH_TOKEN: 'x' } })]) {
    const e = await call().then(() => null, (err: Error) => err)
    expect(e?.message).toContain(refusal)
    expect(e?.message).toContain(why)
    expect(e?.message).toContain('so Pitwall sent it nothing and won\'t use it')
  }
  await waitFor(async () => fake.received.length >= 1, 2000, 'connection')
  for (const conn of fake.received) expect(conn.map((m) => m.t)).toEqual(['hello'])
  expect(JSON.stringify(fake.received)).not.toContain('pw-secret')
})

test('PITWALL_SESSION_BACKEND=host picks the host; anything else stays on tmux', () => {
  expect(sessionBackendKind({ PITWALL_SESSION_BACKEND: 'host' })).toBe('host')
  expect(sessionBackendKind({})).toBe('tmux')
  expect(sessionBackendKind({ PITWALL_SESSION_BACKEND: 'tmux' })).toBe('tmux')
  expect(sessionBackendKind({ PITWALL_SESSION_BACKEND: 'Host' })).toBe('tmux')
})
