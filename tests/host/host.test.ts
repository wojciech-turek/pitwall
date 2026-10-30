import { execFile, spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, rm, utimes } from 'node:fs/promises'
import * as net from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { hostKeyFile, hostLogFile, hostPidFile, hostSocketPath } from '../../src/host/paths'
import { encodeJson, PROTOCOL } from '../../src/host/protocol'
import type { Attachment } from '../../src/main/backend'
import { HostBackend } from '../../src/main/host-backend'
import { alive, hostLaunch, hostPids, makeHostBackend, makeHostDirs, rawClient, stopHost } from '../helpers/host'
import { waitFor } from '../helpers/wait'

const run = promisify(execFile)

// A stand-in agent: says it's ready, answers each line, and on `burst` writes 50 MB as fast as the terminal takes it.
const AGENT = `
console.log('AGENT READY')
require('node:readline').createInterface({ input: process.stdin }).on('line', (l) => {
  if (l !== 'burst') return console.log('agent: ' + l)
  const chunk = ('x'.repeat(99) + '\\n').repeat(1000)
  let left = 500
  const write = () => {
    while (left > 0) {
      left--
      if (!process.stdout.write(chunk)) return process.stdout.once('drain', write)
    }
    console.log('BURST DONE')
  }
  write()
})
setInterval(() => {}, 60000)
`

let tmp: string
let dataDir: string
let backends: HostBackend[]
let attachments: Attachment[]
let cwd: string

beforeEach(async () => {
  ;({ tmp, dataDir } = await makeHostDirs())
  cwd = join(tmp, 'work dir')
  await mkdir(cwd, { recursive: true })
  backends = []
  attachments = []
})
afterEach(async () => {
  for (const a of attachments) a.close()
  for (const b of backends) b.disconnect()
  await stopHost(dataDir)
  await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

/** A backend as one app instance has it. */
function app(o: { idleMs?: number; start?: boolean } = {}): HostBackend {
  const b = makeHostBackend(dataDir, o)
  backends.push(b)
  return b
}

async function startAgent(b: HostBackend, name: string): Promise<void> {
  await b.newSession({ name, cwd, argv: [process.execPath, '-e', AGENT] })
  await waitFor(async () => (await b.capture(name)).includes('AGENT READY'), 8000, `${name} ready`)
}

async function attach(b: HostBackend, name: string): Promise<{ a: Attachment; out: () => string; exits: number[] }> {
  let out = ''
  const exits: number[] = []
  const a = await b.attach(name, 100, 30, { onData: (d) => { out += d }, onExit: (c) => { exits.push(c) } })
  attachments.push(a)
  return { a, out: () => out, exits }
}

const pidFromFile = async (): Promise<number> => Number((await readFile(hostPidFile(dataDir), 'utf8')).trim())

describe('agents outlive the app', () => {
  test('the app quits: the agent keeps running; a new app reattaches and sees its recent output replayed', async () => {
    const first = app()
    await startAgent(first, 'pw-a')
    const t1 = await attach(first, 'pw-a')
    t1.a.write('before quit\r')
    await waitFor(async () => t1.out().includes('agent: before quit'), 8000, 'echo')
    const hostPid = first.hostPid!
    const [agentPid] = (await first.processRoots('pw-a')).panePids

    first.disconnect() // the app quits (no goodbye: its attachments just vanish)
    await new Promise((r) => setTimeout(r, 300))
    expect(alive(hostPid)).toBe(true)
    expect(alive(agentPid)).toBe(true)

    const second = app()
    await second.sendKeys('pw-a', ['while away', 'Enter']) // output nobody is watching
    await waitFor(async () => (await second.capture('pw-a')).includes('agent: while away'), 8000, 'output while away')
    expect(second.hostPid).toBe(hostPid)
    const t2 = await attach(second, 'pw-a')
    await waitFor(async () => t2.out().includes('agent: while away'), 8000, 'replay')
    expect(t2.out().startsWith('\x1bc')).toBe(true) // a reset first, so a terminal that showed it before isn't doubled
    expect(t2.out()).toContain('AGENT READY')
    expect(t2.out()).toContain('agent: before quit')
    t2.a.write('after reopen\r')
    await waitFor(async () => t2.out().includes('agent: after reopen'), 8000, 'typing after reattach')
    expect(await hostPids(dataDir)).toEqual([hostPid])
  })

  test('the app crashes while attached: the host notices the dead connection and carries on', async () => {
    const b = app()
    await startAgent(b, 'pw-c')
    // Another process speaking the protocol (with the handshake), killed while attached.
    const crashy = spawn(process.execPath, ['-e', `
      const crypto = require('node:crypto')
      const key = Buffer.from(require('node:fs').readFileSync(${JSON.stringify(join(dataDir, 'host.key'))}, 'utf8'), 'hex')
      const proof = (role, nonce) => crypto.createHmac('sha256', key).update('pitwall-host-v1:' + role + ':' + nonce).digest('hex')
      const frame = (m) => { const b = Buffer.from(JSON.stringify(m)); const h = Buffer.alloc(5); h.writeUInt32BE(b.length + 1); h[4] = 1; return Buffer.concat([h, b]) }
      const s = require('node:net').connect(${JSON.stringify(hostSocketPath(dataDir))})
      s.on('connect', () => s.write(frame({ t: 'hello', protocol: ${PROTOCOL}, appVersion: 'crashy', nonce: crypto.randomBytes(32).toString('hex') })))
      let buf = Buffer.alloc(0)
      s.on('data', (d) => {
        buf = Buffer.concat([buf, d])
        while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
          const len = buf.readUInt32BE(0), type = buf[4], body = buf.subarray(5, 4 + len)
          buf = buf.subarray(4 + len)
          if (type === 2) { if (body.includes('AGENT READY')) console.log('attached'); continue }
          const m = JSON.parse(body)
          if (m.t === 'hello') s.write(frame({ t: 'auth', proof: proof('app', m.nonce) }))
          if (m.t === 'ready') s.write(frame({ t: 'attach', id: 1, name: 'pw-c', ch: 1, cols: 80, rows: 24 }))
        }
      })
      setInterval(() => {}, 60000)
    `], { stdio: ['ignore', 'pipe', 'ignore'] })
    try {
      await new Promise<void>((resolve) => crashy.stdout.on('data', (d: Buffer) => { if (d.includes('attached')) resolve() }))
    } finally {
      crashy.kill('SIGKILL')
    }
    await new Promise((r) => crashy.once('exit', r))
    await b.sendKeys('pw-c', ['still here', 'Enter'])
    await waitFor(async () => (await b.capture('pw-c')).includes('agent: still here'), 8000, 'agent alive after the crash')
  })
})

describe('lifecycle', () => {
  test('two apps starting a host at once share one', async () => {
    const apps = [app(), app(), app(), app()]
    await Promise.all(apps.map((b, i) => b.newSession({ name: `pw-${i}`, cwd, argv: [process.execPath, '-e', AGENT] })))
    const pid = await pidFromFile()
    expect(apps.map((b) => b.hostPid)).toEqual([pid, pid, pid, pid])
    for (const b of apps) expect((await b.listSessions()).sort()).toEqual(['pw-0', 'pw-1', 'pw-2', 'pw-3'])
    await waitFor(async () => (await hostPids(dataDir)).length === 1, 8000, 'the hosts that lost exit')
    expect(await hostPids(dataDir)).toEqual([pid])
  })

  test('separate data dirs (dev and packaged) never share a host', async () => {
    const otherDir = join(tmp, 'data dir-dev')
    const other = makeHostBackend(otherDir)
    backends.push(other)
    try {
      const b = app()
      await startAgent(b, 'pw-same')
      await startAgent(other, 'pw-same') // same name, other host: no clash
      expect(other.hostPid).not.toBe(b.hostPid)
      expect(await hostPids(dataDir)).toEqual([b.hostPid])
      expect(await hostPids(otherDir)).toEqual([other.hostPid])
      await b.killSession('pw-same')
      expect(await other.hasSession('pw-same')).toBe(true)
    } finally {
      await stopHost(otherDir)
    }
  })

  test('nothing but newSession starts a host: with none running there are no sessions', async () => {
    const b = app()
    expect(await b.listSessions()).toEqual([])
    expect(await b.hasSession('pw-x')).toBe(false)
    expect(await b.processRoots('pw-x')).toEqual({ serverPid: null, panePids: [] })
    await b.killSession('pw-x')
    await expect(b.capture('pw-x')).rejects.toThrow('no such session')
    const exits: number[] = []
    await b.attach('pw-x', 80, 24, { onData: () => {}, onExit: (c) => { exits.push(c) } })
    await waitFor(async () => exits.length === 1, 2000, 'attachment ends at once')
    await b.shutdown()
    expect(existsSync(hostPidFile(dataDir))).toBe(false)
    expect(await hostPids(dataDir)).toEqual([])
  })

  test('pidfile, log and an owner-only socket in the data dir', async () => {
    const b = app()
    await startAgent(b, 'pw-f')
    expect(await pidFromFile()).toBe(b.hostPid)
    expect(statSync(hostSocketPath(dataDir)).mode & 0o777).toBe(0o600)
    expect(statSync(hostKeyFile(dataDir)).mode & 0o777).toBe(0o600)
    expect(hostSocketPath(dataDir)).toBe(join(dataDir, 'host.sock'))
    const log = await readFile(hostLogFile(dataDir), 'utf8')
    expect(log).toContain('listening')
    expect(log).toContain('started pw-f')
  })

  test('a host that died leaves a socket, a pidfile and maybe a lock: the next one cleans up and starts', async () => {
    const b = app()
    await startAgent(b, 'pw-old')
    const oldPid = b.hostPid!
    process.kill(oldPid, 'SIGKILL')
    await waitFor(async () => !alive(oldPid), 8000, 'old host gone')
    expect(existsSync(hostSocketPath(dataDir))).toBe(true) // nobody removed it
    expect(await pidFromFile()).toBe(oldPid)
    const lock = `${hostSocketPath(dataDir)}.lock`
    await mkdir(lock)
    await utimes(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000)) // its owner died long ago

    expect(await b.hasSession('pw-old')).toBe(false) // the session died with its host
    await startAgent(b, 'pw-new')
    expect(b.hostPid).not.toBe(oldPid)
    expect(await pidFromFile()).toBe(b.hostPid)
    expect(existsSync(lock)).toBe(false)
  })

  test('with no terminals for the idle time the host exits and cleans up; the app starts a new one when needed', async () => {
    const b = app({ idleMs: 500 })
    await b.newSession({ name: 'pw-short', cwd, argv: [process.execPath, '-e', 'setTimeout(() => {}, 300)'] })
    const pid = b.hostPid!
    await waitFor(async () => !(await b.hasSession('pw-short')), 8000, 'short session ended')
    await waitFor(async () => !alive(pid), 8000, 'idle host exits')
    expect(existsSync(hostSocketPath(dataDir))).toBe(false)
    expect(existsSync(hostPidFile(dataDir))).toBe(false)
    expect(await readFile(hostLogFile(dataDir), 'utf8')).toMatch(/stopping: no terminals for/)
    expect(await b.listSessions()).toEqual([])
    await startAgent(b, 'pw-again')
    expect(b.hostPid).not.toBe(pid)
  })

  test('a running terminal keeps the host alive past the idle time', async () => {
    const b = app({ idleMs: 300 })
    await startAgent(b, 'pw-long')
    const pid = b.hostPid!
    await new Promise((r) => setTimeout(r, 1000))
    expect(alive(pid)).toBe(true)
    await b.killSession('pw-long')
    await waitFor(async () => !alive(pid), 8000, 'idle once the last terminal is gone')
  })

  test('killSession ends the whole foreground job, not just its first process', async () => {
    const b = app()
    const marker = join(tmp, 'child.pid')
    await b.newSession({ name: 'pw-job', cwd, argv: ['/bin/sh', '-c', `sleep 600 & echo $! > '${marker}'; wait`] })
    const child = Number((await waitFor(async () => (await readFile(marker, 'utf8').catch(() => '')).trim(), 8000, 'child pid')))
    await b.killSession('pw-job')
    await waitFor(async () => !alive(child), 8000, 'child gone')
  })
})

describe('the handshake', () => {
  test('the host serves only an app that proves it knows the host key', async () => {
    const b = app()
    await startAgent(b, 'pw-k')
    const early = await rawClient(dataDir, { handshake: false })
    early.s.write(encodeJson({ t: 'has', id: 1, name: 'pw-k' })) // no hello
    await waitFor(async () => early.closed(), 5000, 'request before hello refused')
    expect(early.frames).toEqual([])

    for (const after of ['skip auth', 'wrong proof'] as const) {
      const c = await rawClient(dataDir, { handshake: false })
      c.s.write(encodeJson({ t: 'hello', protocol: PROTOCOL, appVersion: 'x', nonce: 'a'.repeat(64) }))
      await waitFor(async () => c.frames.length === 1, 5000, 'host hello')
      expect(c.frames[0]).toMatchObject({ type: 'json', msg: { t: 'hello', proof: expect.stringMatching(/^[0-9a-f]{64}$/) } })
      if (after === 'skip auth') c.s.write(encodeJson({ t: 'list', id: 2 }))
      else c.s.write(encodeJson({ t: 'auth', proof: 'b'.repeat(64) }))
      await waitFor(async () => c.closed(), 5000, `${after}: refused`)
      expect(c.frames).toHaveLength(1) // nothing but the host's hello
    }
    expect(await readFile(hostLogFile(dataDir), 'utf8')).toContain("the app's proof doesn't match the host key")
    expect(await b.listSessions()).toEqual(['pw-k']) // and it carries on
  })

  test('a host started afresh writes a new key; apps follow it', async () => {
    const b = app()
    await startAgent(b, 'pw-1')
    const first = await readFile(hostKeyFile(dataDir), 'utf8')
    await b.shutdown()
    await startAgent(b, 'pw-2')
    expect(await readFile(hostKeyFile(dataDir), 'utf8')).not.toBe(first)
    expect(await app().listSessions()).toEqual(['pw-2'])
  })
})

describe('versions and bad clients', () => {
  test("the host refuses an app that speaks another protocol, and keeps running", async () => {
    const b = app()
    await startAgent(b, 'pw-v')
    const c = await rawClient(dataDir, { handshake: false })
    c.s.write(encodeJson({ t: 'hello', protocol: PROTOCOL + 1, appVersion: '9.0.0' }))
    await waitFor(async () => c.closed(), 5000, 'refused')
    expect(c.frames[0]).toMatchObject({ type: 'json', msg: { t: 'hello', protocol: PROTOCOL, error: expect.stringMatching(/protocol/) } })
    expect(await b.hasSession('pw-v')).toBe(true)
  })

  test("the app refuses a host it doesn't understand, and says so", async () => {
    await mkdir(dataDir, { recursive: true })
    const fake = net.createServer((s) => {
      s.on('data', () => s.write(encodeJson({ t: 'hello', protocol: PROTOCOL + 1, appVersion: '9.0.0', pid: 4242 })))
    })
    await new Promise<void>((r) => fake.listen(hostSocketPath(dataDir), r))
    try {
      const b = app()
      await expect(b.listSessions()).rejects.toThrow(
        `Pitwall's background host (pid 4242, from Pitwall 9.0.0) speaks protocol ${PROTOCOL + 1}; this Pitwall speaks protocol ${PROTOCOL}`
      )
      await expect(b.newSession({ name: 'pw-n', cwd, argv: ['true'] })).rejects.toThrow(/end that host \(pid 4242\)/)
    } finally {
      await new Promise((r) => fake.close(r))
    }
  })

  test('an oversize or garbled frame closes only that connection; a malformed request gets an error', async () => {
    const b = app()
    await startAgent(b, 'pw-g')
    const big = await rawClient(dataDir, { handshake: false })
    const header = Buffer.alloc(4)
    header.writeUInt32BE(64 * 1024 * 1024)
    big.s.write(header)
    await waitFor(async () => big.closed(), 5000, 'oversize frame closes the connection')
    const garbled = await rawClient(dataDir, { handshake: false })
    garbled.s.write(Buffer.from([0, 0, 0, 3, 1, 0x7b, 0x7b]))
    await waitFor(async () => garbled.closed(), 5000, 'garbled frame closes the connection')
    const bad = await rawClient(dataDir)
    bad.s.write(encodeJson({ t: 'new', id: 7, name: 'pw-z', cwd, argv: [] }))
    await waitFor(async () => bad.frames.length === 1, 5000, 'answer')
    expect(bad.frames[0]).toMatchObject({ type: 'json', msg: { t: 'res', id: 7, ok: false, code: 'bad-request' } })
    // A bad notice (no id to answer) is skipped; the connection and its terminals carry on.
    bad.s.write(encodeJson({ t: 'resize', ch: 1, cols: 0, rows: 24 }))
    bad.s.write(encodeJson({ t: 'has', id: 8, name: 'pw-g' }))
    await waitFor(async () => bad.frames.length === 2, 5000, 'answer after a bad notice')
    expect(bad.frames[1]).toMatchObject({ type: 'json', msg: { t: 'res', id: 8, ok: true, value: true } })
    expect(bad.closed()).toBe(false)
    bad.s.destroy()
    expect(await b.listSessions()).toEqual(['pw-g'])
  })
})

describe('output bursts', () => {
  test('a stuck app never blocks an agent or grows the host; it is resynced once it reads again', { timeout: 60_000 }, async () => {
    const b = app()
    await startAgent(b, 'pw-burst')
    await startAgent(b, 'pw-calm')
    const stuck = await rawClient(dataDir)
    const got = (): Buffer => Buffer.concat(stuck.frames.flatMap((f) => (f.type === 'data' ? [f.data] : [])))
    stuck.s.write(encodeJson({ t: 'attach', id: 1, name: 'pw-burst', ch: 1, cols: 100, rows: 30 }))
    await waitFor(async () => got().includes('AGENT READY'), 5000, 'stuck app attached')
    stuck.s.pause() // and never reads again (until later)

    const hostPid = b.hostPid!
    const t0 = Date.now()
    await b.sendKeys('pw-burst', ['burst', 'Enter'])
    let peakKb = 0
    await waitFor(async () => {
      const { stdout } = await run('/bin/ps', ['-o', 'rss=', '-p', String(hostPid)])
      peakKb = Math.max(peakKb, Number(stdout.trim()))
      return (await b.capture('pw-burst')).includes('BURST DONE')
    }, 45_000, '50 MB written while an app is stuck')
    // Another agent stays responsive meanwhile (checked after: the burst may already be over).
    await b.sendKeys('pw-calm', ['hi', 'Enter'])
    await waitFor(async () => (await b.capture('pw-calm')).includes('agent: hi'), 8000, 'calm agent answers')
    expect(peakKb).toBeLessThan(200 * 1024) // the host holds ~1 MB of output per terminal, not 50 MB
    console.log(`burst: ${Date.now() - t0} ms, host peak RSS ${Math.round(peakKb / 1024)} MB`)

    const before = got().length
    stuck.frames.length = 0
    stuck.s.resume()
    await waitFor(async () => got().includes('BURST DONE'), 15_000, 'the stuck app catches up')
    expect(got().includes('\x1bc')).toBe(true) // resynced from the recent output, not fed all 50 MB
    expect(before + got().length).toBeLessThan(20 * 1024 * 1024)
    stuck.s.destroy()
  })
})

describe('the launch the app uses', () => {
  test('sessions get the environment the host was started with, without ELECTRON_RUN_AS_NODE', async () => {
    const b = new HostBackend({
      dataDir, appVersion: 'test',
      launch: hostLaunch(dataDir, { env: { ELECTRON_RUN_AS_NODE: '1', PW_FROM_APP: 'yes' } })
    })
    backends.push(b)
    const out = join(tmp, 'env.json')
    await b.newSession({
      name: 'pw-env', cwd, env: { PW_SESSION: 'only here' },
      argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env)); setInterval(() => {}, 1e5)`]
    })
    const env = JSON.parse(await waitFor(async () => readFile(out, 'utf8').catch(() => ''), 8000, 'env')) as Record<string, string>
    expect(env.PW_FROM_APP).toBe('yes')
    expect(env.PW_SESSION).toBe('only here')
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(env.TERM).toBe('xterm-256color')
  })

  test('a host that fails to start is reported with where to look', async () => {
    const b = new HostBackend({
      dataDir, appVersion: 'test', launch: { file: process.execPath, args: ['-e', 'process.exit(3)'], env: {} }
    })
    await expect(b.newSession({ name: 'pw-x', cwd, argv: ['true'] })).rejects.toThrow(/exited with code 3.*host\.log/)
  })
})
