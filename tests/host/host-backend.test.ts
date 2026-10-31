import { randomBytes } from 'node:crypto'
import { chmodSync, rmSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import * as net from 'node:net'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { checkProof, newNonce, proofFor, writeHostKey } from '../../src/host/auth'
import { hostKeyFile, hostLogFile, hostSocketPath } from '../../src/host/paths'
import { DATA_CHUNK, encodeData, encodeJson, FrameDecoder, PROTOCOL } from '../../src/host/protocol'
import { sessionBackendKind } from '../../src/main/backend'
import { HostBackend, powershellText } from '../../src/main/host-backend'
import { makeHostDirs } from '../helpers/host'
import { WINDOWS } from '../helpers/processes'
import { waitFor } from '../helpers/wait'

// HostBackend against fake hosts, for what a real host rarely does.

let tmp: string
let dataDir: string
let key: Buffer
let server: net.Server | null
const sockets = new Set<net.Socket>()

/** Closes the fake host and the connections it accepted (a Windows pipe name stays taken while one is open). */
async function closeFake(): Promise<void> {
  for (const s of sockets) s.destroy()
  sockets.clear()
  if (server) await new Promise((r) => server!.close(r))
  server = null
}

beforeEach(async () => {
  ;({ tmp, dataDir } = await makeHostDirs())
  await mkdir(dataDir, { recursive: true })
  key = writeHostKey(dataDir)
  server = null
})
afterEach(async () => {
  await closeFake()
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
  o: {
    proof?: 'right' | 'wrong' | 'none'
    hello?: boolean
    /** Anything else (or other) in its hello: another protocol, an error, a hostile version… */
    helloFields?: Record<string, unknown>
    /** Says goodbye instead of greeting, or instead of `ready`. */
    byeOn?: 'hello' | 'auth'
    /** Answers the app's hello with these bytes instead of a hello. */
    reply?: Buffer
  } = {}
): Promise<Fake> {
  let conns = 0
  const received: Msg[][] = []
  server = net.createServer((s) => {
    sockets.add(s)
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
          if (o.reply) {
            s.write(o.reply)
            continue
          }
          if (o.hello === false) continue
          if (o.byeOn === 'hello') {
            s.write(encodeJson({ t: 'bye', reason: 'stopping' }))
            continue
          }
          nonce = newNonce()
          const proof = o.proof === 'none' ? undefined
            : proofFor(o.proof === 'wrong' ? randomBytes(32) : key, 'host', msg.nonce as string)
          s.write(encodeJson({ t: 'hello', protocol: PROTOCOL, appVersion: 'fake', pid: 4242, nonce, proof, ...o.helloFields }))
        } else if (msg.t === 'auth') {
          if (o.byeOn === 'auth') s.write(encodeJson({ t: 'bye', reason: 'stopping' }))
          else if (checkProof(key, 'app', nonce, msg.proof)) s.write(encodeJson({ t: 'ready' }))
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

test('a host that keeps going away is reported in words, with where to look', async () => {
  await fakeHost((_msg, _n, s) => { s.end(encodeJson({ t: 'bye', reason: 'crash' })) })
  const b = backend()
  await expect(b.listSessions()).rejects.toThrow(`Pitwall's background process keeps stopping — see ${hostLogFile(dataDir)}.`)
})

test("a host that doesn't answer: the call fails and says so, and the next call connects afresh", async () => {
  const fake = await fakeHost(() => {})
  const b = backend({ requestTimeoutMs: 300 })
  await expect(b.hasSession('pw-a')).rejects.toThrow("The Pitwall host (pid 4242) didn't answer within 300 ms.")
  await expect(b.hasSession('pw-a')).rejects.toThrow(/didn't answer/)
  expect(fake.conns()).toBe(2)
  b.disconnect()
})

test("a host that never completes the hello fails at once for a while (many sessions don't each wait on it)", async () => {
  const fake = await fakeHost(() => {}, { hello: false })
  const b = backend({ connectTimeoutMs: 200, failureCacheMs: 1000 })
  await expect(b.hasSession('pw-a')).rejects.toThrow("The Pitwall host isn't answering")
  const t0 = Date.now()
  for (const name of ['pw-b', 'pw-c', 'pw-d']) await expect(b.hasSession(name)).rejects.toThrow("isn't answering")
  expect(Date.now() - t0).toBeLessThan(100)
  expect(fake.conns()).toBe(1)
  await new Promise((r) => setTimeout(r, 1100))
  await expect(b.hasSession('pw-e')).rejects.toThrow("isn't answering")
  expect(fake.conns()).toBe(2)
})

test('an error from the host reaches the caller with its message', async () => {
  await fakeHost((msg, _n, s) => s.write(encodeJson({ t: 'res', id: msg.id, ok: false, code: 'exists', error: 'duplicate session: pw-a' })))
  const b = backend()
  await expect(b.newSession({ name: 'pw-a', cwd: tmp, argv: ['true'] })).rejects.toThrow('duplicate session: pw-a')
  b.disconnect()
})

// What an impostor says about itself: an escape sequence that would set the clipboard and paint the terminal, and a
// pid it would like the user to kill.
const HOSTILE = { pid: 31337, appVersion: '\x1b]52;c;ZXZpbA==\x07\x1b[2J evil 1.0' }

type Impostor = [what: string, o: Parameters<typeof fakeHost>[1], arrange: () => void, why: string]
const IMPOSTORS: Impostor[] = [
  ['a wrong proof', { proof: 'wrong' as const, helloFields: HOSTILE }, () => {}, "couldn't prove it is one (its proof doesn't match the host key)"],
  ['no proof', { proof: 'none' as const, helloFields: HOSTILE }, () => {}, "couldn't prove it is one (its proof doesn't match the host key)"],
  ['no host key', { helloFields: HOSTILE }, () => rmSync(hostKeyFile(dataDir)), "couldn't prove it is one (there is no host key at"],
  ['a host key others can read', { helloFields: HOSTILE }, () => chmodSync(hostKeyFile(dataDir), 0o644), 'can be read by other users'],
  ['an error, unproven', { proof: 'none' as const, helloFields: { ...HOSTILE, error: 'kill 31337 \x1b[31mNOW-PLEASE' } }, () => {}, "couldn't prove it is one"],
  ['another protocol, unproven, with escapes in its version', { proof: 'none' as const, helloFields: { ...HOSTILE, protocol: PROTOCOL + 1, error: 'OUTDATED-HOST' } }, () => {},
    `doesn't speak this version of Pitwall (or isn't Pitwall). Quit other Pitwall versions, or restart your ${WINDOWS ? 'PC' : 'Mac'}.`],
  ['another protocol, with a wrong proof', { proof: 'wrong' as const, helloFields: { ...HOSTILE, protocol: PROTOCOL + 1 } }, () => {}, "doesn't speak this version of Pitwall"],
  // Anything it sends that isn't a hello: never quoted back (a message type, a JSON snippet, a field, a size).
  ['an unknown message', { reply: encodeJson({ t: 'Visit evil.example' }) }, () => {}, "sent something Pitwall doesn't understand"],
  ['a frame that is not JSON', { reply: rawFrame(1, 'Visit evil.example {') }, () => {}, "sent something Pitwall doesn't understand"],
  ['a hello with a bad field', { reply: encodeJson({ t: 'hello', protocol: PROTOCOL, appVersion: '1', pid: 'Visit evil.example' }) }, () => {},
    "sent something Pitwall doesn't understand"],
  ['an answer before hello', { reply: encodeJson({ t: 'res', id: 1, ok: false, code: 'evil', error: 'Visit evil.example' }) }, () => {},
    "sent something Pitwall doesn't understand"],
  ['output before hello', { reply: encodeData(1, Buffer.from('Visit evil.example')) }, () => {}, "sent something Pitwall doesn't understand"],
  ['an oversize frame', { reply: rawFrame(1, 'x', 0x7fffffff) }, () => {}, "sent something Pitwall doesn't understand"],
  ['an unknown frame type', { reply: rawFrame(9, 'Visit evil.example') }, () => {}, "sent something Pitwall doesn't understand"]
]

/** A frame as written on the wire: length (of type + body, or `length`), type, body. */
function rawFrame(type: number, body: string, length?: number): Buffer {
  const b = Buffer.from(body)
  const h = Buffer.alloc(5)
  h.writeUInt32BE(length ?? b.length + 1)
  h[4] = type
  return Buffer.concat([h, b])
}

// (A key's POSIX mode means nothing on Windows: the AppData ACL protects it there, and its mode isn't checked.)
test.each(IMPOSTORS.filter(([what]) => !(WINDOWS && what === 'a host key others can read')))('an impostor (%s) is refused without repeating a word it said, and is sent nothing but hello', async (_what, o, arrange, why) => {
  const fake = await fakeHost(() => {}, o)
  arrange()
  const b = backend({ launch: { file: process.execPath, args: ['-e', ''], env: {} } })
  for (const call of [() => b.listSessions(), () => b.newSession({ name: 'pw-secret', cwd: tmp, argv: ['claude'], env: { GH_TOKEN: 'x' } })]) {
    const e = await call().then(() => null, (err: Error) => err)
    expect(e?.message).toContain(hostSocketPath(dataDir))
    expect(e?.message).toContain(why)
    expect(e?.message).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/) // no escape sequences, no BEL
    for (const said of ['31337', 'evil', 'ZXZpbA', 'NOW-PLEASE', 'OUTDATED-HOST']) expect(e?.message).not.toContain(said)
  }
  await waitFor(async () => fake.received.length >= 1, 2000, 'connection')
  for (const conn of fake.received) expect(conn.map((m) => m.t)).toEqual(['hello'])
  expect(JSON.stringify(fake.received)).not.toContain('pw-secret')
})

test('a proven host of another version is named, with its version cleaned of anything but a version', async () => {
  await fakeHost(() => {}, { helloFields: { protocol: PROTOCOL + 1, appVersion: '9.1.0', error: 'old' } })
  await expect(backend().listSessions()).rejects.toThrow(
    `Pitwall's background host (pid 4242, from Pitwall 9.1.0) speaks protocol ${PROTOCOL + 1}; this Pitwall speaks protocol ${PROTOCOL}`
  )
  await closeFake()
  await fakeHost(() => {}, { helloFields: { protocol: PROTOCOL + 1, appVersion: HOSTILE.appVersion } })
  const e = await backend().listSessions().then(() => null, (err: Error) => err)
  expect(e?.message).toContain('(pid 4242, from Pitwall unknown)')
  expect(e?.message).not.toMatch(/[\x00-\x1f]/)
})

test("a proven host's refusal is reported plainly, without its words", async () => {
  await fakeHost(() => {}, { helloFields: { error: 'go away \x1b[31m' } })
  const e = await backend().listSessions().then(() => null, (err: Error) => err)
  expect(e?.message).toBe(`The Pitwall host refused this app. See ${hostLogFile(dataDir)}.`)
})

test.each(['hello', 'auth'] as const)('a host saying goodbye during the handshake (on %s) is no host: nothing cached, a new one may start', async (on) => {
  const fake = await fakeHost(() => {}, { byeOn: on })
  const b = backend()
  expect(await b.listSessions()).toEqual([])
  expect(await b.hasSession('pw-a')).toBe(false)
  expect(fake.conns()).toBe(2) // asked again: not a cached failure
})

test('a character split between two data frames arrives whole', async () => {
  const text = 'a'.repeat(DATA_CHUNK - 1) + '❯b' // ❯ is 3 bytes: 2 end the first frame, 1 starts the next
  const bytes = Buffer.from(text, 'utf8')
  await fakeHost((msg, _n, s) => {
    if (msg.t !== 'attach') return
    s.write(encodeJson({ t: 'res', id: msg.id, ok: true }))
    s.write(encodeData(msg.ch as number, bytes.subarray(0, DATA_CHUNK + 1)))
    s.write(encodeData(msg.ch as number, bytes.subarray(DATA_CHUNK + 1)))
  })
  let out = ''
  const b = backend()
  const a = await b.attach('pw-u', 80, 24, { onData: (d) => { out += d }, onExit: () => {} })
  await waitFor(async () => out.length >= text.length, 2000, 'all output')
  expect(out).toBe(text)
  a.close()
  b.disconnect()
})

// macOS's choice; Windows always uses the host (windows-platform.test.ts).
test.skipIf(WINDOWS)('PITWALL_SESSION_BACKEND=host picks the host; anything else stays on tmux', () => {
  expect(sessionBackendKind({ PITWALL_SESSION_BACKEND: 'host' })).toBe('host')
  expect(sessionBackendKind({})).toBe('tmux')
  expect(sessionBackendKind({ PITWALL_SESSION_BACKEND: 'tmux' })).toBe('tmux')
  expect(sessionBackendKind({ PITWALL_SESSION_BACKEND: 'Host' })).toBe('tmux')
})

test("PowerShell's CLIXML stderr reads as its error lines (as Windows PowerShell 5.1 wrote it for a failed Start-Process)", () => {
  // Captured on Windows 11 from `powershell -NoProfile -NonInteractive [-OutputFormat Text] -EncodedCommand …`, stderr piped.
  const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0">' +
    '<TN RefId="0"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN><MS><I64 N="SourceId">1</I64>' +
    '<PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR>' +
    '<SD> </SD></PR></MS></Obj><S S="Error">Start-Process : This command cannot be run due to the error: The system cannot ' +
    'find the file specified._x000D__x000A_</S><S S="Error">At line:1 char:6_x000D__x000A_</S><S S="Error">+ $p = ' +
    "Start-Process -FilePath 'C:\\nope\\missing.exe' -PassThru -WindowS ..._x000D__x000A_</S><S S=\"Error\">    + " +
    'FullyQualifiedErrorId : InvalidOperationException,Microsoft.PowerShell.Commands.StartProcessCommand_x000D__x000A_</S>' +
    '<S S="Error">&lt;a &amp; b&gt; _x005F_x_x000D__x000A_</S></Objs>'
  expect(powershellText(clixml).split('\r\n')).toEqual([
    'Start-Process : This command cannot be run due to the error: The system cannot find the file specified.',
    'At line:1 char:6',
    "+ $p = Start-Process -FilePath 'C:\\nope\\missing.exe' -PassThru -WindowS ...",
    '    + FullyQualifiedErrorId : InvalidOperationException,Microsoft.PowerShell.Commands.StartProcessCommand',
    '<a & b> _x',
    ''
  ])
  expect(powershellText('Start-Process : plain text\r\n')).toBe('Start-Process : plain text\r\n')
})
