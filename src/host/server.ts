import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import * as net from 'node:net'
import * as pty from 'node-pty'
import { checkProof, newNonce, proofFor, writeHostKey } from './auth'
import { pasteBytes, sendKeysBytes } from './keys'
import { ModeTracker } from './modes'
import { hostLogFile, hostPidFile, hostSocketPath } from './paths'
import {
  encodeDataChunks, encodeJson, FrameDecoder, parseClientMessage, PROTOCOL,
  type ClientMessage, type ErrorCode, type Frame, type HostMessage, type ProcessRoots, type Request
} from './protocol'
import { replayBytes } from './replay'
import { RingBuffer } from './ring-buffer'
import { screenText } from './screen'

export interface HostOptions {
  dataDir: string
  appVersion: string
  /** With no terminals for this long, the host exits. */
  idleMs?: number
  /** Recent output kept per terminal, replayed on attach. */
  ringBytes?: number
  /**
   * A connection with more unsent output than this misses live output until it catches up; it then gets the recent
   * output again (a resync). So a slow or stuck app never blocks an agent or grows the host's memory.
   */
  highWaterBytes?: number
  /** Sessions' environment, before each session's own variables. */
  env?: Record<string, string>
  platform?: NodeJS.Platform
}

const DEFAULT_IDLE_MS = 10 * 60 * 1000
const DEFAULT_RING_BYTES = 1024 * 1024
const DEFAULT_HIGH_WATER = 4 * 1024 * 1024
const HELLO_TIMEOUT_MS = 10_000
/** How long a program sees the one-row-smaller size when nudged to redraw (see nudge). */
const NUDGE_MS = 60
const KILL_GRACE_MS = 3000
const LOCK_STALE_MS = 5000
const MAX_LOG_BYTES = 1024 * 1024
/** A new session's size until something attaches (as tmux's `new-session -x 200 -y 50`). */
const COLS = 200
const ROWS = 50

interface Term {
  name: string
  p: pty.IPty
  pid: number
  ring: RingBuffer
  modes: ModeTracker
  cols: number
  rows: number
  viewers: Set<Viewer>
}

/** One attachment: a channel on a connection showing a terminal. */
interface Viewer { conn: Conn; ch: number; term: Term; behind: boolean }

interface Conn {
  socket: net.Socket
  decoder: FrameDecoder
  /** new → (hello) → proving: we proved ourselves and wait for the app's proof → (auth) → ready. */
  state: 'new' | 'proving' | 'ready'
  /** Our nonce, for the app's proof. */
  nonce: string
  viewers: Map<number, Viewer>
  closed: boolean
}

class RequestError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Owns the agents' terminals so they outlive the app: one pty per session, recent output kept for replay, served to
 * the app over a local socket (see protocol.ts). One host per data dir; it exits after `idleMs` with no terminals.
 */
export class Host {
  readonly socketPath: string
  /** Resolves with the reason once the host has stopped. */
  readonly stopped: Promise<string>
  private resolveStopped!: (reason: string) => void
  private terms = new Map<string, Term>()
  private conns = new Set<Conn>()
  private dying = new Set<pty.IPty>()
  private server: net.Server | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private exiting = false
  private key: Buffer | null = null
  private readonly platform: NodeJS.Platform
  private readonly env: Record<string, string>
  private readonly idleMs: number
  private readonly ringBytes: number
  private readonly highWater: number

  constructor(private readonly o: HostOptions) {
    this.platform = o.platform ?? process.platform
    this.socketPath = hostSocketPath(o.dataDir, { platform: this.platform })
    this.env = o.env ?? {}
    this.idleMs = o.idleMs ?? DEFAULT_IDLE_MS
    this.ringBytes = o.ringBytes ?? DEFAULT_RING_BYTES
    this.highWater = o.highWaterBytes ?? DEFAULT_HIGH_WATER
    this.stopped = new Promise((r) => { this.resolveStopped = r })
  }

  /** Starts listening. False when another host already serves this data dir (this one then has nothing to do). */
  async start(): Promise<boolean> {
    mkdirSync(this.o.dataDir, { recursive: true })
    this.rotateLog()
    const server = net.createServer((s) => this.onConnection(s))
    if (!(await this.listen(server))) {
      this.log(`another host is already serving ${this.socketPath}; exiting`)
      return false
    }
    this.server = server
    server.on('error', (e) => this.log(`server error: ${e.message}`))
    // Before any connection is served (they're handled on later turns of the event loop).
    this.key = writeHostKey(this.o.dataDir)
    this.writePidFile()
    this.log(`host ${this.o.appVersion} (protocol ${PROTOCOL}) listening, pid ${process.pid}`)
    this.armIdle()
    return true
  }

  /** Ends every session and stops. Idempotent. */
  stop(reason: string): Promise<string> {
    if (this.exiting) return this.stopped
    this.exiting = true
    this.log(`stopping: ${reason}`)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    // The socket goes first: from now on an app starts a new host instead of reaching this one.
    this.server?.close()
    this.removePidFile()
    for (const name of [...this.terms.keys()]) this.kill(name) // attachments hear `exit` first
    for (const conn of this.conns) {
      this.send(conn, { t: 'bye', reason })
      conn.socket.end()
    }
    void (async () => {
      const deadline = Date.now() + KILL_GRACE_MS
      while (this.dying.size > 0 && Date.now() < deadline) await sleep(50)
      for (const conn of this.conns) conn.socket.destroy()
      this.resolveStopped(reason)
    })()
    return this.stopped
  }

  // ---- listening --------------------------------------------------------------

  /**
   * Binds the socket, or finds that a live host already has it. A socket file left by a host that died is removed,
   * under a lock so two hosts starting at once never remove each other's (only one of them binds).
   */
  private async listen(server: net.Server): Promise<boolean> {
    if (this.platform === 'win32') return (await this.tryListen(server)) === 'ok' // a pipe vanishes with its host
    const lock = `${this.socketPath}.lock`
    const deadline = Date.now() + 20_000
    for (;;) {
      if (this.takeLock(lock)) {
        try {
          if ((await this.tryListen(server)) === 'ok') return true
          if (await canConnect(this.socketPath)) return false
          rmSync(this.socketPath, { force: true }) // nobody answers: left by a host that died
          if ((await this.tryListen(server)) === 'ok') return true
          return false
        } finally {
          try { rmdirSync(lock) } catch { /* gone */ }
        }
      }
      if (Date.now() > deadline) throw new Error(`couldn't take ${lock}`)
      await sleep(25)
    }
  }

  private takeLock(lock: string): boolean {
    try {
      mkdirSync(lock)
      return true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmdirSync(lock) // its owner died while holding it
      } catch { /* just released */ }
      return false
    }
  }

  private tryListen(server: net.Server): Promise<'ok' | 'in-use'> {
    return new Promise((resolve, reject) => {
      const onError = (e: NodeJS.ErrnoException): void => {
        server.off('listening', onListening)
        if (e.code === 'EADDRINUSE') resolve('in-use')
        else reject(e)
      }
      const onListening = (): void => {
        server.off('error', onError)
        if (this.platform !== 'win32') chmodSync(this.socketPath, 0o600)
        resolve('ok')
      }
      server.once('error', onError)
      server.once('listening', onListening)
      // Owner-only from the moment it exists: the bind happens inside listen().
      const umask = this.platform !== 'win32' ? process.umask(0o177) : undefined
      try {
        server.listen(this.socketPath)
      } finally {
        if (umask !== undefined) process.umask(umask)
      }
    })
  }

  // ---- connections ------------------------------------------------------------

  private onConnection(socket: net.Socket): void {
    if (this.exiting) {
      socket.destroy()
      return
    }
    const conn: Conn = { socket, decoder: new FrameDecoder(), state: 'new', nonce: '', viewers: new Map(), closed: false }
    this.conns.add(conn)
    const helloTimer = setTimeout(() => { if (conn.state !== 'ready') this.drop(conn, 'no handshake') }, HELLO_TIMEOUT_MS)
    socket.on('data', (chunk: Buffer) => {
      let frames: Frame[]
      try {
        frames = conn.decoder.push(chunk)
      } catch (e) {
        this.drop(conn, `protocol error: ${(e as Error).message}`)
        return
      }
      for (const f of frames) {
        if (conn.closed) return
        try {
          this.onFrame(conn, f)
        } catch (e) {
          this.log(`error handling a message: ${(e as Error).stack ?? e}`)
        }
      }
    })
    socket.on('drain', () => this.onDrain(conn))
    socket.on('error', () => { /* 'close' follows */ })
    socket.on('close', () => {
      clearTimeout(helloTimer)
      this.closeConn(conn)
    })
  }

  private closeConn(conn: Conn): void {
    if (conn.closed) return
    conn.closed = true
    this.conns.delete(conn)
    for (const v of conn.viewers.values()) v.term.viewers.delete(v)
    conn.viewers.clear()
  }

  private drop(conn: Conn, why: string): void {
    this.log(`dropping a connection: ${why}`)
    conn.socket.destroy()
    this.closeConn(conn)
  }

  private send(conn: Conn, msg: HostMessage): void {
    if (!conn.closed && conn.socket.writable) conn.socket.write(encodeJson(msg))
  }

  private onFrame(conn: Conn, f: Frame): void {
    if (f.type === 'data') {
      if (conn.state !== 'ready') return this.drop(conn, 'data before the handshake')
      const v = conn.viewers.get(f.ch)
      if (v) this.input(v.term, f.data)
      return
    }
    let msg: ClientMessage
    try {
      msg = parseClientMessage(f.msg)
    } catch (e) {
      if (conn.state !== 'ready') return this.drop(conn, (e as Error).message)
      // One bad message must not end the connection's other terminals: answer it, or (a notice) skip it.
      const id = (f.msg as { id?: unknown }).id
      if (typeof id === 'number' && Number.isSafeInteger(id) && id >= 0) {
        this.send(conn, { t: 'res', id, ok: false, code: 'bad-request', error: (e as Error).message })
      } else {
        this.log(`ignored a bad message: ${(e as Error).message}`)
      }
      return
    }
    if (conn.state !== 'ready') return this.handshake(conn, msg)
    if (this.exiting) return // after bye: not run, so the app may send it to the next host
    switch (msg.t) {
      case 'hello': case 'auth': return
      case 'detach': {
        const v = conn.viewers.get(msg.ch)
        if (v) this.detach(v)
        return
      }
      case 'resize': {
        const v = conn.viewers.get(msg.ch)
        if (v) this.resize(v.term, msg.cols, msg.rows)
        return
      }
      default:
        this.request(conn, msg)
    }
  }

  /** Hello, then each side proves it knows the host key (see protocol.ts). Anything else ends the connection. */
  private handshake(conn: Conn, msg: ClientMessage): void {
    if (conn.state === 'new' && msg.t === 'hello') {
      if (msg.protocol !== PROTOCOL) {
        this.log(`refused Pitwall ${msg.appVersion}: it speaks protocol ${msg.protocol}`)
        this.send(conn, {
          t: 'hello', protocol: PROTOCOL, appVersion: this.o.appVersion, pid: process.pid,
          error: `this host speaks protocol ${PROTOCOL}, not ${msg.protocol}`
        })
        conn.socket.end()
        return
      }
      if (!msg.nonce || !this.key) return this.drop(conn, 'hello without a nonce')
      conn.state = 'proving'
      conn.nonce = newNonce()
      this.send(conn, {
        t: 'hello', protocol: PROTOCOL, appVersion: this.o.appVersion, pid: process.pid,
        nonce: conn.nonce, proof: proofFor(this.key, 'host', msg.nonce)
      })
      return
    }
    if (conn.state === 'proving' && msg.t === 'auth' && this.key && checkProof(this.key, 'app', conn.nonce, msg.proof)) {
      conn.state = 'ready'
      this.send(conn, { t: 'ready' })
      return
    }
    this.drop(conn, msg.t === 'auth' ? "the app's proof doesn't match the host key" : `${msg.t} before the handshake`)
  }

  private request(conn: Conn, msg: Request): void {
    if (msg.t === 'attach') return this.attach(conn, msg)
    let value: unknown
    try {
      value = this.handle(msg)
    } catch (e) {
      return this.fail(conn, msg.id, e)
    }
    this.send(conn, { t: 'res', id: msg.id, ok: true, value })
    if (msg.t === 'shutdown') void this.stop('shutdown requested')
  }

  private fail(conn: Conn, id: number, e: unknown): void {
    const code = e instanceof RequestError ? e.code : 'failed'
    if (code === 'failed') this.log(`request failed: ${(e as Error).stack ?? e}`)
    this.send(conn, { t: 'res', id, ok: false, code, error: (e as Error).message })
  }

  /**
   * The newest attachment's size wins (as with tmux's window-size latest). It gets the replay, then the program is
   * nudged to redraw if the size didn't change (a change makes it redraw anyway), so a full-screen program's screen
   * is right even when the replay can't rebuild it.
   */
  private attach(conn: Conn, m: Extract<Request, { t: 'attach' }>): void {
    const t = this.terms.get(m.name)
    if (!t) return this.fail(conn, m.id, new RequestError('no-session', `no such session: ${m.name}`))
    const old = conn.viewers.get(m.ch)
    if (old) this.detach(old)
    const v: Viewer = { conn, ch: m.ch, term: t, behind: false }
    conn.viewers.set(m.ch, v)
    t.viewers.add(v)
    const resized = this.resize(t, m.cols, m.rows)
    this.send(conn, { t: 'res', id: m.id, ok: true })
    this.replay(v)
    if (!resized) this.nudge(t)
  }

  /**
   * Makes the program redraw at its current size: one row fewer for a moment, then back. (A SIGWINCH alone isn't
   * enough: Node programs, Claude Code among them, only redraw when the size they read has changed. One row fewer,
   * not more, so nothing is drawn below the terminal.)
   */
  private nudge(t: Term): void {
    const rows = t.rows > 1 ? t.rows - 1 : t.rows + 1
    try {
      t.p.resize(t.cols, rows)
    } catch {
      return
    }
    setTimeout(() => {
      if (this.terms.get(t.name) !== t) return
      try { t.p.resize(t.cols, t.rows) } catch { /* exiting */ }
    }, NUDGE_MS)
  }

  private term(name: string): Term {
    const t = this.terms.get(name)
    if (!t) throw new RequestError('no-session', `no such session: ${name}`)
    return t
  }

  private handle(m: Exclude<Request, { t: 'attach' }>): unknown {
    switch (m.t) {
      case 'list': return [...this.terms.keys()]
      case 'has': return this.terms.has(m.name)
      case 'new': return this.spawn(m.name, m.cwd, m.argv, m.env)
      case 'kill': return this.kill(m.name)
      case 'capture': {
        const t = this.term(m.name)
        return screenText(t.ring.snapshot().toString('utf8'), t.cols, t.rows)
      }
      case 'send': {
        const t = this.term(m.name)
        return this.input(t, sendKeysBytes(m.keys, m.literal, t.modes.appCursorKeys))
      }
      case 'paste': {
        const t = this.term(m.name)
        return this.input(t, pasteBytes(m.text, t.modes.bracketedPaste))
      }
      case 'roots': {
        const t = this.terms.get(m.name)
        const roots: ProcessRoots = t ? { serverPid: process.pid, panePids: [t.pid] } : { serverPid: null, panePids: [] }
        return roots
      }
      case 'shutdown': return undefined
    }
  }

  // ---- terminals --------------------------------------------------------------

  private spawn(name: string, cwd: string, argv: string[], env: Record<string, string>): undefined {
    if (this.terms.has(name)) throw new RequestError('exists', `duplicate session: ${name}`)
    const p = pty.spawn(argv[0], argv.slice(1), {
      name: 'xterm-256color', cols: COLS, rows: ROWS, cwd, env: { ...this.env, ...env }
    })
    const t: Term = {
      name, p, pid: p.pid, ring: new RingBuffer(this.ringBytes), modes: new ModeTracker(), cols: COLS, rows: ROWS,
      viewers: new Set()
    }
    this.terms.set(name, t)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    p.onData((d) => this.output(t, Buffer.from(d, 'utf8')))
    p.onExit(({ exitCode }) => this.exited(t, exitCode))
    this.log(`started ${name} (pid ${p.pid})`)
    return undefined
  }

  private output(t: Term, b: Buffer): void {
    t.ring.push(b)
    t.modes.feed(b)
    for (const v of t.viewers) {
      if (v.behind || !v.conn.socket.writable) continue
      if (v.conn.socket.writableLength > this.highWater) {
        v.behind = true // resynced on drain
        continue
      }
      for (const frame of encodeDataChunks(v.ch, b)) v.conn.socket.write(frame)
    }
  }

  private replay(v: Viewer): void {
    if (v.conn.closed || !v.conn.socket.writable) return
    const bytes = replayBytes(v.term.ring.snapshot(), v.term.ring.dropped > 0, v.term.modes)
    for (const frame of encodeDataChunks(v.ch, bytes)) v.conn.socket.write(frame)
  }

  private onDrain(conn: Conn): void {
    for (const v of conn.viewers.values()) {
      if (!v.behind) continue
      v.behind = false
      this.replay(v)
    }
  }

  private input(t: Term, data: string | Buffer): undefined {
    try {
      t.p.write(data)
    } catch (e) {
      this.log(`write to ${t.name} failed: ${(e as Error).message}`)
    }
    return undefined
  }

  /** True if the size changed. */
  private resize(t: Term, cols: number, rows: number): boolean {
    if (t.cols === cols && t.rows === rows) return false
    try {
      t.p.resize(cols, rows)
      t.cols = cols
      t.rows = rows
      return true
    } catch {
      return false // exiting
    }
  }

  private detach(v: Viewer): void {
    v.conn.viewers.delete(v.ch)
    v.term.viewers.delete(v)
  }

  /** Ends the attachments; their apps show the session as ended. */
  private endViewers(t: Term, code: number): void {
    for (const v of t.viewers) {
      v.conn.viewers.delete(v.ch)
      this.send(v.conn, { t: 'exit', ch: v.ch, code })
    }
    t.viewers.clear()
  }

  private exited(t: Term, code: number): void {
    this.dying.delete(t.p)
    if (this.terms.get(t.name) !== t) return // killed: already gone
    this.terms.delete(t.name)
    this.log(`${t.name} exited (code ${code})`)
    this.endViewers(t, code)
    this.armIdle()
  }

  /** Like tmux's kill-session: the session is gone at once; its processes get SIGHUP (SIGKILL if they linger). */
  private kill(name: string): undefined {
    const t = this.terms.get(name)
    if (!t) return undefined
    this.terms.delete(name)
    this.log(`killing ${name}`)
    this.endViewers(t, 0)
    this.dying.add(t.p)
    this.signal(t, 'SIGHUP')
    setTimeout(() => { if (this.dying.has(t.p)) this.signal(t, 'SIGKILL') }, KILL_GRACE_MS).unref()
    this.armIdle()
    return undefined
  }

  private signal(t: Term, sig: NodeJS.Signals): void {
    if (this.platform === 'win32') {
      try { t.p.kill() } catch { /* gone */ }
      return
    }
    // The session leader's whole process group (the agent and whatever it runs in the foreground), then itself.
    try { process.kill(-t.pid, sig) } catch { /* gone */ }
    try { process.kill(t.pid, sig) } catch { /* gone */ }
  }

  private armIdle(): void {
    if (this.exiting || this.terms.size > 0 || this.idleTimer) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.terms.size === 0) void this.stop(`no terminals for ${this.idleMs >= 60_000 ? `${Math.round(this.idleMs / 60_000)} min` : `${this.idleMs / 1000}s`}`)
    }, this.idleMs)
  }

  // ---- files ------------------------------------------------------------------

  private writePidFile(): void {
    const file = hostPidFile(this.o.dataDir)
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, `${process.pid}\n`)
    renameSync(tmp, file)
  }

  /** Only our own: a newer host may have written its pid there already. */
  private removePidFile(): void {
    const file = hostPidFile(this.o.dataDir)
    try {
      if (readFileSync(file, 'utf8').trim() === String(process.pid)) rmSync(file, { force: true })
    } catch { /* none */ }
  }

  private rotateLog(): void {
    const file = hostLogFile(this.o.dataDir)
    try {
      if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`)
    } catch { /* no log yet */ }
  }

  log(message: string): void {
    try {
      appendFileSync(hostLogFile(this.o.dataDir), `${new Date().toISOString()} [${process.pid}] ${message}\n`)
    } catch { /* logging must never take the host down */ }
  }
}

/** True if something accepts connections on `path` (a live host, even a busy one). */
export function canConnect(path: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(path)
    const done = (alive: boolean): void => {
      clearTimeout(timer)
      s.destroy()
      resolve(alive)
    }
    const timer = setTimeout(() => done(true), timeoutMs) // no answer yet isn't proof it's dead: leave it alone
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}
