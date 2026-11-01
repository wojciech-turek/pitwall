import { open, readdir, stat, type FileHandle } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'
import type { OutsideConversation } from '@shared/types'
import { lineText } from './history'

export type { OutsideConversation }

/**
 * The Claude conversations run in a folder outside Pitwall (with plain `claude`), found from Claude's transcripts
 * (`<config dir>/projects/<folder>/<conversation id>.jsonl`). Reads only the start and the end of each transcript,
 * and never writes there.
 */

const LIMIT = 200
/** Bytes read from the start of a transcript (its cwd and first messages) and from its end (its title and branch). */
const HEAD = 256 * 1024
const TAIL = 64 * 1024
const MAX_TITLE = 120
/** A Claude conversation id (a UUID), as its transcript is named. */
export const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The name of the folder Claude keeps a cwd's transcripts in, under `projects/`. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

/**
 * The conversations started in `folder` or a folder inside it (not in a Pitwall worktree), newest first, up to
 * `limit`; `truncated` when transcripts were left unread.
 */
export async function listOutsideConversations(o: {
  configDir: string; folder: string; exclude: ReadonlySet<string>; worktreesRoot: string
  platform?: NodeJS.Platform; limit?: number
}): Promise<{ items: OutsideConversation[]; truncated: boolean }> {
  const platform = o.platform ?? process.platform
  const limit = o.limit ?? LIMIT
  const files = await candidates(join(o.configDir, 'projects'), o.folder, o.exclude, platform)
  const items: OutsideConversation[] = []
  const ids = new Set<string>()
  let i = 0
  for (; i < files.length && items.length < limit; i++) {
    const f = files[i]
    // The same conversation kept in two folders: the newest copy.
    if (ids.has(f.claudeId)) continue
    const item = await examine(f, o.folder, o.worktreesRoot, platform).catch(() => null)
    if (!item) continue
    items.push(item)
    ids.add(f.claudeId)
  }
  return { items, truncated: i < files.length }
}

interface Candidate { claudeId: string; path: string; mtimeMs: number; size: number }

/**
 * `<id>.jsonl` files right inside the project folders of `folder` and of the folders inside it, newest first. Those
 * names also cover siblings that share the prefix (`/x/repo-old` → `-x-repo-old`); their recorded cwd rules them out.
 */
async function candidates(root: string, folder: string, exclude: ReadonlySet<string>, platform: NodeJS.Platform): Promise<Candidate[]> {
  const fold = (s: string): string => (platform === 'win32' ? s.toLowerCase() : s)
  const name = fold(claudeProjectDirName(folder))
  const dirs = (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory() && (fold(e.name) === name || fold(e.name).startsWith(name + '-')))
  const out: Candidate[] = []
  for (const d of dirs) {
    const dir = join(root, d.name)
    for (const f of await readdir(dir).catch(() => [])) {
      const claudeId = f.slice(0, -'.jsonl'.length)
      if (!f.endsWith('.jsonl') || !CONVERSATION_ID.test(claudeId) || exclude.has(claudeId)) continue
      const path = join(dir, f)
      const st = await stat(path).catch(() => null)
      if (st?.isFile()) out.push({ claudeId, path, mtimeMs: st.mtimeMs, size: st.size })
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** One transcript as a conversation of `folder`, or null if it isn't one (or isn't a conversation to continue). */
async function examine(f: Candidate, folder: string, worktreesRoot: string, platform: NodeJS.Platform): Promise<OutsideConversation | null> {
  const fh = await open(f.path, 'r')
  const seen: Seen = {}
  try {
    const whole = f.size <= HEAD + TAIL
    for (const line of await linesBetween(fh, 0, whole ? f.size : HEAD, !whole)) note(seen, line)
    if (!seen.cwd || !within(seen.cwd, folder, platform) || within(seen.cwd, worktreesRoot, platform)) return null
    if (!whole) for (const line of await linesBetween(fh, f.size - TAIL, f.size, false)) note(seen, line)
  } finally {
    await fh.close()
  }
  const title = oneLine(seen.customTitle) || oneLine(seen.claudeTitle) || oneLine(seen.firstText)
  // Something typed, or Claude's title (it titles only from what was typed): big attachment lines can push a
  // conversation's messages past the head.
  if (seen.sidechain || !(seen.firstText || seen.claudeTitle) || !title) return null
  const item: OutsideConversation = { claudeId: f.claudeId, title, cwd: seen.cwd, updatedAt: f.mtimeMs, transcriptPath: f.path }
  if (seen.branch && seen.branch !== 'HEAD') item.branch = seen.branch
  return item
}

/** The complete lines in bytes [from, to) of a file: a line cut off at the start, or at the end if `cutEnd`, is left out. */
async function linesBetween(fh: FileHandle, from: number, to: number, cutEnd: boolean): Promise<string[]> {
  const buf = Buffer.alloc(Math.max(0, to - from))
  const { bytesRead } = await fh.read(buf, 0, buf.length, from)
  const data = buf.subarray(0, bytesRead)
  const start = from > 0 ? data.indexOf(0x0a) + 1 : 0
  if (from > 0 && start === 0) return []
  const end = cutEnd ? data.lastIndexOf(0x0a) : data.length
  return end > start ? data.toString('utf8', start, end).split('\n') : []
}

/** What a transcript's lines tell, in order. */
interface Seen {
  /** The first cwd recorded: where the conversation was started. */
  cwd?: string
  /** Whether the first user or assistant line is a subagent's. */
  sidechain?: boolean
  /** The latest name given with /rename. */
  customTitle?: string
  /** Claude's latest title for the conversation (`ai-title`; older versions wrote a `summary`). */
  claudeTitle?: string
  /** The first message the user typed (not a /command or meta). */
  firstText?: string
  /** The latest git branch recorded. */
  branch?: string
}

function note(seen: Seen, line: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
  const r = parsed as Record<string, unknown>
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
  seen.cwd ??= str(r.cwd)
  seen.branch = str(r.gitBranch) ?? seen.branch
  if (r.type === 'custom-title') seen.customTitle = str(r.customTitle) ?? seen.customTitle
  else if (r.type === 'ai-title') seen.claudeTitle = str(r.aiTitle) ?? seen.claudeTitle
  else if (r.type === 'summary') seen.claudeTitle = str(r.summary) ?? seen.claudeTitle
  else if (r.type === 'user' || r.type === 'assistant') {
    seen.sidechain ??= r.isSidechain === true
    if (r.type === 'user') seen.firstText ??= str(lineText(line))
  }
}

/** Whether `p` is `root` or a folder inside it, compared as paths of `platform`. */
function within(p: string, root: string, platform: NodeJS.Platform): boolean {
  const path = platform === 'win32' ? win32 : posix
  const rel = path.relative(root, p)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}

/** Collapsed to one line of at most MAX_TITLE characters. */
function oneLine(s: string | undefined): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  if (t.length <= MAX_TITLE) return t
  let cut = t.slice(0, MAX_TITLE - 1)
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1) // never half an emoji
  return cut.trimEnd() + '…'
}
