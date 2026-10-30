import { open, readdir, stat, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppSnapshot, HistoryHit, Session } from '@shared/types'
import { claudeConfigDir } from './identity'

export type { HistoryHit }

/**
 * Search over Pitwall sessions' titles and their Claude conversations. Reads Claude's transcripts
 * (`<config dir>/projects/<folder>/<conversation id>.jsonl`) and never writes there.
 */

/** Text kept per session (characters), across all its conversations: the start and the most recent part. */
export const TEXT_CAP = 300_000
const MAX_QUERY = 256
const MAX_TERMS = 16
const MAX_HITS = 50
const SNIPPET_CONTEXT = 60
const CHUNK = 1 << 20
/** Longer lines are tool output or blobs, never a prompt worth keeping in memory. */
const MAX_LINE = 8 * 1024 * 1024
/** Bytes before the last read position, compared to tell an appended file from a rewritten one. */
const FINGERPRINT = 64

export interface HistorySource {
  session: Session
  archived: boolean
  projectName: string
  subProjectName: string
  /** Where this session's Claude keeps its transcripts (under `projects/`). */
  configDir: string
  /** Latest event, or when it was archived (ms). */
  updatedAt: number
}

/** Every running and archived session, with its Claude config dir. */
export function historySources(
  snap: Pick<AppSnapshot, 'projects' | 'subProjects' | 'sessions' | 'archived'>,
  home: string,
  env: Record<string, string>
): HistorySource[] {
  const make = (s: Session, archived: boolean, updatedAt: number): HistorySource => {
    const sp = snap.subProjects.find((x) => x.id === s.subProjectId)
    const project = sp && snap.projects.find((p) => p.id === sp.projectId)
    return {
      session: s, archived, updatedAt,
      projectName: project?.name ?? '',
      subProjectName: sp?.name ?? '',
      configDir: project ? claudeConfigDir(project, home, env) : env.CLAUDE_CONFIG_DIR || join(home, '.claude')
    }
  }
  return [
    ...snap.sessions.map((s) => make(s, false, s.lastActivityAt ?? s.createdAt)),
    ...snap.archived.map((s) => make(s, true, s.archivedAt ?? s.createdAt))
  ]
}

export function queryTerms(query: string): string[] {
  return [...new Set(query.slice(0, MAX_QUERY).toLowerCase().split(/\s+/).filter(Boolean))].slice(0, MAX_TERMS)
}

// Claude Code wraps slash commands, their output and background notices like this; they aren't the user's words.
const WRAPPED = /^\s*<(command-[a-z]+|local-command-[a-z]+|bash-std(out|err)|task-notification|system-reminder)>/

function blockText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const b of content) {
    if (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text') {
      const t = (b as { text?: unknown }).text
      if (typeof t === 'string' && t) parts.push(t)
    }
  }
  return parts.length ? parts.join('\n') : null
}

/** The searchable text of one transcript line: a user prompt or assistant text; null for anything else. */
export function lineText(line: string): string | null {
  // Most lines (tool calls and results, metadata) are ruled out before parsing.
  if (!line.includes('"user"') && !line.includes('"assistant"')) return null
  return parsedText(line)
}

function parsedText(line: string): string | null {
  let o: unknown
  try {
    o = JSON.parse(line)
  } catch {
    return null
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const r = o as { type?: unknown; message?: { content?: unknown }; isMeta?: unknown; isSidechain?: unknown; isCompactSummary?: unknown }
  if (r.isMeta === true || r.isSidechain === true || r.isCompactSummary === true) return null
  if (r.type !== 'user' && r.type !== 'assistant') return null
  const content = r.message && typeof r.message === 'object' ? r.message.content : undefined
  if (r.type === 'user' && Array.isArray(content) && content.some((b) => b && typeof b === 'object' && b.type === 'tool_result')) {
    return null
  }
  const text = blockText(content)
  if (!text || (r.type === 'user' && WRAPPED.test(text))) return null
  return text
}

/** Byte-level version of lineText's quick checks, so big tool output is never even decoded. */
function bufferText(buf: Buffer): string | null {
  if (!buf.includes('"user"') && !buf.includes('"assistant"')) return null
  if (buf.includes('"tool_use_id"')) return null // a tool result
  return parsedText(buf.toString('utf8'))
}

/** Marks where text was dropped between the start of a conversation and its most recent part. */
const GAP = '\n…\n'

/** A copy that doesn't keep a bigger string alive (V8 lets a slice share its source's memory). */
function detach(s: string): string {
  return (' ' + s).slice(1)
}

/**
 * Appended text up to a cap: the first half of the cap keeps the start, the second half the most recent text.
 * Pieces are buffered and folded in at most every `cap` characters, so only one copy of the kept text stays.
 */
export class CappedText {
  private kept = ''
  /** Length of the start part of `kept`; it fills to half the cap before anything goes after it. */
  private headLen = 0
  private gap = false
  private pending: string[] = []
  private pendingLen = 0

  constructor(private readonly cap = TEXT_CAP) {}

  /** Characters held, including pieces not folded in yet. */
  get size(): number {
    return this.kept.length + this.pendingLen
  }

  add(piece: string): void {
    if (!piece) return
    const half = this.cap >> 1
    // One message never takes more than half of what's kept.
    if (piece.length > half) piece = detach(piece.slice(0, half))
    this.pending.push(piece)
    this.pendingLen += piece.length + 1
    if (this.pendingLen > this.cap) this.fold()
  }

  toString(): string {
    this.fold()
    return this.kept
  }

  private fold(): void {
    if (this.pending.length === 0) return
    const half = this.cap >> 1
    const added = this.pending.join('\n')
    this.pending = []
    this.pendingLen = 0
    let head = this.kept.slice(0, this.headLen)
    let tail: string
    if (this.headLen < half) {
      const all = head ? head + '\n' + added : added
      if (all.length <= half) {
        this.kept = detach(all)
        this.headLen = this.kept.length
        return
      }
      head = all.slice(0, half)
      tail = all.slice(half)
    } else {
      tail = this.kept.slice(this.headLen + (this.gap ? GAP.length : 0)) + '\n' + added
    }
    if (tail.length > half) {
      tail = tail.slice(tail.length - half)
      this.gap = true
    }
    this.headLen = head.length
    this.kept = detach(head + (this.gap ? GAP : '') + tail)
  }
}

/** How far one transcript file has been read. */
interface FileState {
  path: string
  size: number
  mtimeMs: number
  /** Bytes read so far: up to the end of the last complete line. */
  offset: number
  /** The bytes just before `offset`, to tell an appended file from a rewritten one. */
  fingerprint: Buffer
}

/** A session's conversations (earlier ones first) as one capped text, plus its lowercase copy. */
interface Conversation { files: FileState[]; text: CappedText; plain: string; lower: string }

const EMPTY: Pick<Conversation, 'plain' | 'lower'> = { plain: '', lower: '' }

interface Listing { mtimeMs: number; files: string[] }

export class SessionHistory {
  /** Bytes read from transcripts so far (lets tests check that unchanged files aren't read again). */
  bytesRead = 0
  private conversations = new Map<string, Conversation>()
  private indexing = new Map<string, Promise<Conversation | null>>()
  private roots = new Map<string, Listing>()
  private folders = new Map<string, Listing>()
  private warming: Promise<void> | null = null

  constructor(private readonly sources: () => HistorySource[]) {}

  /** Case-insensitive; every term must appear in the title or the conversation. Title hits first, then the latest. */
  async search(query: string, limit = MAX_HITS): Promise<HistoryHit[]> {
    const terms = queryTerms(query)
    const sources = this.sources()
    this.forgetOthers(sources)
    if (terms.length === 0) {
      this.warm(sources)
      return []
    }
    const located = await this.locateAll(sources)
    const hits: HistoryHit[] = []
    for (const src of sources) {
      const s = src.session
      const title = s.title.toLowerCase()
      const conv = await this.conversation(s, located.get(src.configDir))
      if (!terms.every((t) => title.includes(t) || conv.lower.includes(t))) continue
      hits.push({
        sessionId: s.id, title: s.title, archived: src.archived, projectName: src.projectName,
        subProjectName: src.subProjectName, updatedAt: src.updatedAt,
        matchedIn: terms.every((t) => title.includes(t)) ? 'title' : 'conversation',
        snippet: snippet(conv, terms)
      })
    }
    hits.sort((a, b) => Number(a.matchedIn !== 'title') - Number(b.matchedIn !== 'title') || b.updatedAt - a.updatedAt)
    return hits.slice(0, limit)
  }

  /** Characters of conversation text held in memory (the text and its lowercase copy). */
  keptChars(): number {
    let n = 0
    for (const c of this.conversations.values()) n += c.text.size + c.lower.length
    return n
  }

  /** Drops what's kept for sessions that are gone. */
  private forgetOthers(sources: HistorySource[]): void {
    const ids = new Set(sources.map((s) => s.session.id))
    for (const id of this.conversations.keys()) if (!ids.has(id)) this.conversations.delete(id)
  }

  /** Index every transcript in the background, so the first real search is quick. */
  private warm(sources: HistorySource[]): void {
    if (this.warming) return
    this.warming = (async () => {
      const located = await this.locateAll(sources)
      for (const src of sources) await this.conversation(src.session, located.get(src.configDir))
    })().catch(() => {}).finally(() => { this.warming = null })
  }

  private async locateAll(sources: HistorySource[]): Promise<Map<string, Map<string, string[]>>> {
    const out = new Map<string, Map<string, string[]>>()
    const seen = new Set<string>()
    for (const dir of new Set(sources.map((s) => s.configDir))) out.set(dir, await this.locate(dir, seen))
    // Forget listings of folders that are gone.
    for (const cache of [this.roots, this.folders]) for (const k of cache.keys()) if (!seen.has(k)) cache.delete(k)
    return out
  }

  /** `<id>.jsonl` → its paths under every project folder of a config dir. Listings are re-read only when they change. */
  private async locate(configDir: string, seen: Set<string>): Promise<Map<string, string[]>> {
    const root = join(configDir, 'projects')
    seen.add(root)
    const folders = await this.listing(this.roots, root, async () =>
      (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name))
    const byName = new Map<string, string[]>()
    for (const f of folders) {
      const dir = join(root, f)
      seen.add(dir)
      const names = await this.listing(this.folders, dir, async () =>
        (await readdir(dir)).filter((n) => n.endsWith('.jsonl')))
      for (const n of names) {
        const paths = byName.get(n) ?? []
        paths.push(join(dir, n))
        byName.set(n, paths)
      }
    }
    return byName
  }

  private async listing(cache: Map<string, Listing>, dir: string, read: () => Promise<string[]>): Promise<string[]> {
    const st = await stat(dir).catch(() => null)
    if (!st?.isDirectory()) {
      cache.delete(dir)
      return []
    }
    const cur = cache.get(dir)
    if (cur && cur.mtimeMs === st.mtimeMs) return cur.files
    const files = await read().catch(() => [])
    cache.set(dir, { mtimeMs: st.mtimeMs, files })
    return files
  }

  /** All of a session's conversations, earlier ones first, read up to date. Never throws. */
  private async conversation(s: Session, located: Map<string, string[]> | undefined): Promise<Pick<Conversation, 'plain' | 'lower'>> {
    const ids = [...(s.pastClaudeIds ?? []), s.claudeSessionId].filter((x, i, a) => x && a.indexOf(x) === i)
    const paths = ids.flatMap((id) => [...(located?.get(`${id}.jsonl`) ?? [])].sort())
    let running = this.indexing.get(s.id)
    if (!running) {
      running = this.refresh(s.id, paths)
        .catch(() => {
          this.conversations.delete(s.id)
          return null
        })
        .finally(() => { this.indexing.delete(s.id) })
      this.indexing.set(s.id, running)
    }
    return (await running) ?? EMPTY
  }

  /**
   * Reads what changed since the last time: new files, and new lines of the last one read. Anything else (a file
   * rewritten, removed or reordered) reads the session's transcripts again from the start.
   */
  private async refresh(id: string, paths: string[]): Promise<Conversation> {
    const found: { path: string; size: number; mtimeMs: number }[] = []
    for (const path of paths) {
      const st = await stat(path).catch(() => null)
      if (st?.isFile()) found.push({ path, size: st.size, mtimeMs: st.mtimeMs })
    }
    const same = (f: FileState, x: (typeof found)[number]) => f.path === x.path && f.size === x.size && f.mtimeMs === x.mtimeMs
    const cur = this.conversations.get(id)
    if (cur && cur.files.length === found.length && cur.files.every((f, i) => same(f, found[i]))) return cur

    let conv: Conversation | null = null
    let from = 0
    if (cur && cur.files.length <= found.length) {
      const n = cur.files.length
      const kept = cur.files.slice(0, -1).every((f, i) => same(f, found[i]))
      const last = cur.files[n - 1]
      if (kept && (!last || same(last, found[n - 1]))) {
        conv = cur
        from = n
      } else if (kept && last.path === found[n - 1].path && found[n - 1].size >= last.offset && (await this.sameStart(last))) {
        conv = cur
        from = n - 1
      }
    }
    // Drop the entry while it's being updated: a failed read must never leave half-added text behind.
    this.conversations.delete(id)
    if (!conv) conv = { files: [], text: new CappedText(), plain: '', lower: '' }
    for (let i = from; i < found.length; i++) {
      // Let terminal output and IPC through between files: indexing many transcripts must not stall the app.
      await new Promise<void>((resolve) => setImmediate(resolve))
      const prev = conv.files[i]
      const state: FileState = prev?.path === found[i].path
        ? prev
        : { path: found[i].path, size: 0, mtimeMs: 0, offset: 0, fingerprint: Buffer.alloc(0) }
      const fh = await open(state.path, 'r')
      try {
        await this.readLines(fh, state, conv.text, found[i].size)
      } finally {
        await fh.close()
      }
      state.size = found[i].size
      state.mtimeMs = found[i].mtimeMs
      conv.files[i] = state
    }
    conv.files.length = found.length
    const plain = conv.text.toString()
    if (plain !== conv.plain) {
      conv.plain = plain
      conv.lower = plain.toLowerCase()
    }
    this.conversations.set(id, conv)
    return conv
  }

  private async sameStart(f: FileState): Promise<boolean> {
    const n = f.fingerprint.length
    if (n === 0) return f.offset === 0
    const fh = await open(f.path, 'r')
    try {
      const buf = Buffer.alloc(n)
      const { bytesRead } = await fh.read(buf, 0, n, f.offset - n)
      this.bytesRead += bytesRead
      return bytesRead === n && buf.equals(f.fingerprint)
    } finally {
      await fh.close()
    }
  }

  /** Streams complete lines from state.offset to size; a trailing partial line is left for the next read. */
  private async readLines(fh: FileHandle, state: FileState, text: CappedText, size: number): Promise<void> {
    let pos = state.offset
    let pending: Buffer[] = []
    let pendingLen = 0
    let skipping = false
    let lastLineEnd = state.offset
    let before = state.fingerprint // the bytes just before `pos`
    let fingerprint = state.fingerprint // the bytes just before `lastLineEnd`
    while (pos < size) {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK, size - pos))
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos)
      if (bytesRead === 0) break
      this.bytesRead += bytesRead
      const data = chunk.subarray(0, bytesRead)
      let from = 0
      for (let nl = data.indexOf(0x0a); nl >= 0; nl = data.indexOf(0x0a, from)) {
        if (!skipping) {
          const piece = data.subarray(from, nl)
          const line = pendingLen ? Buffer.concat([...pending, piece]) : piece
          const t = bufferText(line)
          if (t) text.add(t)
        }
        pending = []
        pendingLen = 0
        skipping = false
        from = nl + 1
        lastLineEnd = pos + from
      }
      if (from > 0) fingerprint = lastBytes(before, data.subarray(0, from))
      before = lastBytes(before, data)
      if (!skipping && from < data.length) {
        pending.push(data.subarray(from))
        pendingLen += data.length - from
        if (pendingLen > MAX_LINE) {
          pending = []
          pendingLen = 0
          skipping = true
        }
      }
      pos += bytesRead
    }
    // A last line without a newline counts once it's complete JSON; a half-written one is read again next time.
    if (!skipping && pendingLen > 0 && pos >= size) {
      const line = Buffer.concat(pending)
      if (isJson(line)) {
        const t = bufferText(line)
        if (t) text.add(t)
        lastLineEnd = pos
        fingerprint = before
      }
    }
    state.offset = lastLineEnd
    state.fingerprint = fingerprint
  }
}

/** The last FINGERPRINT bytes of a followed by b, copied (never a view that keeps a whole chunk alive). */
function lastBytes(a: Buffer, b: Buffer): Buffer {
  if (b.length >= FINGERPRINT) return Buffer.from(b.subarray(b.length - FINGERPRINT))
  const both = Buffer.concat([a, b])
  return Buffer.from(both.subarray(Math.max(0, both.length - FINGERPRINT)))
}

function isJson(buf: Buffer): boolean {
  try {
    JSON.parse(buf.toString('utf8'))
    return true
  } catch {
    return false
  }
}

function snippet(conv: Pick<Conversation, 'plain' | 'lower'>, terms: string[]): string {
  let at = -1
  let len = 0
  for (const t of terms) {
    const i = conv.lower.indexOf(t)
    if (i >= 0 && (at < 0 || i < at)) {
      at = i
      len = t.length
    }
  }
  if (at < 0) return ''
  const text = conv.plain
  // Lowercasing can change the length of a few characters; find the match in the original text then.
  if (conv.lower.length !== text.length) {
    const term = conv.lower.slice(at, at + len)
    at = text.search(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
    if (at < 0) return ''
  }
  const start = Math.max(0, at - SNIPPET_CONTEXT)
  const end = Math.min(text.length, at + len + SNIPPET_CONTEXT)
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return (start > 0 ? '…' : '') + body + (end < text.length ? '…' : '')
}
