/**
 * The host protocol, shared by the host (src/host) and the app's HostBackend. Pure: no I/O.
 *
 * A connection carries frames: a u32 big-endian length L, then L bytes: one type byte and its body.
 *   JSON (1): a UTF-8 JSON object, a ClientMessage or a HostMessage.
 *   DATA (2): a u32 big-endian channel, then raw terminal bytes (host → app: output; app → host: input).
 * A frame longer than MAX_FRAME, or one that doesn't parse, ends the connection.
 *
 * Handshake. Each side proves it knows the host key (`host.key` in the data dir, readable only by the user, written
 * afresh by each host as it starts), so the app never talks to an impostor and the host never serves a stranger:
 *   app  → hello { protocol, appVersion, nonce }
 *   host → hello { protocol, appVersion, pid, nonce, proof: HMAC(key, host, app's nonce) }   (or `error`: refused)
 *   app checks the proof before sending anything else, then → auth { proof: HMAC(key, app, host's nonce) }
 *   host → ready. Only then requests, notices and data.
 * A host refusing another protocol still proves itself when it can. The app shows nothing a host says (pid, version,
 * error) unless its proof checked out, and a `bye` before `ready` means the host is leaving (as if none were there).
 */
export const PROTOCOL = 1
export const MAX_FRAME = 16 * 1024 * 1024
/** Output is sent in data frames of at most this many bytes. */
export const DATA_CHUNK = 64 * 1024

const JSON_FRAME = 1
const DATA_FRAME = 2
const MAX_CHANNEL = 0xffffffff

export class ProtocolError extends Error {}

export type Frame = { type: 'json'; msg: unknown } | { type: 'data'; ch: number; data: Buffer }

export function encodeJson(msg: object): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  if (body.length + 1 > MAX_FRAME) throw new ProtocolError(`message too large (${body.length} bytes)`)
  const b = Buffer.allocUnsafe(5 + body.length)
  b.writeUInt32BE(body.length + 1, 0)
  b[4] = JSON_FRAME
  body.copy(b, 5)
  return b
}

export function encodeData(ch: number, data: Uint8Array): Buffer {
  if (data.length + 5 > MAX_FRAME) throw new ProtocolError(`data frame too large (${data.length} bytes)`)
  const b = Buffer.allocUnsafe(9 + data.length)
  b.writeUInt32BE(data.length + 5, 0)
  b[4] = DATA_FRAME
  b.writeUInt32BE(ch, 5)
  b.set(data, 9)
  return b
}

/** Data of any size, as frames of at most DATA_CHUNK bytes each. */
export function encodeDataChunks(ch: number, data: Uint8Array): Buffer[] {
  const out: Buffer[] = []
  for (let i = 0; i < data.length; i += DATA_CHUNK) out.push(encodeData(ch, data.subarray(i, i + DATA_CHUNK)))
  return out
}

/** Turns a byte stream back into frames, whatever the chunking. After a ProtocolError it stays failed. */
export class FrameDecoder {
  private chunks: Buffer[] = []
  private size = 0
  private failed: ProtocolError | null = null

  constructor(private readonly max = MAX_FRAME) {}

  push(chunk: Buffer): Frame[] {
    if (this.failed) throw this.failed
    if (chunk.length) {
      this.chunks.push(chunk)
      this.size += chunk.length
    }
    const out: Frame[] = []
    while (this.size >= 4) {
      const len = this.peekLength()
      // Checked before the body arrives: an oversize frame is never buffered.
      if (len < 1 || len > this.max) return this.fail(`frame length ${len} is out of range (1–${this.max})`)
      if (this.size < 4 + len) break
      this.take(4)
      const body = this.take(len)
      try {
        out.push(parseFrame(body))
      } catch (e) {
        return this.fail(e instanceof Error ? e.message : String(e))
      }
    }
    return out
  }

  /** Bytes buffered for a frame that hasn't fully arrived. */
  get pending(): number {
    return this.size
  }

  private fail(message: string): never {
    this.failed = new ProtocolError(message)
    this.chunks = []
    this.size = 0
    throw this.failed
  }

  private peekLength(): number {
    if (this.chunks[0].length < 4) this.chunks = [Buffer.concat(this.chunks)]
    return this.chunks[0].readUInt32BE(0)
  }

  private take(n: number): Buffer {
    this.size -= n
    const first = this.chunks[0]
    if (first.length >= n) {
      if (first.length === n) this.chunks.shift()
      else this.chunks[0] = first.subarray(n)
      return first.subarray(0, n)
    }
    const parts: Buffer[] = []
    let need = n
    while (need > 0) {
      const c = this.chunks[0]
      if (c.length <= need) {
        parts.push(c)
        this.chunks.shift()
        need -= c.length
      } else {
        parts.push(c.subarray(0, need))
        this.chunks[0] = c.subarray(need)
        need = 0
      }
    }
    return Buffer.concat(parts, n)
  }
}

function parseFrame(body: Buffer): Frame {
  const type = body[0]
  if (type === JSON_FRAME) {
    let msg: unknown
    try {
      msg = JSON.parse(body.subarray(1).toString('utf8'))
    } catch {
      throw new ProtocolError('a JSON frame did not parse')
    }
    if (!isObject(msg)) throw new ProtocolError('a JSON frame is not an object')
    return { type: 'json', msg }
  }
  if (type === DATA_FRAME) {
    if (body.length < 5) throw new ProtocolError('a data frame has no channel')
    return { type: 'data', ch: body.readUInt32BE(1), data: body.subarray(5) }
  }
  throw new ProtocolError(`unknown frame type ${type}`)
}

// ---- messages ---------------------------------------------------------------

/** `nonce` is required by this protocol; a hello from another protocol may lack it and is refused by version. */
export interface Hello { t: 'hello'; protocol: number; appVersion: string; nonce?: string }
export interface Auth { t: 'auth'; proof: string }

/**
 * Run the session through the host's launcher (Windows: no sh for pitwall-launch): Claude from its session folder,
 * relaunched on Enter, or (`shell`) `argv` once, both with the session's identity. See launcher.ts.
 */
export interface LauncherSpec { kind: 'claude' | 'shell'; sessionDir: string }

export type Request =
  | { t: 'list'; id: number }
  | { t: 'has'; id: number; name: string }
  /** `argv` may be empty only for a Claude launcher. */
  | { t: 'new'; id: number; name: string; cwd: string; argv: string[]; env: Record<string, string>; launcher?: LauncherSpec }
  | { t: 'kill'; id: number; name: string }
  | { t: 'capture'; id: number; name: string }
  | { t: 'send'; id: number; name: string; keys: string[]; literal: boolean }
  | { t: 'paste'; id: number; name: string; text: string }
  | { t: 'roots'; id: number; name: string }
  /** Output on `ch` starts with a replay of recent output; the terminal takes the attachment's size. */
  | { t: 'attach'; id: number; name: string; ch: number; cols: number; rows: number }
  /** Ends every session, then the host. */
  | { t: 'shutdown'; id: number }

/** No reply. Data frames from the app on an attached channel are the terminal's input. */
export type Notice =
  | { t: 'detach'; ch: number }
  | { t: 'resize'; ch: number; cols: number; rows: number }

export type ClientMessage = Hello | Auth | Request | Notice

/** `paneStarts` (the host): when each pane's process was started, ms since 1970, in `panePids`' order. */
export interface ProcessRoots { serverPid: number | null; panePids: number[]; paneStarts?: number[] }

/** `no-session`: the named session doesn't exist. `exists`: a session has that name. */
export type ErrorCode = 'no-session' | 'exists' | 'bad-request' | 'failed'

export type HostMessage =
  | { t: 'hello'; protocol: number; appVersion: string; pid: number; nonce?: string; proof?: string; error?: string }
  /** The app's proof checked out: requests may follow. */
  | { t: 'ready' }
  | { t: 'res'; id: number; ok: true; value?: unknown }
  | { t: 'res'; id: number; ok: false; error: string; code: ErrorCode }
  /** The session behind an attachment ended (or was killed). The channel is closed. */
  | { t: 'exit'; ch: number; code: number }
  /** The host is going away (idle, shutdown). Requests it hasn't answered were not run: send them to the next host. */
  | { t: 'bye'; reason: string }

const MAX_NAME = 256
export const MAX_TERM_SIZE = 10000

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function bad(message: string): never {
  throw new ProtocolError(message)
}

const int = (v: unknown, min: number, max: number, what: string): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : bad(`${what} must be an integer ${min}–${max}`)
const str = (v: unknown, what: string, max = Infinity): string =>
  typeof v === 'string' && v.length <= max ? v : bad(`${what} must be a string`)
const name = (v: unknown): string => {
  const s = str(v, 'name', MAX_NAME)
  return s.length > 0 ? s : bad('name must not be empty')
}
const strings = (v: unknown, what: string): string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : bad(`${what} must be a list of strings`)
const stringMap = (v: unknown, what: string): Record<string, string> => {
  if (v === undefined) return {}
  if (!isObject(v) || !Object.values(v).every((x) => typeof x === 'string')) bad(`${what} must map names to strings`)
  return v as Record<string, string>
}
const HEX64 = /^[0-9a-f]{64}$/
const hex64 = (v: unknown, what: string): string => (typeof v === 'string' && HEX64.test(v) ? v : bad(`${what} must be 64 hex digits`))
/** In a hello, a nonce or proof that isn't one counts as missing (and the handshake then fails on its own terms). */
const maybeHex64 = (v: unknown): string | undefined => (typeof v === 'string' && HEX64.test(v) ? v : undefined)
/** A message type, quoted safely and briefly in an error. */
const quote = (v: unknown): string => JSON.stringify(String(v).slice(0, 40))

/**
 * A version another process reports, safe to show anywhere (a log, a message): anything that doesn't look like a
 * version, escape sequences included, becomes "unknown".
 */
export const cleanVersion = (v: unknown): string => (typeof v === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(v) ? v : 'unknown')
const launcherSpec = (v: unknown): LauncherSpec => {
  if (!isObject(v) || (v.kind !== 'claude' && v.kind !== 'shell')) bad('launcher must name a kind (claude or shell)')
  const sessionDir = str(v.sessionDir, 'launcher.sessionDir')
  return sessionDir ? { kind: v.kind, sessionDir } : bad('launcher.sessionDir must not be empty')
}
const id = (v: Record<string, unknown>): number => int(v.id, 0, Number.MAX_SAFE_INTEGER, 'id')
const ch = (v: Record<string, unknown>): number => int(v.ch, 1, MAX_CHANNEL, 'ch')
const size = (v: unknown, what: string): number => int(v, 1, MAX_TERM_SIZE, what)

/** Validates a message from the app; throws ProtocolError. The host never trusts a message's shape. */
export function parseClientMessage(v: unknown): ClientMessage {
  if (!isObject(v)) bad('a message must be an object')
  switch (v.t) {
    case 'hello': {
      const m: Hello = { t: 'hello', protocol: int(v.protocol, 0, MAX_CHANNEL, 'protocol'), appVersion: cleanVersion(v.appVersion) }
      const nonce = maybeHex64(v.nonce)
      if (nonce !== undefined) m.nonce = nonce
      return m
    }
    case 'auth': return { t: 'auth', proof: hex64(v.proof, 'proof') }
    case 'list': return { t: 'list', id: id(v) }
    case 'has': return { t: 'has', id: id(v), name: name(v.name) }
    case 'new': {
      const argv = strings(v.argv, 'argv')
      const launcher = v.launcher === undefined ? undefined : launcherSpec(v.launcher)
      if (argv.length === 0 && launcher?.kind !== 'claude') bad('argv must not be empty')
      const m: Request = { t: 'new', id: id(v), name: name(v.name), cwd: str(v.cwd, 'cwd'), argv, env: stringMap(v.env, 'env') }
      return launcher ? { ...m, launcher } : m
    }
    case 'kill': return { t: 'kill', id: id(v), name: name(v.name) }
    case 'capture': return { t: 'capture', id: id(v), name: name(v.name) }
    case 'send': return { t: 'send', id: id(v), name: name(v.name), keys: strings(v.keys, 'keys'), literal: v.literal === true }
    case 'paste': return { t: 'paste', id: id(v), name: name(v.name), text: str(v.text, 'text') }
    case 'roots': return { t: 'roots', id: id(v), name: name(v.name) }
    case 'attach':
      return { t: 'attach', id: id(v), name: name(v.name), ch: ch(v), cols: size(v.cols, 'cols'), rows: size(v.rows, 'rows') }
    case 'shutdown': return { t: 'shutdown', id: id(v) }
    case 'detach': return { t: 'detach', ch: ch(v) }
    case 'resize': return { t: 'resize', ch: ch(v), cols: size(v.cols, 'cols'), rows: size(v.rows, 'rows') }
    default: return bad(`unknown message ${quote(v.t)}`)
  }
}

/**
 * Validates a message from the host; throws ProtocolError. Nothing in a hello may be shown to the user unless its
 * proof checks out (see HostBackend): its version is cleaned here regardless.
 */
export function parseHostMessage(v: unknown): HostMessage {
  if (!isObject(v)) bad('a message must be an object')
  switch (v.t) {
    case 'hello': {
      const m: HostMessage = {
        t: 'hello', protocol: int(v.protocol, 0, MAX_CHANNEL, 'protocol'), appVersion: cleanVersion(v.appVersion),
        pid: int(v.pid, 0, Number.MAX_SAFE_INTEGER, 'pid')
      }
      if (v.error !== undefined) m.error = typeof v.error === 'string' ? v.error.slice(0, 1000) : 'refused'
      const nonce = maybeHex64(v.nonce)
      const proof = maybeHex64(v.proof)
      if (nonce !== undefined) m.nonce = nonce
      if (proof !== undefined) m.proof = proof
      return m
    }
    case 'ready': return { t: 'ready' }
    case 'res':
      if (v.ok === true) return { t: 'res', id: id(v), ok: true, value: v.value }
      return { t: 'res', id: id(v), ok: false, error: str(v.error, 'error'), code: str(v.code, 'code') as ErrorCode }
    case 'exit': return { t: 'exit', ch: ch(v), code: int(v.code, -MAX_CHANNEL, MAX_CHANNEL, 'code') }
    case 'bye': return { t: 'bye', reason: str(v.reason, 'reason') }
    default: return bad('unknown message type') // (never the peer's words: this may come from an unproven host)
  }
}
