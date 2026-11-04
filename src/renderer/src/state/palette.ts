// The command palette's data: fuzzy ranking, result groups and the actions it offers. Pure (no DOM, no store).
import { nextAttention, sidebarOrder } from '@shared/runtime'
import type { AppSnapshot, FileEntry, HistoryHit, SessionView } from '@shared/types'
import { shortcut } from '../platform'

/** ⌘K searches everything; ⌘P only the active session's files. */
export type PaletteMode = 'commands' | 'files'
export type ItemKind = 'session' | 'action' | 'file' | 'history'

export type ActionId =
  | 'new-session' | 'archive' | 'mark-unread' | 'mute' | 'unmute' | 'close-pane' | 'open-in-cursor'
  | 'show-files' | 'show-changes' | 'archived' | 'next-attention' | 'settings' | 'check-updates' | 'sounds-on' | 'sounds-off'

export interface PaletteAction {
  key: string; id: ActionId; label: string
  detail?: string; shortcut?: string
  /** Other words that find it. */
  keywords?: string
  /** Offered before anything is typed. */
  common?: boolean
  sessionId?: string; subProjectId?: string; projectId?: string
}

export interface ActionContext {
  snap: Pick<AppSnapshot, 'projects' | 'subProjects' | 'sessions' | 'archived' | 'settings'>
  activeSessionId: string | null
  paneCount: number
  rightTab: 'files' | 'changes'
  /** False when this build doesn't look for updates. */
  canCheckUpdates: boolean
  /** Default: this app's (shortcut labels say ⌘ on macOS, Ctrl+ on Windows). */
  platform?: string
}

interface ItemBase { key: string; label: string; detail?: string; labelHits: number[]; detailHits?: number[] }
export type PaletteItem =
  | ItemBase & { kind: 'session'; session: SessionView }
  | ItemBase & { kind: 'action'; action: PaletteAction }
  | ItemBase & { kind: 'file'; path: string }
  | ItemBase & { kind: 'history'; hit: HistoryHit }
export interface PaletteGroup { kind: ItemKind; title: string; items: PaletteItem[] }

export interface PaletteInput {
  mode: PaletteMode
  query: string
  snap: Pick<AppSnapshot, 'projects' | 'subProjects' | 'sessions' | 'archived'>
  activeSessionId: string | null
  actions: PaletteAction[]
  /** The active session's files; null while loading or with no session. */
  files: FileEntry[] | null
  /** searchSessions results and the query they answer; ignored once the query has changed. */
  history: { query: string; hits: HistoryHit[] } | null
}

/** Past sessions are searched from this many characters on. */
export const MIN_HISTORY_QUERY = 2
const CAP = { session: 8, action: 8, file: 8, fileOnly: 50, history: 8 }

// ---- fuzzy matching (fzf-style scoring) ----------------------------------------

const SCORE_MATCH = 16
const GAP_START = -3
const GAP_EXTENSION = -1
const BONUS_WHITE = 10 // after a space, or the very first letter
const BONUS_DELIMITER = 9 // after '/' or ':'
const BONUS_BOUNDARY = 8 // after other punctuation: - _ . etc.
const BONUS_CAMEL = 7 // fooBar, foo2
const BONUS_CONSECUTIVE = 4
const FIRST_CHAR_MULTIPLIER = 2

type CharClass = 0 | 1 | 2 | 3 | 4 | 5 // white, delimiter, other punctuation, lower, upper, digit
function classAt(text: string, j: number): CharClass {
  const c = text.charCodeAt(j)
  if (c >= 97 && c <= 122) return 3
  if (c >= 65 && c <= 90) return 4
  if (c >= 48 && c <= 57) return 5
  if (c === 32 || c === 9 || c === 10) return 0
  if (c === 47 || c === 58) return 1 // / :
  if (c < 128) return 2
  const ch = text[j]
  return ch.toLowerCase() !== ch.toUpperCase() ? 3 : 2 // other letters count as lower case
}
function bonusAt(text: string, j: number): number {
  const cur = classAt(text, j)
  const prev: CharClass = j === 0 ? 0 : classAt(text, j - 1)
  if (cur <= 2) return BONUS_BOUNDARY // punctuation typed on purpose
  if (prev === 0) return BONUS_WHITE
  if (prev === 1) return BONUS_DELIMITER
  if (prev === 2) return BONUS_BOUNDARY
  if ((prev === 3 && cur === 4) || (prev !== 5 && cur === 5)) return BONUS_CAMEL
  return 0
}

const NONE = -Infinity
// Scratch space reused by every match (ranking thousands of paths must not allocate per path).
let SCORE = new Float64Array(4096)
let RUN = new Float64Array(4096)
let FROM = new Int32Array(4096)
let BONUS = new Float64Array(512)

/**
 * Best placement of one lower-case word in the text: score, and the matched positions when asked for.
 * Null when its letters aren't all there in order.
 */
function matchTerm(term: string, text: string, lower: string, withPositions: boolean): { score: number; positions: number[] } | null {
  const n = term.length
  const m = lower.length
  // quick reject; also finds where the earliest match starts (columns before it can't take part)
  let first = -1
  let i0 = 0
  for (let j = 0; j < m && i0 < n; j++) {
    if (lower.charCodeAt(j) !== term.charCodeAt(i0)) continue
    if (i0 === 0) first = j
    i0++
  }
  if (i0 < n) return null
  const w = m - first
  const size = n * w
  if (SCORE.length < size) {
    const len = Math.max(size, SCORE.length * 2)
    SCORE = new Float64Array(len); RUN = new Float64Array(len); FROM = new Int32Array(len)
  }
  if (BONUS.length < w) BONUS = new Float64Array(Math.max(w, BONUS.length * 2))
  // score[i*w+k]: best score with term[i] at text[first+k]; run: the bonus of the consecutive chunk ending there.
  const score = SCORE, run = RUN, from = FROM, bonus = BONUS
  score.fill(NONE, 0, size)
  for (let k = 0; k < w; k++) bonus[k] = bonusAt(text, first + k)
  const c0 = term.charCodeAt(0)
  for (let k = 0; k < w; k++) {
    if (lower.charCodeAt(first + k) !== c0) continue
    score[k] = SCORE_MATCH + bonus[k] * FIRST_CHAR_MULTIPLIER
    run[k] = bonus[k]
  }
  for (let i = 1; i < n; i++) {
    const row = i * w
    const prevRow = row - w
    const ci = term.charCodeAt(i)
    // best earlier placement of term[i-1] that leaves a gap before k, with the gap's penalty already applied
    let gapBest = NONE
    let gapFrom = -1
    for (let k = i; k < w; k++) {
      if (k >= 2) {
        const extended = gapBest + GAP_EXTENSION
        const opened = score[prevRow + k - 2] + GAP_START
        if (opened >= extended) { gapBest = opened; gapFrom = k - 2 } else gapBest = extended
      }
      if (lower.charCodeAt(first + k) !== ci) continue
      let best = NONE
      let bestRun = 0
      let bestFrom = -1
      const diag = score[prevRow + k - 1]
      if (diag !== NONE) {
        const chunk = bonus[k] >= BONUS_BOUNDARY
        best = diag + SCORE_MATCH + (chunk ? bonus[k] : Math.max(bonus[k], BONUS_CONSECUTIVE, run[prevRow + k - 1]))
        bestRun = chunk ? bonus[k] : Math.max(run[prevRow + k - 1], BONUS_CONSECUTIVE)
        bestFrom = k - 1
      }
      if (gapBest !== NONE && gapBest + SCORE_MATCH + bonus[k] > best) {
        best = gapBest + SCORE_MATCH + bonus[k]
        bestRun = bonus[k]
        bestFrom = gapFrom
      }
      score[row + k] = best
      run[row + k] = bestRun
      from[row + k] = bestFrom
    }
  }
  const last = (n - 1) * w
  let end = -1
  for (let k = 0; k < w; k++) if (score[last + k] !== NONE && (end < 0 || score[last + k] > score[last + end])) end = k
  if (end < 0) return null
  const positions: number[] = []
  if (withPositions) {
    for (let i = n - 1, k = end; i >= 0; i--) { positions[i] = first + k; k = from[i * w + k] }
  }
  return { score: score[last + end], positions }
}

const termsOf = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean)

function matchTerms(terms: string[], text: string, withPositions: boolean): { score: number; positions: number[] } | null {
  let lower = text.toLowerCase()
  // A few characters change length in lower case; then score the lower-case text so positions line up.
  if (lower.length !== text.length) text = lower
  let total = 0
  const hits = new Set<number>()
  for (const t of terms) {
    const m = matchTerm(t, text, lower, withPositions)
    if (!m) return null
    total += m.score
    for (const p of m.positions) hits.add(p)
  }
  return { score: total, positions: [...hits].sort((a, b) => a - b) }
}

/**
 * Fuzzy match: every word of the query must appear in the text with its letters in order. Word starts and
 * consecutive letters score higher. Null when it doesn't match; an empty query matches with score 0.
 */
export function fuzzyMatch(query: string, text: string): { score: number; positions: number[] } | null {
  return matchTerms(termsOf(query), text, true)
}

// ---- results ------------------------------------------------------------------

const recency = (s: SessionView): number => Math.max(s.lastViewedAt ?? 0, s.lastActivityAt ?? 0, s.createdAt)
const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
const dirname = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
/** A match in the file name itself is worth this much more than one spread over the folders. */
const BASENAME_BONUS = 24

function placeOf(snap: PaletteInput['snap'], subProjectId: string): string {
  const sp = snap.subProjects.find((x) => x.id === subProjectId)
  const p = sp && snap.projects.find((x) => x.id === sp.projectId)
  return [p?.name, sp?.name].filter(Boolean).join(' · ')
}

function sessionItems(input: PaletteInput, q: string): PaletteItem[] {
  const item = (s: SessionView, hits: number[]): PaletteItem =>
    ({ kind: 'session', key: `session:${s.id}`, label: s.title, detail: placeOf(input.snap, s.subProjectId), labelHits: hits, session: s })
  if (!q) {
    return input.snap.sessions.filter((s) => s.id !== input.activeSessionId)
      .sort((a, b) => recency(b) - recency(a)).slice(0, CAP.session).map((s) => item(s, []))
  }
  return input.snap.sessions
    .flatMap((s) => { const m = fuzzyMatch(q, s.title); return m ? [{ s, m }] : [] })
    .sort((a, b) => b.m.score - a.m.score || recency(b.s) - recency(a.s))
    .slice(0, CAP.session).map(({ s, m }) => item(s, m.positions))
}

/** Every word of the query starts a word of the label or keywords: "pref" finds Settings, "in" doesn't find "diff". */
function keywordScore(q: string, a: PaletteAction): number | null {
  const words = `${a.label} ${a.keywords ?? ''}`.toLowerCase().split(/[^\p{L}\p{N}]+/u)
  let total = 0
  for (const t of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (!words.some((w) => w.startsWith(t))) return null
    total += (t.length * SCORE_MATCH) / 2
  }
  return total
}

function actionItems(input: PaletteInput, q: string): PaletteItem[] {
  const item = (a: PaletteAction, hits: number[]): PaletteItem =>
    ({ kind: 'action', key: `action:${a.key}`, label: a.label, detail: a.detail, labelHits: hits, action: a })
  if (!q) return input.actions.filter((a) => a.common).slice(0, CAP.action).map((a) => item(a, []))
  return input.actions
    .flatMap((a, order) => {
      const m = fuzzyMatch(q, a.label)
      if (m) return [{ a, order, score: m.score, hits: m.positions }]
      const k = keywordScore(q, a)
      return k === null ? [] : [{ a, order, score: k, hits: [] }]
    })
    .sort((x, y) => y.score - x.score || x.order - y.order)
    .slice(0, CAP.action).map(({ a, hits }) => item(a, hits))
}

function fileItems(files: FileEntry[], q: string, cap: number): PaletteItem[] {
  const item = (path: string, hits: number[]): PaletteItem => {
    const dir = dirname(path)
    const offset = dir ? dir.length + 1 : 0
    return {
      kind: 'file', key: `file:${path}`, path, label: basename(path), detail: dir,
      labelHits: hits.filter((h) => h >= offset).map((h) => h - offset), detailHits: hits.filter((h) => h < offset)
    }
  }
  if (!q) {
    const changed = files.filter((f) => f.status)
    return [...changed, ...files.filter((f) => !f.status)].slice(0, cap).map((f) => item(f.path, []))
  }
  const terms = termsOf(q)
  const scored: { path: string; score: number; inName: boolean }[] = []
  for (const f of files) {
    const whole = matchTerms(terms, f.path, false)
    if (!whole) continue
    const name = basename(f.path)
    const inName = name.length === f.path.length ? whole : matchTerms(terms, name, false)
    if (inName && inName.score + BASENAME_BONUS >= whole.score) scored.push({ path: f.path, score: inName.score + BASENAME_BONUS, inName: true })
    else scored.push({ path: f.path, score: whole.score, inName: false })
  }
  return scored
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, cap)
    .map((s) => {
      // match positions only for the files shown
      const offset = s.inName ? s.path.length - basename(s.path).length : 0
      const hits = matchTerms(terms, s.inName ? s.path.slice(offset) : s.path, true)?.positions ?? []
      return item(s.path, hits.map((h) => h + offset))
    })
}

// Ranking thousands of paths is the slow part, and the same files and query always rank the same.
let fileCache: { files: FileEntry[]; q: string; cap: number; items: PaletteItem[] } | null = null
function rankedFiles(files: FileEntry[], q: string, cap: number): PaletteItem[] {
  if (fileCache && fileCache.files === files && fileCache.q === q && fileCache.cap === cap) return fileCache.items
  const items = fileItems(files, q, cap)
  fileCache = { files, q, cap, items }
  return items
}

function historyItems(input: PaletteInput, q: string, listed: Set<string>): PaletteItem[] {
  // Hits for an earlier query must never be offered (Enter would open the wrong one).
  if (q.length < MIN_HISTORY_QUERY || !input.history || input.history.query.trim() !== q) return []
  return input.history.hits.filter((h) => !listed.has(h.sessionId)).slice(0, CAP.history).map((h) => ({
    kind: 'history', key: `history:${h.sessionId}`, label: h.title,
    detail: [h.projectName, h.subProjectName].filter(Boolean).join(' · '),
    labelHits: h.matchedIn === 'title' ? fuzzyMatch(q, h.title)?.positions ?? [] : [], hit: h
  }))
}

/** Grouped results, in order: Sessions, Actions, Files, Past sessions. Empty groups are left out. */
export function paletteResults(input: PaletteInput): PaletteGroup[] {
  const q = input.query.trim()
  if (input.mode === 'files') {
    const files = input.files ? rankedFiles(input.files, q, CAP.fileOnly) : []
    return files.length ? [{ kind: 'file', title: 'Files', items: files }] : []
  }
  const sessions = sessionItems(input, q)
  const groups: PaletteGroup[] = [
    { kind: 'session', title: 'Sessions', items: sessions },
    { kind: 'action', title: 'Actions', items: actionItems(input, q) },
    { kind: 'file', title: 'Files', items: q && input.files ? rankedFiles(input.files, q, CAP.file) : [] },
    {
      kind: 'history', title: 'Past sessions',
      items: historyItems(input, q, new Set(sessions.map((i) => (i.kind === 'session' ? i.session.id : ''))))
    }
  ]
  return groups.filter((g) => g.items.length > 0)
}

// ---- actions ------------------------------------------------------------------

/** What the palette can do right now; each action only when it applies. */
export function paletteActions(ctx: ActionContext): PaletteAction[] {
  const { snap } = ctx
  const s = snap.sessions.find((x) => x.id === ctx.activeSessionId)
  const sp = s && snap.subProjects.find((x) => x.id === s.subProjectId)
  const project = sp && snap.projects.find((x) => x.id === sp.projectId)
  const out: PaletteAction[] = []

  const folders = [...snap.subProjects].sort((a, b) =>
    Number(b.id === sp?.id) - Number(a.id === sp?.id) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  for (const f of folders) {
    const mine = f.id === sp?.id
    out.push({
      key: `new-session:${f.id}`, id: 'new-session', label: `New session in ${f.name}…`, subProjectId: f.id,
      detail: snap.projects.find((p) => p.id === f.projectId)?.name, shortcut: mine ? shortcut('N', ctx.platform) : undefined,
      keywords: 'start create agent', common: mine || snap.subProjects.length === 1
    })
  }
  if (s) {
    out.push({ key: 'archive', id: 'archive', label: 'Archive session…', detail: s.title, sessionId: s.id, keywords: 'close remove delete', common: true })
    if (s.status === 'read') out.push({ key: 'mark-unread', id: 'mark-unread', label: 'Mark as unread', detail: s.title, sessionId: s.id })
    if (project) {
      out.push(project.muted
        ? { key: 'unmute', id: 'unmute', label: `Unmute notifications from ${project.name}`, projectId: project.id, keywords: 'project sound' }
        : { key: 'mute', id: 'mute', label: `Mute notifications from ${project.name}`, projectId: project.id, keywords: 'project silence quiet' })
    }
    out.push({ key: 'open-in-cursor', id: 'open-in-cursor', label: 'Open in Cursor', detail: s.title, sessionId: s.id, keywords: 'editor ide' })
    const changes = ctx.rightTab === 'changes' && sp?.kind === 'repo'
    if (changes) out.push({ key: 'show-files', id: 'show-files', label: 'Show Files', keywords: 'tree browse panel' })
    if (!changes && sp?.kind === 'repo') out.push({ key: 'show-changes', id: 'show-changes', label: 'Show Changes', keywords: 'diff git panel' })
  }
  if (ctx.paneCount > 1) out.push({ key: 'close-pane', id: 'close-pane', label: 'Close pane', keywords: 'split' })
  if (snap.archived.length > 0) {
    out.push({ key: 'archived', id: 'archived', label: 'Archived sessions', keywords: 'history resume past', common: true })
  }
  if (nextAttention(sidebarOrder(snap), ctx.activeSessionId)) {
    out.push({ key: 'next-attention', id: 'next-attention', label: 'Next session that needs you', shortcut: shortcut('J', ctx.platform), keywords: 'unread waiting', common: true })
  }
  out.push({ key: 'settings', id: 'settings', label: 'Settings…', shortcut: shortcut(',', ctx.platform), keywords: 'preferences font', common: true })
  const when = 'When a session needs you or finishes'
  out.push(snap.settings.sounds
    ? { key: 'sounds-off', id: 'sounds-off', label: 'Turn sounds off', detail: when, keywords: 'mute quiet silence chime audio notification' }
    : { key: 'sounds-on', id: 'sounds-on', label: 'Turn sounds on', detail: when, keywords: 'chime audio alert notification' })
  if (ctx.canCheckUpdates) out.push({ key: 'check-updates', id: 'check-updates', label: 'Check for updates', keywords: 'version release upgrade' })
  return out
}
