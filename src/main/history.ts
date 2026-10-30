import { open, readdir, stat, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppSnapshot, HistoryHit, Session } from '@shared/types'
import { claudeConfigDir } from './identity'

export type { HistoryHit }

/**
 * Search over Pitwall sessions' titles and their Claude conversations. Reads Claude's transcripts
 * (`<config dir>/projects/<folder>/<conversation id>.jsonl`) and never writes there.
 */

/** Text kept per transcript and per session (characters): the start and the most recent part. */
export const TEXT_CAP = 300_000
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
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))]
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

/** Appended text up to a cap: the first half is kept, and the most recent text fills the second half. */
export class CappedText {
  private head = ''
  private headFull = false
  private tail: string[] = []
  private tailLen = 0
  private gap = false
  private joined: string | null = null

  constructor(private readonly cap = TEXT_CAP) {}

  add(piece: string): void {
    if (!piece) return
    this.joined = null
    const half = this.cap >> 1
    if (!this.headFull) {
      const s = this.head ? '\n' + piece : piece
      if (this.head.length + s.length <= half) {
        this.head += s
        return
      }
      const room = half - this.head.length
      this.head += s.slice(0, room)
      this.headFull = true
      piece = s.slice(room)
    }
    this.tail.push(piece)
    this.tailLen += piece.length + 1
    while (this.tailLen > half && this.tail.length > 1) {
      this.tailLen -= this.tail.shift()!.length + 1
      this.gap = true
    }
  }

  toString(): string {
    if (this.joined !== null) return this.joined
    const half = this.cap >> 1
    let t = this.tail.join('\n')
    let gap = this.gap
    if (t.length > half) {
      t = t.slice(t.length - half)
      gap = true
    }
    this.joined = t ? this.head + (gap ? '\n…\n' : '') + t : this.head
    return this.joined
  }
}

function capText(s: string): string {
  if (s.length <= TEXT_CAP) return s
  const half = TEXT_CAP >> 1
  return s.slice(0, half) + '\n…\n' + s.slice(s.length - half)
}

interface Indexed {
  size: number
  mtimeMs: number
  /** Bytes read so far: up to the end of the last complete line. */
  offset: number
  fingerprint: Buffer
  text: CappedText
  version: number
}

interface Conversation { key: string; text: string; lower: string }

interface Listing { mtimeMs: number; files: string[] }

export class SessionHistory {
  /** Bytes read from transcripts so far (lets tests check that unchanged files aren't read again). */
  bytesRead = 0
  private files = new Map<string, Indexed>()
  private indexing = new Map<string, Promise<Indexed | null>>()
  private conversations = new Map<string, Conversation>()
  private roots = new Map<string, Listing>()
  private folders = new Map<string, Listing>()
  private versions = 0
  private warming: Promise<void> | null = null

  constructor(private readonly sources: () => HistorySource[]) {}

  /** Case-insensitive; every term must appear in the title or the conversation. Title hits first, then the latest. */
  async search(query: string, limit = MAX_HITS): Promise<HistoryHit[]> {
    const terms = queryTerms(query)
    const sources = this.sources()
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
    for (const dir of new Set(sources.map((s) => s.configDir))) out.set(dir, await this.locate(dir))
    return out
  }

  /** `<id>.jsonl` → its paths under every project folder of a config dir. Listings are re-read only when they change. */
  private async locate(configDir: string): Promise<Map<string, string[]>> {
    const root = join(configDir, 'projects')
    const folders = await this.listing(this.roots, root, async () =>
      (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name))
    const byName = new Map<string, string[]>()
    for (const f of folders) {
      const dir = join(root, f)
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

  /** All of a session's conversations (earlier ones first), as one capped text. */
  private async conversation(s: Session, located: Map<string, string[]> | undefined): Promise<Conversation> {
    const ids = [...(s.pastClaudeIds ?? []), s.claudeSessionId].filter((x, i, a) => x && a.indexOf(x) === i)
    const files: Indexed[] = []
    for (const id of ids) {
      for (const p of located?.get(`${id}.jsonl`) ?? []) {
        const f = await this.index(p)
        if (f) files.push(f)
      }
    }
    const key = files.map((f) => f.version).join(',')
    const cached = this.conversations.get(s.id)
    if (cached?.key === key) return cached
    const text = files.length === 1
      ? files[0].text.toString()
      : capText(files.map((f) => f.text.toString()).filter(Boolean).join('\n'))
    const conv = { key, text, lower: text.toLowerCase() }
    this.conversations.set(s.id, conv)
    return conv
  }

  /** One transcript's text, cached by size and mtime; an appended file is read from where the last read stopped. */
  private index(path: string): Promise<Indexed | null> {
    const running = this.indexing.get(path)
    if (running) return running
    const p = this.refresh(path)
      .catch(() => {
        this.files.delete(path)
        return null
      })
      .finally(() => { this.indexing.delete(path) })
    this.indexing.set(path, p)
    return p
  }

  private async refresh(path: string): Promise<Indexed | null> {
    const st = await stat(path).catch(() => null)
    if (!st?.isFile()) {
      this.files.delete(path)
      return null
    }
    const cur = this.files.get(path)
    if (cur && cur.size === st.size && cur.mtimeMs === st.mtimeMs) return cur
    const fh = await open(path, 'r')
    try {
      const appended = cur && st.size >= cur.offset && (await this.sameStart(fh, cur)) ? cur : null
      // Drop the entry while it's being updated: a failed read must never leave half-added text behind.
      this.files.delete(path)
      const entry: Indexed = appended ?? {
        size: 0, mtimeMs: 0, offset: 0, fingerprint: Buffer.alloc(0), text: new CappedText(), version: 0
      }
      await this.readLines(fh, entry, st.size)
      entry.size = st.size
      entry.mtimeMs = st.mtimeMs
      entry.version = ++this.versions
      this.files.set(path, entry)
      return entry
    } finally {
      await fh.close()
    }
  }

  private async sameStart(fh: FileHandle, cur: Indexed): Promise<boolean> {
    const n = cur.fingerprint.length
    if (n === 0) return cur.offset === 0
    const buf = Buffer.alloc(n)
    const { bytesRead } = await fh.read(buf, 0, n, cur.offset - n)
    this.bytesRead += bytesRead
    return bytesRead === n && buf.equals(cur.fingerprint)
  }

  /** Streams complete lines from entry.offset to size; a trailing partial line is left for the next read. */
  private async readLines(fh: FileHandle, entry: Indexed, size: number): Promise<void> {
    let pos = entry.offset
    let pending: Buffer[] = []
    let pendingLen = 0
    let skipping = false
    let lastLineEnd = entry.offset
    let before = entry.fingerprint // the bytes just before `pos`
    let fingerprint = entry.fingerprint // the bytes just before `lastLineEnd`
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
          if (t) entry.text.add(t)
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
        if (t) entry.text.add(t)
        lastLineEnd = pos
        fingerprint = before
      }
    }
    entry.offset = lastLineEnd
    entry.fingerprint = fingerprint
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

function snippet(conv: Conversation, terms: string[]): string {
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
  const { text } = conv
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
