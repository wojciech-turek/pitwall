import { writeFileAtomic } from '../atomic'
import { join } from 'node:path'
import { countStatuses, displayStatus, initialRuntime, reduceRuntime } from '@shared/runtime'
import type {
  AppSnapshot, ConversationList, ConversationMatch, DisplayStatus, HookEvent, NewSessionDefaults, NewSessionInput, Session,
  SessionRuntime, SessionView, StartProgress, StartResult, TermKind
} from '@shared/types'
import { isFile } from '../exec'
import { historySources, SessionHistory } from '../history'
import { appendEvent, EventTailer } from '../hooks/events'
import type { Notifier } from '../notifier'
import { eventsFile, sessionDir } from '../paths'
import { shellTabArgv } from '../platform'
import { claudeTmuxName, shellTmuxName } from '../tmux'
import { Conversations } from './continue'
import { isAnswerInput } from './input'
import { notificationBody } from './notify-text'
import { resumeSession } from './resume'
import {
  assertSessionFolder, launchTmuxFor, prepareNewSession, startSession, usesHostLauncher, writeSessionFiles, type StarterDeps
} from './starter'

type Deps = StarterDeps & {
  notifier: Notifier; now?: () => number; firstEventTimeoutMs?: number
  /** Searches the folders' conversations; default: one of its own over this manager's sessions. */
  history?: Pick<SessionHistory, 'search' | 'searchFiles'>
}
type Extras = Partial<Pick<SessionView, 'diffStat' | 'liveBranch'>>

const FIRST_EVENT_TIMEOUT_MS = 20000
export const START_WARNING =
  'Claude hasn\'t reported in yet. If it\'s asking whether to trust this folder, choose "Yes, I trust this folder" — ' +
  'the default is "No, exit".'

interface Tracked {
  rt: SessionRuntime
  tailer: EventTailer
  viewedAt: number
  inputSent: boolean
}

const PERSIST_DEBOUNCE_MS = 250

/** `past` plus every id in `seen` (oldest first) except the last, the current one; no duplicates. */
function pastIds(past: string[], seen: string[]): string[] {
  const current = seen.at(-1)
  const out: string[] = []
  for (const x of [...past, ...seen.slice(0, -1)]) if (x && x !== current && !out.includes(x)) out.push(x)
  return out
}

export class SessionManager {
  private tracked = new Map<string, Tracked>()
  private tracking = new Map<string, Promise<void>>()
  private extras = new Map<string, Extras>()
  private clearing = new Set<string>()
  private warnings = new Map<string, string>()
  private errors = new Map<string, string>()
  private snapshotCbs = new Set<(s: AppSnapshot) => void>()
  private eventCbs = new Set<(id: string, ev: HookEvent) => void>()
  private waiters = new Map<string, Set<() => void>>()
  private persistTimers = new Map<string, NodeJS.Timeout>()
  private publishTimer: NodeJS.Timeout | null = null
  private unsubStore: (() => void) | null = null
  private viewing: { ids: Set<string>; focused: boolean } = { ids: new Set(), focused: false }
  private disposed = false
  private readonly now: () => number
  private readonly conversations: Conversations

  constructor(private deps: Deps) {
    this.now = deps.now ?? Date.now
    const history = deps.history ?? new SessionHistory(() => historySources(this.snapshot(), deps.home, deps.env))
    this.conversations = new Conversations({ ...deps, history, now: this.now })
  }

  async init(): Promise<void> {
    this.unsubStore = this.deps.store.onChange(() => {
      this.updateBadge() // a project may have been muted or unmuted
      this.publish()
    })
    for (const s of this.active()) {
      try {
        await this.track(s.id)
        await this.refreshSessionFiles(s.id)
        await this.relaunchIfMissing(s)
      } catch (e) {
        // One broken session must not block the rest; the error shows on that session.
        this.errors.set(s.id, e instanceof Error ? e.message : String(e))
      }
    }
    this.updateBadge()
    this.publish()
  }

  dispose(): void {
    this.disposed = true
    this.unsubStore?.()
    for (const t of this.tracked.values()) t.tailer.stop()
    for (const [id, timer] of this.persistTimers) {
      clearTimeout(timer)
      this.persistViewed(id)
    }
    this.persistTimers.clear()
    if (this.publishTimer) clearTimeout(this.publishTimer)
    this.publishTimer = null
    for (const set of this.waiters.values()) for (const w of [...set]) w()
  }

  // ---- queries -----------------------------------------------------------

  snapshot(): AppSnapshot {
    const st = this.deps.store.state
    const sessions: SessionView[] = this.active().map((s) => {
      const t = this.tracked.get(s.id)
      const rt = t?.rt ?? initialRuntime
      const view: SessionView = {
        ...s,
        lastViewedAt: t?.viewedAt ?? s.lastViewedAt,
        status: this.statusOf(s.id),
        ...this.extras.get(s.id)
      }
      if (rt.needsInput) view.needsInput = rt.needsInput
      if (rt.activity === 'exited' && rt.exitCode !== undefined) view.exitCode = rt.exitCode
      if (rt.lastEventAt) view.lastActivityAt = rt.lastEventAt
      const lastError = rt.lastError ?? this.errors.get(s.id)
      if (lastError) view.lastError = lastError
      const warning = this.warnings.get(s.id)
      if (warning) view.startWarning = warning
      if (rt.warnings) view.launchWarnings = Object.values(rt.warnings)
      return view
    })
    return {
      projects: st.projects, subProjects: st.subProjects, sessions,
      archived: st.sessions.filter((s) => s.archivedAt !== undefined), settings: st.settings
    }
  }

  onSnapshot(cb: (s: AppSnapshot) => void): () => void {
    this.snapshotCbs.add(cb)
    return () => { this.snapshotCbs.delete(cb) }
  }

  onSessionEvent(cb: (sessionId: string, ev: HookEvent) => void): () => void {
    this.eventCbs.add(cb)
    return () => { this.eventCbs.delete(cb) }
  }

  // ---- commands ----------------------------------------------------------

  prepareNew(subProjectId: string): Promise<NewSessionDefaults> {
    return prepareNewSession(subProjectId, this.deps)
  }

  async start(input: NewSessionInput, onProgress: (p: StartProgress) => void): Promise<StartResult> {
    return this.started(await startSession(input, this.deps, onProgress))
  }

  /** A folder's archived sessions and the Claude conversations run there outside Pitwall, newest first. */
  listConversations(subProjectId: string): Promise<ConversationList> {
    return this.conversations.list(subProjectId)
  }

  /** The folder's conversations whose title or text has every word of the query: title matches first, then the newest. */
  searchConversations(subProjectId: string, query: string): Promise<ConversationMatch[]> {
    return this.conversations.search(subProjectId, query)
  }

  /** Starts a session in the folder that continues a conversation run there outside Pitwall. */
  async continueConversation(
    subProjectId: string, claudeId: string, requestId: string, onProgress: (p: StartProgress) => void
  ): Promise<StartResult> {
    return this.started(await this.conversations.continue(subProjectId, claudeId, requestId, onProgress))
  }

  /** Brings an archived session back and tracks it like a newly started one. */
  async resume(sessionId: string, requestId: string, onProgress: (p: StartProgress) => void): Promise<StartResult> {
    const res = await resumeSession(sessionId, requestId, this.deps, onProgress)
    if (res.ok) {
      this.errors.delete(sessionId)
      await this.track(sessionId)
      this.publish()
      void this.warnIfSilent(sessionId)
    }
    return res
  }

  async rename(sessionId: string, title: string): Promise<void> {
    await this.deps.store.update((d) => {
      const s = d.sessions.find((x) => x.id === sessionId)
      if (s) s.title = title
    })
  }

  setViewing(sessionIds: string[], windowFocused: boolean): void {
    this.viewing = { ids: new Set(sessionIds), focused: windowFocused }
    if (windowFocused) for (const id of this.viewing.ids) this.markViewed(id)
    this.publish()
  }

  /** Show a read session as unread until the user opens it. */
  async markUnread(sessionId: string): Promise<void> {
    const s = this.session(sessionId)
    if (!s || s.archivedAt !== undefined || s.markedUnread || this.statusOf(sessionId) !== 'read') return
    await this.deps.store.update((d) => {
      const x = d.sessions.find((y) => y.id === sessionId)
      if (x) x.markedUnread = true
    })
  }

  /** The user opened the session (not just saw it in a pane). */
  sessionOpened(sessionId: string): void {
    this.clearMarkedUnread(sessionId)
  }

  private clearMarkedUnread(sessionId: string): void {
    if (!this.session(sessionId)?.markedUnread || this.clearing.has(sessionId)) return
    this.clearing.add(sessionId)
    void this.deps.store.update((d) => {
      const x = d.sessions.find((y) => y.id === sessionId)
      if (x) delete x.markedUnread
    }).catch(() => {}).finally(() => { this.clearing.delete(sessionId) })
  }

  userInput(sessionId: string, kind: TermKind, data: string): void {
    if (kind !== 'claude') return
    // Keys only: terminal-generated replies (focus, device and cursor reports) all start with ESC.
    if (!data.startsWith('\x1b')) this.clearMarkedUnread(sessionId)
    const t = this.tracked.get(sessionId)
    if (!t) return
    const busy = t.rt.activity === 'working' || t.rt.activity === 'needs_input'
    let e: string | null = null
    if (data === '\x1b' && busy) e = 'pitwall:user-esc'
    else if (t.rt.activity === 'needs_input' && !t.inputSent && isAnswerInput(data)) {
      t.inputSent = true
      e = 'pitwall:user-input'
    }
    if (e) void appendEvent(eventsFile(this.deps.paths, sessionId), { c: sessionId, t: this.now(), e }).catch(() => {})
  }

  async waitForFirstEvent(sessionId: string, timeoutMs: number): Promise<boolean> {
    await this.track(sessionId)
    if (this.tracked.get(sessionId)?.rt.firstEventSeen) return true
    return new Promise<boolean>((resolve) => {
      const set = this.waiters.get(sessionId) ?? new Set<() => void>()
      this.waiters.set(sessionId, set)
      const done = () => {
        clearTimeout(timer)
        set.delete(done)
        resolve(!!this.tracked.get(sessionId)?.rt.firstEventSeen)
      }
      const timer = setTimeout(done, timeoutMs)
      set.add(done)
    })
  }

  async ensureTerminalTarget(sessionId: string, kind: TermKind): Promise<void> {
    const s = this.deps.store.state.sessions.find((x) => x.id === sessionId)
    if (!s) throw new Error('Session not found.')
    const { backend, paths } = this.deps
    if (kind === 'claude') return this.relaunchIfMissing(s)
    const name = shellTmuxName(sessionId)
    if (await backend.hasSession(name)) return
    await assertSessionFolder(s.cwd)
    if (usesHostLauncher(this.deps)) {
      // The session's identity, then PowerShell (pwsh if installed) on Windows, as pitwall-shell does elsewhere.
      const argv = shellTabArgv(this.deps.platform ?? process.platform, this.deps.env, isFile)
      await backend.newSession({ name, cwd: s.cwd, argv, launcher: { kind: 'shell', sessionDir: sessionDir(paths, sessionId) } })
      return
    }
    await backend.newSession({ name, cwd: s.cwd, argv: [join(paths.binDir, 'pitwall-shell'), sessionDir(paths, sessionId)] })
  }

  /** After a project edit: its running sessions pick up the new identity and env on their next (re)launch. */
  async rewriteProjectSessionFiles(projectId: string): Promise<void> {
    const { subProjects } = this.deps.store.state
    for (const s of this.active()) {
      if (subProjects.find((sp) => sp.id === s.subProjectId)?.projectId !== projectId) continue
      try {
        await writeSessionFiles(s, this.deps)
      } catch (e) {
        this.errors.set(s.id, e instanceof Error ? e.message : String(e))
      }
    }
    this.publish()
  }

  updateSessionExtras(sessionId: string, patch: Extras): void {
    this.extras.set(sessionId, { ...this.extras.get(sessionId), ...patch })
    this.publish()
  }

  dropSession(sessionId: string): void {
    this.tracked.get(sessionId)?.tailer.stop()
    this.tracked.delete(sessionId)
    this.tracking.delete(sessionId)
    this.extras.delete(sessionId)
    this.warnings.delete(sessionId)
    this.errors.delete(sessionId)
    const timer = this.persistTimers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.persistTimers.delete(sessionId)
    this.updateBadge()
    this.publish()
  }

  // ---- internals ---------------------------------------------------------

  /** A session that just started: tracked, published, and watched for Claude's first report. */
  private async started(res: StartResult): Promise<StartResult> {
    if (res.ok) {
      await this.track(res.sessionId)
      this.publish()
      void this.warnIfSilent(res.sessionId)
    }
    return res
  }

  /** Real Claude sits on a folder-trust prompt before any hook fires; say so if it stays silent. */
  private async warnIfSilent(id: string): Promise<void> {
    const seen = await this.waitForFirstEvent(id, this.deps.firstEventTimeoutMs ?? FIRST_EVENT_TIMEOUT_MS)
      .catch(() => false)
    const t = this.tracked.get(id)
    // Hooks that Windows wouldn't run say so themselves (a launcher warning): not a trust prompt.
    if (seen || this.disposed || !t || t.rt.firstEventSeen || t.rt.warnings?.scripts || this.session(id)?.archivedAt !== undefined) return
    this.warnings.set(id, START_WARNING)
    this.publish()
  }

  private active(): Session[] {
    return this.deps.store.state.sessions.filter((s) => s.archivedAt === undefined)
  }

  private session(id: string): Session | undefined {
    return this.deps.store.state.sessions.find((s) => s.id === id)
  }

  private statusOf(id: string): DisplayStatus {
    const t = this.tracked.get(id)
    const s = this.session(id)
    const base = displayStatus(t?.rt ?? initialRuntime, t?.viewedAt ?? s?.lastViewedAt ?? 0)
    return base === 'read' && s?.markedUnread ? 'unread' : base
  }

  private isMuted(s: Session): boolean {
    const st = this.deps.store.state
    const sp = st.subProjects.find((x) => x.id === s.subProjectId)
    return st.projects.find((p) => p.id === sp?.projectId)?.muted === true
  }

  /** Idempotent: replay the events file (no notifications), then tail it. */
  private track(id: string): Promise<void> {
    const existing = this.tracking.get(id)
    if (existing) return existing
    if (!this.session(id) || this.disposed) return Promise.resolve() // nothing cached: a later call retries
    let p!: Promise<void>
    p = (async () => {
      const s = this.session(id)
      if (!s || this.disposed) return
      const tailer = new EventTailer(eventsFile(this.deps.paths, id), (e) => this.onLive(id, e))
      const t: Tracked = { rt: initialRuntime, tailer, viewedAt: s.lastViewedAt, inputSent: false }
      const sids: string[] = [] // every conversation id the log mentions, in order
      for (const e of await tailer.readAll()) {
        t.rt = reduceRuntime(t.rt, e)
        if (e.sid && e.sid !== sids.at(-1)) sids.push(e.sid)
      }
      if (this.disposed || this.tracking.get(id) !== p) return
      this.tracked.set(id, t)
      await this.syncSid(id, sids, t.rt.lastMessage)
      tailer.start()
    })().catch((e) => {
      // Never cache a failure: a later track() retries.
      this.tracked.get(id)?.tailer.stop()
      this.tracked.delete(id)
      if (this.tracking.get(id) === p) this.tracking.delete(id)
      throw e
    })
    this.tracking.set(id, p)
    return p
  }

  /** A running session picks up Pitwall's current files (e.g. its status line) on its next relaunch. Best effort. */
  private async refreshSessionFiles(id: string): Promise<void> {
    const s = this.session(id) // re-read: track() may have just recorded a new conversation id
    if (!s) return
    try {
      await writeSessionFiles(s, this.deps)
    } catch {
      // relaunchIfMissing reports it if the session actually needs these files now
    }
  }

  private async relaunchIfMissing(s: Session): Promise<void> {
    if (await this.deps.backend.hasSession(claudeTmuxName(s.id))) return
    try {
      await writeSessionFiles(s, this.deps)
      await launchTmuxFor(s, this.deps)
      this.errors.delete(s.id)
    } catch (e) {
      this.errors.set(s.id, e instanceof Error ? e.message : String(e))
      this.publish()
      throw e
    }
  }

  /**
   * Records a new Claude conversation id (after /clear) in the store and the launcher's claude-id file. `sids` are the
   * ids seen, oldest first; the last is the current one. Earlier ones go to pastClaudeIds, so they stay searchable.
   */
  private async syncSid(id: string, sids: string[], lastMessage?: string): Promise<void> {
    const s = this.session(id)
    if (!s) return
    const sid = sids.at(-1)
    const sidChanged = !!sid && sid !== s.claudeSessionId
    const before = s.pastClaudeIds ?? []
    const past = sid ? pastIds(before, [s.claudeSessionId, ...sids]) : before
    const pastChanged = past.join('\n') !== before.join('\n')
    const messageChanged = lastMessage !== undefined && lastMessage !== s.lastMessage
    if (!sidChanged && !pastChanged && !messageChanged) return
    await this.deps.store.update((d) => {
      const x = d.sessions.find((y) => y.id === id)
      if (!x) return
      if (sid) {
        x.pastClaudeIds = pastIds(x.pastClaudeIds ?? [], [x.claudeSessionId, ...sids])
        if (x.pastClaudeIds.length === 0) delete x.pastClaudeIds
        x.claudeSessionId = sid
      }
      if (lastMessage !== undefined) x.lastMessage = lastMessage
    })
    if (sid && sidChanged) {
      await writeFileAtomic(join(sessionDir(this.deps.paths, id), 'claude-id'), sid + '\n')
    }
  }

  private onLive(id: string, e: HookEvent): void {
    const t = this.tracked.get(id)
    const s = this.session(id)
    if (!t || !s || this.disposed) return
    const before = this.statusOf(id)
    t.rt = reduceRuntime(t.rt, e)
    if (this.viewing.focused && this.viewing.ids.has(id)) this.markViewed(id)
    const after = this.statusOf(id)
    if (s.markedUnread && after !== 'unread') this.clearMarkedUnread(id) // new activity replaces the mark
    this.errors.delete(id)
    if (t.rt.activity !== 'needs_input') t.inputSent = false
    if (t.rt.firstEventSeen) {
      this.warnings.delete(id)
      for (const w of [...(this.waiters.get(id) ?? [])]) w()
    }
    void this.syncSid(id, e.sid ? [e.sid] : [], e.e === 'Stop' && e.msg != null ? e.msg : undefined).catch(() => {})
    if (before !== after && (after === 'needs_you' || after === 'unread')) this.maybeNotify(s, after, t.rt)
    this.updateBadge()
    for (const cb of [...this.eventCbs]) cb(id, e)
    this.publish()
  }

  private maybeNotify(s: Session, status: DisplayStatus, rt: SessionRuntime): void {
    if (this.viewing.focused && this.viewing.ids.has(s.id)) return
    if (this.isMuted(s)) return
    const sp = this.deps.store.state.subProjects.find((x) => x.id === s.subProjectId)
    const project = this.deps.store.state.projects.find((p) => p.id === sp?.projectId)
    this.deps.notifier.notify({
      sessionId: s.id,
      title: `${s.title} · ${project?.name ?? ''}`,
      body: notificationBody(status, rt)
    })
    if (status === 'needs_you') this.deps.notifier.attention?.()
  }

  private updateBadge(): void {
    const c = countStatuses(this.active().filter((s) => !this.isMuted(s)).map((s) => ({ status: this.statusOf(s.id) })))
    this.deps.notifier.setBadge(c.needsYou + c.unread)
  }

  private markViewed(id: string): void {
    const t = this.tracked.get(id)
    if (!t) return
    t.viewedAt = Math.max(t.viewedAt, this.now())
    this.updateBadge()
    // Coalesce persistence: many rapid calls produce one store write per 250 ms.
    if (this.persistTimers.has(id)) return
    this.persistTimers.set(id, setTimeout(() => {
      this.persistTimers.delete(id)
      this.persistViewed(id)
    }, PERSIST_DEBOUNCE_MS))
  }

  private persistViewed(id: string): void {
    const at = this.tracked.get(id)?.viewedAt
    if (at === undefined || this.session(id)?.lastViewedAt === at) return
    void this.deps.store.update((d) => {
      const x = d.sessions.find((y) => y.id === id)
      if (x && at > x.lastViewedAt) x.lastViewedAt = at
    }).catch(() => {})
  }

  private publish(): void {
    if (this.publishTimer || this.disposed) return
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null
      const snap = this.snapshot()
      for (const cb of [...this.snapshotCbs]) cb(snap)
    }, 50)
  }
}
