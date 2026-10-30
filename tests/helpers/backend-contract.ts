import { mkdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { Attachment, AttachHandlers, SessionBackend } from '../../src/main/backend'
import { waitFor } from './wait'

export interface BackendFixture {
  backend: SessionBackend
  /** A scratch folder; cleanup removes it. */
  tmp: string
  /** Stops whatever the backend started and removes `tmp`. */
  cleanup(): Promise<void>
}

/**
 * What every SessionBackend must do, so callers (manager, archive, PtyBridge…) can't tell them apart.
 * `processRoots: false` for a backend that can't report pids (it must then return none).
 */
export function describeBackendContract(
  name: string, make: () => Promise<BackendFixture>, o: { processRoots?: boolean } = {}
): void {
  describe(`SessionBackend contract: ${name}`, () => {
    let f: BackendFixture
    let cwd: string
    let attachments: Attachment[]

    beforeEach(async () => {
      f = await make()
      attachments = []
      cwd = join(f.tmp, 'work dir') // paths with spaces cross every process boundary
      await mkdir(cwd, { recursive: true })
    })
    afterEach(async () => {
      for (const a of attachments) a.close()
      await f.cleanup()
    })

    /** Starts the test program; resolves once it's on screen. */
    async function start(s: string, env?: Record<string, string>): Promise<Report> {
      const report = join(cwd, `${s}.json`)
      await f.backend.newSession({ name: s, cwd, argv: [process.execPath, '-e', PROGRAM, report], ...(env ? { env } : {}) })
      await onScreen(s, 'ready')
      return JSON.parse(await readFile(report, 'utf8')) as Report
    }
    const onScreen = (s: string, text: string) =>
      waitFor(async () => (await f.backend.capture(s)).includes(text), 8000, `"${text}" on ${s}'s screen`)
    async function attach(s: string, cols: number, rows: number, h: Partial<AttachHandlers> = {}): Promise<Attachment> {
      const a = await f.backend.attach(s, cols, rows, { onData: h.onData ?? (() => {}), onExit: h.onExit ?? (() => {}) })
      attachments.push(a)
      return a
    }

    test('newSession runs argv (no shell) in cwd, with env added for that session only', async () => {
      const a = await start('pw-env', { PW_CONTRACT: 'a b=c' })
      expect(a.cwd).toBe(await realpath(cwd))
      expect(a.env).toBe('a b=c')
      expect(a.args).toEqual([join(cwd, 'pw-env.json')])
      expect((await start('pw-plain')).env).toBeNull()
    })

    test('hasSession and listSessions match exact names', async () => {
      expect(await f.backend.listSessions()).toEqual([])
      expect(await f.backend.hasSession('pw-x')).toBe(false)
      await start('pw-x-sh')
      expect(await f.backend.hasSession('pw-x')).toBe(false)
      await start('pw-x')
      expect(await f.backend.hasSession('pw-x')).toBe(true)
      expect((await f.backend.listSessions()).sort()).toEqual(['pw-x', 'pw-x-sh'])
      await f.backend.killSession('pw-x')
      expect(await f.backend.hasSession('pw-x-sh')).toBe(true)
    })

    test('sendKeys reaches the program: key names, and text when literal', async () => {
      await start('pw-k')
      await f.backend.sendKeys('pw-k', ['typed', 'Enter'])
      await onScreen('pw-k', 'got:typed')
      await f.backend.sendKeys('pw-k', ['Enter'], true)
      await f.backend.sendKeys('pw-k', ['Enter'])
      await onScreen('pw-k', 'got:Enter')
    })

    test('pasteText reaches the program and never presses Enter', async () => {
      await start('pw-p')
      await f.backend.pasteText('pw-p', 'hello @x')
      await onScreen('pw-p', 'hello @x')
      await new Promise((r) => setTimeout(r, 300))
      expect(await f.backend.capture('pw-p')).not.toContain('got:hello @x')
      await f.backend.sendKeys('pw-p', ['Enter'])
      await onScreen('pw-p', 'got:hello @x')
    })

    test('attach shows the screen, streams output, takes input and resizes; close only detaches', async () => {
      await start('pw-a')
      let out = ''
      const exits: number[] = []
      const a = await attach('pw-a', 80, 24, { onData: (d) => { out += d }, onExit: (c) => { exits.push(c) } })
      await waitFor(async () => out.includes('ready'), 8000, 'screen shown on attach')
      await onScreen('pw-a', 'size=80x24')
      a.write('héllo ❯\r')
      await waitFor(async () => out.includes('got:héllo ❯'), 8000, 'reply streamed to the attachment')
      a.resize(100, 40)
      await onScreen('pw-a', 'size=100x40')
      a.close()
      a.close() // idempotent
      await new Promise((r) => setTimeout(r, 500))
      expect(exits).toEqual([]) // no callbacks after close
      expect(await f.backend.hasSession('pw-a')).toBe(true)
    })

    test('a program that exits ends its session and its attachment', async () => {
      await start('pw-e')
      const exits: number[] = []
      await attach('pw-e', 80, 24, { onExit: (c) => { exits.push(c) } })
      await f.backend.sendKeys('pw-e', ['exit', 'Enter'])
      await waitFor(async () => !(await f.backend.hasSession('pw-e')), 8000, 'session ended')
      await waitFor(async () => exits.length === 1, 8000, 'attachment exit')
    })

    test('killSession ends the program and its attachment; a missing session is ignored', async () => {
      const r = await start('pw-d')
      const exits: number[] = []
      await attach('pw-d', 80, 24, { onExit: (c) => { exits.push(c) } })
      await f.backend.killSession('pw-d')
      expect(await f.backend.hasSession('pw-d')).toBe(false)
      await waitFor(async () => exits.length === 1, 8000, 'attachment exit')
      await waitFor(async () => !alive(r.pid), 8000, 'program gone')
      await f.backend.killSession('pw-d')
    })

    test('attaching to a missing session ends at once', async () => {
      const exits: number[] = []
      const attached = await attach('pw-none', 80, 24, { onExit: (c) => { exits.push(c) } }).then(() => true, () => false)
      if (attached) await waitFor(async () => exits.length === 1, 8000, 'attachment exit')
    })

    test('processRoots gives the program and its parent (for the leftover snapshot)', async () => {
      expect(await f.backend.processRoots('pw-none')).toEqual({ serverPid: null, panePids: [] })
      const r = await start('pw-r')
      expect(await f.backend.processRoots('pw-r')).toEqual(
        o.processRoots === false ? { serverPid: null, panePids: [] } : { serverPid: r.ppid, panePids: [r.pid] }
      )
    })

    test('shutdown ends every session', async () => {
      const a = await start('pw-s1')
      const b = await start('pw-s2')
      await f.backend.shutdown()
      expect(await f.backend.listSessions()).toEqual([])
      expect(await f.backend.hasSession('pw-s1')).toBe(false)
      await waitFor(async () => !alive(a.pid) && !alive(b.pid), 8000, 'programs gone')
    })
  })
}

interface Report { cwd: string; env: string | null; args: string[]; pid: number; ppid: number }

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Node rather than a shell, so it runs wherever the backend does. It reports how it started to the file in argv,
// prints its size (again on resize), answers each line with `got:<line>`, and exits on `exit`.
// (No argument may end in `;`: tmux would take it for a command separator.)
const PROGRAM = `
const fs = require('node:fs')
const report = { cwd: process.cwd(), env: process.env.PW_CONTRACT ?? null, args: process.argv.slice(1), pid: process.pid, ppid: process.ppid }
fs.writeFileSync(process.argv[1], JSON.stringify(report))
const size = () => console.log('size=' + process.stdout.columns + 'x' + process.stdout.rows)
process.stdout.on('resize', size)
console.log('ready')
size()
require('node:readline').createInterface({ input: process.stdin }).on('line', (l) => {
  if (l === 'exit') process.exit(3)
  console.log('got:' + l)
})
setInterval(() => {}, 60000)
`
