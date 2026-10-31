import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import * as net from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { checkProof, HostKeyError, newNonce, proofFor, readHostKey } from '../host/auth'
import { hostLogFile, hostSocketPath } from '../host/paths'
import {
  encodeDataChunks, encodeJson, FrameDecoder, MAX_TERM_SIZE, parseHostMessage, PROTOCOL, type ErrorCode, type Frame,
  type HostMessage, type ProcessRoots, type Request
} from '../host/protocol'
import { envValue, quoteWindowsArg } from '../host/win-command'
import type { Attachment, AttachHandlers, NewSessionOptions, SessionBackend } from './backend'
import { windowsPowerShell } from './platform'

/** How to start a host: the app's own executable as Node, running out/host/index.js for this data dir. */
export interface HostLaunch { file: string; args: string[]; env: Record<string, string> }

export interface HostBackendOptions {
  dataDir: string
  appVersion: string
  /** How to start a host when none is running; null never starts one (tests that only look). */
  launch: HostLaunch | null
  platform?: NodeJS.Platform
  startTimeoutMs?: number
  requestTimeoutMs?: number
  /** For connecting and the handshake. */
  connectTimeoutMs?: number
  /** A host that couldn't be used (no answer, refused) is reported again without retrying for this long. */
  failureCacheMs?: number
}

export class HostError extends Error {
  constructor(message: string, readonly code?: ErrorCode) {
    super(message)
  }
}

/** The host is gone (or leaving) before it answered, so it didn't run the request. */
class HostGone extends Error {
  constructor() {
    super('The Pitwall host went away.')
  }
}

interface OpenOptions {
  path: string
  dataDir: string
  platform: NodeJS.Platform
  appVersion: string
  connectTimeoutMs: number
  requestTimeoutMs: number
}

const noHost = (): Error => Object.assign(new Error('no host'), { noHost: true })
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const duration = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)}s`)
/** A terminal dimension the host accepts. */
const dim = (n: number): number => Math.min(MAX_TERM_SIZE, Math.max(1, Math.floor(n) || 1))

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never
type RequestBody = WithoutId<Request>

interface Pending { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }
interface Channel { data(b: Buffer): void; exit(code: number): void }

/** One connection to the host, after a successful hello. */
class Connection {
  closed = false
  private decoder = new FrameDecoder()
  private pending = new Map<number, Pending>()
  private channels = new Map<number, Channel>()
  private closeCbs: Array<() => void> = []
  private nextId = 1
  private nextCh = 1

  private constructor(private readonly socket: net.Socket, readonly pid: number, private readonly requestTimeoutMs: number) {}

  /**
   * Connects and completes the handshake (protocol.ts): the host proves it knows the host key before this app sends
   * it anything but hello. Rejects with `noHost` when nothing listens, or with a HostError the user should see.
   */
  static open(o: OpenOptions): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(o.path)
      const decoder = new FrameDecoder()
      const nonce = newNonce()
      let hostPid: number | null = null // once the host has greeted us
      let settled = false
      const fail = (e: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        reject(e)
      }
      // Until the peer proves it knows the host key, nothing it says (pid, version, error) is shown or acted on.
      const machine = o.platform === 'darwin' ? 'Mac' : o.platform === 'win32' ? 'PC' : 'computer'
      const refused = (why: string): Error => new HostError(
        `Something answering as Pitwall's background host at ${o.path} couldn't prove it is one (${why}), ` +
        `so Pitwall sent it nothing and won't use it. Quit other Pitwall versions, or restart your ${machine}.`
      )
      const foreign = (): Error => new HostError(
        `Another background process is answering at ${o.path} and doesn't speak this version of Pitwall (or isn't Pitwall). ` +
        `Quit other Pitwall versions, or restart your ${machine}.`
      )
      const timer = setTimeout(() => fail(new HostError(`The Pitwall host isn't answering (${o.path}).`)), o.connectTimeoutMs)
      const onConnect = (): void => { socket.write(encodeJson({ t: 'hello', protocol: PROTOCOL, appVersion: o.appVersion, nonce })) }
      const onError = (e: NodeJS.ErrnoException): void => {
        // Nothing there, nothing listening, or not a socket at all: no host (one that starts cleans up).
        if (hostPid === null && (e.code === 'ENOENT' || e.code === 'ECONNREFUSED' || e.code === 'ENOTSOCK')) return fail(noHost())
        fail(new HostError(`Couldn't reach the Pitwall host: ${e.message}`))
      }
      const onClose = (): void => {
        fail(hostPid === null ? noHost() : new HostError(`The Pitwall host (pid ${hostPid}) refused this app. See ${hostLogFile(o.dataDir)}.`))
      }
      const unreadable = (e: unknown): void => fail(new HostError(`The Pitwall host sent something unreadable: ${(e as Error).message}`))
      const onData = (chunk: Buffer): void => {
        let frames: Frame[]
        try {
          frames = decoder.push(chunk)
        } catch (e) {
          return unreadable(e)
        }
        while (frames.length > 0 && !settled) {
          const f = frames.shift()!
          let m: HostMessage
          try {
            if (f.type !== 'json') throw new Error('data before the handshake')
            m = parseHostMessage(f.msg)
          } catch (e) {
            return unreadable(e)
          }
          if (m.t === 'bye') return fail(noHost()) // it's leaving: as if nobody were there, so a new host gets started
          if (hostPid === null) {
            if (m.t !== 'hello') return unreadable(new Error(`${m.t} before hello`))
            let key: Buffer | null = null
            let why = ''
            try {
              key = readHostKey(o.dataDir, o.platform)
            } catch (e) {
              why = e instanceof HostKeyError ? e.message : `couldn't read the host key: ${(e as Error).message}`
            }
            const proven = key !== null && checkProof(key, 'host', nonce, m.proof)
            if (m.protocol !== PROTOCOL) {
              if (!proven) return fail(foreign())
              return fail(new HostError( // proven: a Pitwall host of this user's, so its pid and version can be shown
                `Pitwall's background host (pid ${m.pid}, from Pitwall ${m.appVersion}) speaks protocol ${m.protocol}; ` +
                `this Pitwall speaks protocol ${PROTOCOL}, so it can't use it. Its agents are still running in it. ` +
                `To switch, quit Pitwall, end that host (pid ${m.pid}) and reopen Pitwall: each agent restarts and resumes its conversation.`
              ))
            }
            if (key === null) return fail(refused(why))
            if (!proven || !m.nonce) return fail(refused("its proof doesn't match the host key"))
            if (m.error !== undefined) return fail(new HostError(`The Pitwall host refused this app. See ${hostLogFile(o.dataDir)}.`))
            hostPid = m.pid
            socket.write(encodeJson({ t: 'auth', proof: proofFor(key, 'app', m.nonce) }))
            continue
          }
          if (m.t !== 'ready') return unreadable(new Error(`${m.t} before ready`))
          settled = true
          clearTimeout(timer)
          socket.off('connect', onConnect).off('error', onError).off('close', onClose).off('data', onData)
          const c = new Connection(socket, hostPid, o.requestTimeoutMs)
          c.decoder = decoder
          c.listen()
          resolve(c)
          for (const rest of frames) c.onFrame(rest)
          return
        }
      }
      socket.once('connect', onConnect).on('error', onError).on('close', onClose).on('data', onData)
    })
  }

  onClose(cb: () => void): void {
    if (this.closed) cb()
    else this.closeCbs.push(cb)
  }

  request(body: RequestBody): Promise<unknown> {
    if (this.closed) return Promise.reject(new HostGone())
    const id = this.nextId++
    let frame: Buffer
    try {
      frame = encodeJson({ ...body, id })
    } catch (e) {
      return Promise.reject(e) // too large to send
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new HostError(`The Pitwall host (pid ${this.pid}) didn't answer within ${duration(this.requestTimeoutMs)}.`))
        this.destroy() // wedged: the next call connects again
      }, this.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.write(frame)
    })
  }

  notify(msg: { t: 'detach'; ch: number } | { t: 'resize'; ch: number; cols: number; rows: number }): void {
    if (!this.closed) this.socket.write(encodeJson(msg))
  }

  sendData(ch: number, data: Buffer): void {
    if (this.closed) return
    for (const frame of encodeDataChunks(ch, data)) this.socket.write(frame)
  }

  openChannel(c: Channel): number {
    const ch = this.nextCh++
    this.channels.set(ch, c)
    return ch
  }

  closeChannel(ch: number): void {
    this.channels.delete(ch)
  }

  /** Disconnects without telling anyone: attachments stay silent (the app is going away). */
  disconnect(): void {
    this.channels.clear()
    this.destroy()
  }

  private destroy(): void {
    this.socket.destroy()
    this.onClosed()
  }

  private listen(): void {
    this.socket.on('data', (chunk: Buffer) => {
      let frames: Frame[]
      try {
        frames = this.decoder.push(chunk)
      } catch {
        this.destroy()
        return
      }
      for (const f of frames) this.onFrame(f)
    })
    this.socket.on('error', () => { /* 'close' follows */ })
    this.socket.on('close', () => this.onClosed())
  }

  private onFrame(f: Frame): void {
    if (this.closed) return
    if (f.type === 'data') {
      this.channels.get(f.ch)?.data(f.data)
      return
    }
    let m: HostMessage
    try {
      m = parseHostMessage(f.msg)
    } catch {
      this.destroy()
      return
    }
    if (m.t === 'res') {
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      clearTimeout(p.timer)
      if (m.ok) p.resolve(m.value)
      else p.reject(new HostError(m.error, m.code))
    } else if (m.t === 'exit') {
      const c = this.channels.get(m.ch)
      this.channels.delete(m.ch)
      c?.exit(m.code)
    } else if (m.t === 'bye') {
      this.destroy() // unanswered requests weren't run: they go to the next host
    }
  }

  private onClosed(): void {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new HostGone())
    }
    this.pending.clear()
    const channels = [...this.channels.values()]
    this.channels.clear()
    for (const c of channels) c.exit(1) // the host died: like tmux's server going away
    for (const cb of this.closeCbs.splice(0)) cb()
  }
}

const isNoHost = (e: unknown): boolean => (e as { noHost?: boolean }).noHost === true

/** An attachment to a session that isn't there: it ends at once, as `tmux attach` to a missing session does. */
function endedAttachment(h: AttachHandlers): Attachment {
  let closed = false
  setImmediate(() => { if (!closed) h.onExit(1) })
  return { write: () => {}, resize: () => {}, close: () => { closed = true } }
}

/**
 * Sessions in the Pitwall host (src/host): a background process that owns the terminals, so agents outlive the app.
 * Started on demand: only newSession starts a host; with none running there are no sessions.
 */
export class HostBackend implements SessionBackend {
  readonly socketPath: string
  private conn: Connection | null = null
  private connecting: Promise<Connection | null> | null = null
  private starting: Promise<Connection> | null = null
  /** The last connect that failed for a reason worth reporting, and until when it is reported as is. */
  private failure: { error: Error; until: number } | null = null
  private readonly startTimeoutMs: number
  private readonly requestTimeoutMs: number

  constructor(private readonly o: HostBackendOptions) {
    this.socketPath = hostSocketPath(o.dataDir, { platform: o.platform })
    this.startTimeoutMs = o.startTimeoutMs ?? 15_000
    this.requestTimeoutMs = o.requestTimeoutMs ?? 30_000
  }

  /** The connected host's pid, if connected. */
  get hostPid(): number | null {
    return this.conn && !this.conn.closed ? this.conn.pid : null
  }

  listSessions(): Promise<string[]> {
    return this.call({ t: 'list' }, false, () => []) as Promise<string[]>
  }

  hasSession(name: string): Promise<boolean> {
    return this.call({ t: 'has', name }, false, () => false) as Promise<boolean>
  }

  async newSession(o: NewSessionOptions): Promise<void> {
    const req = { t: 'new' as const, name: o.name, cwd: o.cwd, argv: o.argv, env: o.env ?? {} }
    await this.call(o.launcher ? { ...req, launcher: o.launcher } : req, true, () => undefined)
  }

  async killSession(name: string): Promise<void> {
    await this.call({ t: 'kill', name }, false, () => undefined)
  }

  capture(name: string): Promise<string> {
    return this.call({ t: 'capture', name }, false, () => missing(name)) as Promise<string>
  }

  async sendKeys(name: string, keys: string[], literal = false): Promise<void> {
    await this.call({ t: 'send', name, keys, literal }, false, () => missing(name))
  }

  async pasteText(name: string, text: string): Promise<void> {
    await this.call({ t: 'paste', name, text }, false, () => missing(name))
  }

  processRoots(name: string): Promise<ProcessRoots> {
    return this.call({ t: 'roots', name }, false, () => ({ serverPid: null, panePids: [] })) as Promise<ProcessRoots>
  }

  async attach(name: string, cols: number, rows: number, h: AttachHandlers): Promise<Attachment> {
    const c = await this.connection(false)
    if (!c) return endedAttachment(h)
    let closed = false
    const text = new StringDecoder('utf8')
    const ch = c.openChannel({
      data: (b) => {
        if (closed) return
        const s = text.write(b)
        if (s) h.onData(s)
      },
      exit: (code) => {
        if (closed) return
        closed = true
        h.onExit(code)
      }
    })
    try {
      await c.request({ t: 'attach', name, ch, cols: dim(cols), rows: dim(rows) })
    } catch (e) {
      c.closeChannel(ch)
      if (closed) return { write: () => {}, resize: () => {}, close: () => {} } // the host went away: exit already sent
      if (e instanceof HostError && e.code === 'no-session') {
        closed = true
        return endedAttachment(h)
      }
      closed = true
      throw e
    }
    return {
      write: (data) => { if (!closed) c.sendData(ch, Buffer.from(data, 'utf8')) },
      resize: (cols2, rows2) => { if (!closed) c.notify({ t: 'resize', ch, cols: dim(cols2), rows: dim(rows2) }) },
      close: () => {
        if (closed) return
        closed = true
        c.closeChannel(ch)
        c.notify({ t: 'detach', ch })
      }
    }
  }

  /** Ends every session and the host; resolves once the host process is gone. */
  async shutdown(): Promise<void> {
    const c = await this.connection(false)
    if (!c) return
    try {
      await c.request({ t: 'shutdown' })
    } catch (e) {
      if (!(e instanceof HostGone)) throw e
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000)
      c.onClose(() => { clearTimeout(timer); resolve() })
    })
    const deadline = Date.now() + 5000
    while (alive(c.pid) && Date.now() < deadline) await sleep(25)
  }

  /** Drops the connection, as quitting the app does; the host and its sessions carry on. */
  disconnect(): void {
    this.conn?.disconnect()
    this.conn = null
  }

  // ---- connection -------------------------------------------------------------

  /** Runs a request on the host; `none()` answers when no host runs (and `start` is false). */
  private async call(body: RequestBody, start: boolean, none: () => unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const c = await this.connection(start)
      if (!c) return none()
      try {
        return await c.request(body)
      } catch (e) {
        // The host left before answering (it went idle, or died): it didn't run this. Ask the next one.
        if (!(e instanceof HostGone)) throw e
        if (attempt >= 3) throw new HostError(`Pitwall's background process keeps stopping — see ${hostLogFile(this.o.dataDir)}.`)
      }
    }
  }

  private async connection(start: boolean): Promise<Connection | null> {
    const c = await this.connectOnce()
    if (c || !start) return c
    return (this.starting ??= this.startHost().finally(() => { this.starting = null }))
  }

  /**
   * The current connection, or a new one if a host is listening; concurrent callers share one attempt. A host that
   * just failed (no answer, refused) fails again at once for a few seconds, so starting with many sessions doesn't
   * wait on it once per session.
   */
  private connectOnce(): Promise<Connection | null> {
    if (this.conn && !this.conn.closed) return Promise.resolve(this.conn)
    if (this.failure && Date.now() < this.failure.until) return Promise.reject(this.failure.error)
    return (this.connecting ??= this.tryConnect().finally(() => { this.connecting = null }))
  }

  private async tryConnect(): Promise<Connection | null> {
    try {
      const c = await Connection.open({
        path: this.socketPath, dataDir: this.o.dataDir, platform: this.o.platform ?? process.platform,
        appVersion: this.o.appVersion, connectTimeoutMs: this.o.connectTimeoutMs ?? 5000, requestTimeoutMs: this.requestTimeoutMs
      })
      this.failure = null
      this.conn = c
      c.onClose(() => { if (this.conn === c) this.conn = null })
      return c
    } catch (e) {
      if (isNoHost(e)) return null
      this.failure = { error: e as Error, until: Date.now() + (this.o.failureCacheMs ?? 5000) }
      throw e
    }
  }

  /**
   * Starts a host and connects to it. Two apps (or two calls) starting one at once is fine: only one host binds the
   * socket, the other exits, and both apps connect to the one that did.
   */
  private async startHost(): Promise<Connection> {
    const launch = this.o.launch
    if (!launch) throw new HostError('No Pitwall host is running.')
    mkdirSync(this.o.dataDir, { recursive: true })
    const state = { failure: null as string | null }
    const child = process.platform === 'win32'
      ? startViaShell(launch, this.o.dataDir)
      : spawn(launch.file, launch.args, { detached: true, stdio: 'ignore', env: launch.env, cwd: this.o.dataDir, windowsHide: true })
    // What the starter says on stderr (PowerShell on Windows): into host.log and the error, if it fails.
    let stderr = ''
    child.stderr?.setEncoding('utf8').on('data', (d: string) => { if (stderr.length < 4096) stderr += d })
    child.on('error', (e) => { state.failure = e.message })
    // Exit code 0 is a host that found another one already serving: keep connecting, to that one.
    child.on('exit', (code, signal) => {
      if (code === 0) return
      // (A moment for the last of stderr: 'exit' can come before the pipe's last data.)
      setTimeout(() => {
        const said = stderr.trim()
        if (said) {
          try { appendFileSync(hostLogFile(this.o.dataDir), `${new Date().toISOString()} [app] starting the host failed:\n${said}\n`) } catch { /* no log */ }
        }
        const first = said.split(/\r?\n/)[0]?.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200)
        state.failure = (signal ? `it was killed (${signal})` : `it exited with code ${code}`) + (first ? ` (${first})` : '')
      }, 50)
    })
    child.unref()
    ;(child.stderr as { unref?: () => void } | null)?.unref?.()
    const deadline = Date.now() + this.startTimeoutMs
    for (;;) {
      const c = await this.connectOnce()
      if (c) return c
      if (state.failure) throw new HostError(`Couldn't start the Pitwall host: ${state.failure}. See ${hostLogFile(this.o.dataDir)}.`)
      if (Date.now() > deadline) {
        throw new HostError(`The Pitwall host didn't start within ${duration(this.startTimeoutMs)}. See ${hostLogFile(this.o.dataDir)}.`)
      }
      await sleep(50)
    }
  }
}

/** How long PowerShell waits for a host it started on Windows, so one that fails at once still reports its exit code. */
const SHELL_START_WAIT_S = 2

/**
 * Windows: the host is started with ShellExecute (PowerShell's Start-Process), not CreateProcess. Electron leaves its
 * own stdout/stderr inheritable, and CreateProcess hands every inheritable handle to the child: a host started
 * directly would hold open whatever pipes started Pitwall (pnpm dev, a test runner, CI) for as long as it lives.
 * ShellExecute passes no handles. PowerShell exits with the host's code if it ends within SHELL_START_WAIT_S, else 0;
 * the host gets PowerShell's environment as the app gave it (the variables used here, and PowerShell's own change to
 * PSModulePath, are put back first). Cmdlets and property reads only, no method calls: those stay allowed where
 * PowerShell runs in Constrained Language Mode. PowerShell's own errors go to stderr, which the caller keeps.
 */
function startViaShell(launch: HostLaunch, cwd: string): ChildProcess {
  const psModulePath = envValue(launch.env, 'PSModulePath')
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$file = $env:PITWALL_HOST_FILE; $argLine = $env:PITWALL_HOST_ARGS; $dir = $env:PITWALL_HOST_CWD',
    "if ($env:PITWALL_HOST_PSMP_SET -eq '1') { $env:PSModulePath = $env:PITWALL_HOST_PSMP } else { Remove-Item Env:PSModulePath -ErrorAction SilentlyContinue }",
    'Remove-Item Env:PITWALL_HOST_FILE, Env:PITWALL_HOST_ARGS, Env:PITWALL_HOST_CWD, Env:PITWALL_HOST_PSMP, Env:PITWALL_HOST_PSMP_SET -ErrorAction SilentlyContinue',
    '$p = Start-Process -FilePath $file -ArgumentList $argLine -WorkingDirectory $dir -WindowStyle Hidden -PassThru',
    `Wait-Process -Id $p.Id -Timeout ${SHELL_START_WAIT_S} -ErrorAction SilentlyContinue`,
    'if ($p.HasExited) { exit $p.ExitCode }',
    'exit 0'
  ].join('\n')
  return spawn(windowsPowerShell(launch.env), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    env: {
      ...launch.env,
      PITWALL_HOST_FILE: launch.file,
      PITWALL_HOST_ARGS: launch.args.map(quoteWindowsArg).join(' '),
      PITWALL_HOST_CWD: cwd,
      PITWALL_HOST_PSMP: psModulePath ?? '',
      PITWALL_HOST_PSMP_SET: psModulePath === undefined ? '0' : '1'
    }
  })
}

function missing(name: string): never {
  throw new HostError(`no such session: ${name}`, 'no-session')
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
