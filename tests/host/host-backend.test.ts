import { mkdir, rm } from 'node:fs/promises'
import * as net from 'node:net'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { hostSocketPath } from '../../src/host/paths'
import { encodeJson, FrameDecoder, PROTOCOL } from '../../src/host/protocol'
import { sessionBackendKind } from '../../src/main/backend'
import { HostBackend } from '../../src/main/host-backend'
import { makeHostDirs } from '../helpers/host'

// HostBackend against fake hosts, for what a real host rarely does.

let tmp: string
let dataDir: string
let server: net.Server | null

beforeEach(async () => {
  ;({ tmp, dataDir } = await makeHostDirs())
  await mkdir(dataDir, { recursive: true })
  server = null
})
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r))
  await rm(tmp, { recursive: true, force: true })
})

/** A fake host: answers hello, then hands each request (and its connection number) to `onRequest`. */
async function fakeHost(onRequest: (msg: { t: string; id: number }, conn: number, s: net.Socket) => void): Promise<() => number> {
  let conns = 0
  server = net.createServer((s) => {
    const n = ++conns
    const d = new FrameDecoder()
    s.on('error', () => {})
    s.on('data', (c: Buffer) => {
      for (const f of d.push(c)) {
        if (f.type !== 'json') continue
        const msg = f.msg as { t: string; id: number }
        if (msg.t === 'hello') s.write(encodeJson({ t: 'hello', protocol: PROTOCOL, appVersion: 'fake', pid: 4242 }))
        else onRequest(msg, n, s)
      }
    })
  })
  await new Promise<void>((r) => server!.listen(hostSocketPath(dataDir), r))
  return () => conns
}

test("a request the host leaves unanswered when it says goodbye is sent to the next host", async () => {
  const conns = await fakeHost((msg, n, s) => {
    if (n === 1) {
      s.end(encodeJson({ t: 'bye', reason: 'idle' })) // going away: never ran it
      return
    }
    s.write(encodeJson({ t: 'res', id: msg.id, ok: true, value: ['pw-next'] }))
  })
  const b = new HostBackend({ dataDir, appVersion: 'test', launch: null })
  expect(await b.listSessions()).toEqual(['pw-next'])
  expect(conns()).toBe(2)
  b.disconnect()
})

test("a host that doesn't answer: the call fails and says so, and the next call connects afresh", async () => {
  const conns = await fakeHost(() => {})
  const b = new HostBackend({ dataDir, appVersion: 'test', launch: null, requestTimeoutMs: 300 })
  await expect(b.hasSession('pw-a')).rejects.toThrow("The Pitwall host (pid 4242) didn't answer within 300 ms.")
  await expect(b.hasSession('pw-a')).rejects.toThrow(/didn't answer/)
  expect(conns()).toBe(2)
  b.disconnect()
})

test('an error from the host reaches the caller with its message', async () => {
  await fakeHost((msg, _n, s) => s.write(encodeJson({ t: 'res', id: msg.id, ok: false, code: 'exists', error: 'duplicate session: pw-a' })))
  const b = new HostBackend({ dataDir, appVersion: 'test', launch: null })
  await expect(b.newSession({ name: 'pw-a', cwd: tmp, argv: ['true'] })).rejects.toThrow('duplicate session: pw-a')
  b.disconnect()
})

test('PITWALL_SESSION_BACKEND=host picks the host; anything else stays on tmux', () => {
  expect(sessionBackendKind({ PITWALL_SESSION_BACKEND: 'host' })).toBe('host')
  expect(sessionBackendKind({})).toBe('tmux')
  expect(sessionBackendKind({ PITWALL_SESSION_BACKEND: 'tmux' })).toBe('tmux')
  expect(sessionBackendKind({ PITWALL_SESSION_BACKEND: 'Host' })).toBe('tmux')
})
