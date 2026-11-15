import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultAccountDir, isPinned, sessionAccountId, DEFAULT_ACCOUNT_ID, type AccountCtx } from '../accounts'
import { copyProjectEntry, profileFile } from '../account-folders'
import { writeFileAtomic } from '../atomic'
import type { Store } from '../store'
import type { ContinueScheduler, Timers } from './continue-at'
import type { SessionManager } from './manager'
import type { AppSnapshot, HookEvent, Project, Session, SessionView } from '@shared/types'

/** How long a moved session may take to start on its new account before it is shown as waiting (a sign-in or trust prompt). */
export const WAIT_MS = 60_000
/** Written in the session's folder before the restart; while it is there, the launcher never starts a new conversation. */
export const MOVED_FROM_FILE = 'moved-from'

const NOT_FOUND = 'Session not found.'

interface Deps {
  store: Pick<Store, 'state' | 'update'>
  home: string
  env: Record<string, string>
  /** A session's folder of files (env.sh, the marker). */
  sessionDir: (sessionId: string) => string
  manager: Pick<SessionManager, 'snapshot' | 'onSnapshot' | 'onSessionEvent' | 'restartClaude' | 'sendText' | 'updateSessionExtras'>
  continueAt: Pick<ContinueScheduler, 'cancel'>
  /** A session's events so far, oldest first (to see what happened to a move while Pitwall was closed). */
  readEvents: (sessionId: string) => Promise<HookEvent[]>
  /** An account's label (its email), for messages. */
  labelFor: (accountId: string) => Promise<string>
  /** Claude was restarted in this session: its terminal should attach again. */
  onRestarted?: (sessionId: string) => void
  timers?: Timers
}

/**
 * Moves running sessions from one Claude account to another, keeping their conversations: once a session is idle,
 * its account changes, its files are rewritten and its Claude is restarted, which resumes the same conversation on
 * the new account. If that resume fails, the session goes back to the account it came from (never a new
 * conversation). A session's project that sets its own CLAUDE_CONFIG_DIR is never moved.
 *
 * What is saved on the session, so it survives a restart of Pitwall: `moveTo` (waiting to move) and `movedFrom`
 * (restarted on the new account, not yet seen to start there).
 */
export class AccountMover {
  private readonly timers: Timers
  /** One thing at a time per session: a request, a move, an event. */
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly waits = new Map<string, unknown>()
  private readonly waiting = new Set<string>()
  /** Stopped at a limit when moved: "continue" is typed once Claude has started there... */
  private readonly continueAfter = new Set<string>()
  /** ...and is idle at its prompt. */
  private readonly continuePending = new Set<string>()
  /** Sessions showing "Couldn't continue this conversation on …". */
  private readonly failed = new Set<string>()
  private offs: Array<() => void> = []

  constructor(private readonly deps: Deps) {
    this.timers = deps.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout)
    }
  }

  /** Picks up what was saved: pending moves happen when their sessions are idle; sessions mid-move wait again to start. */
  start(): void {
    this.offs = [
      this.deps.manager.onSnapshot((snap) => this.onSnapshot(snap)),
      this.deps.manager.onSessionEvent((id, e) => this.onEvent(id, e))
    ]
    for (const s of this.deps.store.state.sessions) {
      if (s.archivedAt !== undefined) continue
      if (s.movedFrom !== undefined) void this.chain(s.id, () => this.reconcile(s.id)).catch(() => undefined)
      if (s.moveTo !== undefined) void this.chain(s.id, () => this.tryMove(s.id)).catch(() => undefined)
    }
  }

  stop(): void {
    for (const off of this.offs) off()
    this.offs = []
    for (const h of this.waits.values()) this.timers.clearTimeout(h)
    this.waits.clear()
  }

  /** Resolves once nothing is in flight for any session (tests wait on this rather than on time). */
  async idle(): Promise<void> {
    while (this.chains.size > 0) await Promise.all([...this.chains.values()])
  }

  // ---- what the user asks for --------------------------------------------------------

  /** Moves the session to `target` now if it is idle, else when it next is. The account it is on already cancels a pending move. */
  request(sessionId: string, target: string): Promise<void> {
    return this.chain(sessionId, async () => {
      const { project } = this.find(sessionId)
      if (isPinned(project)) throw new Error("This session's project sets its own Claude account.")
      if (!this.accountExists(target)) throw new Error('Account not found.')
      await this.setMoveTo(sessionId, target === this.currentId(sessionId) ? undefined : target)
      await this.tryMove(sessionId)
    })
  }

  /** Every unpinned live session on another account: how many would move now (idle) and how many when they finish. */
  countMovable(target: string): { now: number; later: number } {
    const views = this.views()
    let now = 0
    let later = 0
    for (const s of this.movable(target)) {
      if (ready(views.get(s.id))) now++
      else later++
    }
    return { now, later }
  }

  /** request() for each of them. */
  async requestAll(target: string): Promise<{ now: number; later: number }> {
    if (!this.accountExists(target)) throw new Error('Account not found.')
    const count = this.countMovable(target)
    await Promise.all(this.movable(target).map((s) => this.request(s.id, target).catch(() => undefined)))
    return count
  }

  /**
   * `target` became the active account: sessions already on it stop waiting to move away (switching back cancels).
   * Sessions on other accounts are untouched.
   */
  async settleOn(target: string): Promise<void> {
    const here = this.deps.store.state.sessions.filter((s) => s.archivedAt === undefined && s.moveTo !== undefined && this.currentId(s.id) === target)
    await Promise.all(here.map((s) => this.cancel(s.id).catch(() => undefined)))
  }

  /** Drops a pending move. */
  cancel(sessionId: string): Promise<void> {
    return this.chain(sessionId, () => this.setMoveTo(sessionId, undefined))
  }

  /** Returns a session that hasn't started on its new account (it waits at a prompt there) to the one it came from. */
  moveBack(sessionId: string): Promise<void> {
    return this.chain(sessionId, async () => {
      if (this.session(sessionId)?.movedFrom === undefined) throw new Error('This session was not moved.')
      await this.revert(sessionId)
    })
  }

  // ---- queries -----------------------------------------------------------------------

  private ctx(): AccountCtx {
    return { settings: this.deps.store.state.settings, home: this.deps.home, env: this.deps.env }
  }

  private session(id: string): Session | undefined {
    return this.deps.store.state.sessions.find((s) => s.id === id && s.archivedAt === undefined)
  }

  private projectOf(s: Session): Project | undefined {
    const st = this.deps.store.state
    return st.projects.find((p) => p.id === st.subProjects.find((x) => x.id === s.subProjectId)?.projectId)
  }

  private find(id: string): { session: Session; project: Project } {
    const session = this.session(id)
    const project = session && this.projectOf(session)
    if (!session || !project) throw new Error(NOT_FOUND)
    return { session, project }
  }

  private accountExists(id: string): boolean {
    return id === DEFAULT_ACCOUNT_ID || (this.deps.store.state.settings.claudeAccounts ?? []).some((a) => a.id === id)
  }

  /** The id of the account the session runs on; null when its project is pinned (or the session is gone). */
  private currentId(id: string): string | null {
    const s = this.session(id)
    const project = s && this.projectOf(s)
    return s && project ? sessionAccountId(project, s, this.ctx()) : null
  }

  private dirOf(accountId: string): string {
    const acct = (this.deps.store.state.settings.claudeAccounts ?? []).find((a) => a.id === accountId)
    return acct ? acct.dir : defaultAccountDir(this.ctx())
  }

  private views(): Map<string, SessionView> {
    return new Map(this.deps.manager.snapshot().sessions.map((s) => [s.id, s]))
  }

  private movable(target: string): Session[] {
    return this.deps.store.state.sessions.filter((s) => {
      if (s.archivedAt !== undefined) return false
      const id = this.currentId(s.id)
      return id !== null && id !== target
    })
  }

  // ---- the move ----------------------------------------------------------------------

  private chain<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(id) ?? Promise.resolve()).then(fn, fn)
    const tail = next.catch(() => undefined)
    this.chains.set(id, tail)
    void tail.then(() => { if (this.chains.get(id) === tail) this.chains.delete(id) })
    return next
  }

  private async patch(id: string, fn: (s: Session) => void): Promise<void> {
    await this.deps.store.update((d) => {
      const s = d.sessions.find((x) => x.id === id)
      if (s) fn(s)
    })
  }

  /** Asking again, or Cancel (shown as Dismiss), takes the last failed move's message away. */
  private clearFailed(id: string): void {
    if (this.failed.delete(id)) this.deps.manager.updateSessionExtras(id, { moveError: undefined })
  }

  private async setMoveTo(id: string, target: string | undefined): Promise<void> {
    this.clearFailed(id)
    if (this.session(id)?.moveTo === target) return
    await this.patch(id, (s) => {
      if (target === undefined) delete s.moveTo
      else s.moveTo = target
    })
  }

  /** Moves the session if it has somewhere to go and is idle. A move that no longer makes sense is dropped. */
  private async tryMove(id: string): Promise<void> {
    const s = this.session(id)
    if (!s || s.moveTo === undefined) return
    const current = this.currentId(id)
    if (current === null || current === s.moveTo || !this.accountExists(s.moveTo)) return this.setMoveTo(id, undefined)
    // Still not seen to start where it was last moved to: the next move waits, so "where it came from" stays true.
    if (s.movedFrom !== undefined) return
    const view = this.views().get(id)
    if (!ready(view)) return
    await this.move(s, current, s.moveTo, !!view?.limitHit)
  }

  private async move(s: Session, from: string, to: string, limitHit: boolean): Promise<void> {
    const { home } = this.deps
    await this.deps.continueAt.cancel(s.id).catch(() => undefined)
    // The folder's trust and allowed tools go with it, so Claude doesn't stop at the trust prompt there. Only into an
    // added account's profile: Pitwall never edits the default one (~/.claude.json), where Claude asks again if it must.
    if (to !== DEFAULT_ACCOUNT_ID) {
      const [source, dest] = [profileFile(this.dirOf(from), home), profileFile(this.dirOf(to), home)]
      for (const folder of this.trustFolders(s)) await copyProjectEntry(source, dest, folder).catch(() => undefined)
    }
    await this.patch(s.id, (x) => {
      if (to === DEFAULT_ACCOUNT_ID) delete x.account
      else x.account = to
      x.movedFrom = from
      delete x.moveTo
    })
    if (limitHit) this.continueAfter.add(s.id)
    try {
      await this.writeMarker(s.id, from)
      this.armWait(s.id)
      await this.deps.manager.restartClaude(s.id)
    } catch (e) {
      await this.unmove(s.id)
      throw e
    }
    this.deps.onRestarted?.(s.id)
  }

  /**
   * The folders Claude may keep the session's trust under. For a worktree that is the main repo's folder, not the
   * worktree's (seen with real Claude Code); for a plain folder, the folder itself.
   */
  private trustFolders(s: Session): string[] {
    const sp = this.deps.store.state.subProjects.find((x) => x.id === s.subProjectId)
    return [...new Set([sp?.repoRoot, sp?.path, s.worktreePath, s.cwd].filter((x): x is string => !!x))]
  }

  private async writeMarker(id: string, from: string): Promise<void> {
    await mkdir(this.deps.sessionDir(id), { recursive: true })
    await writeFileAtomic(join(this.deps.sessionDir(id), MOVED_FROM_FILE), from + '\n')
  }

  /**
   * A session found mid-move when Pitwall starts: what happened while it was closed is in the session's events since
   * the marker was written. Started there: the move is done. Failed: back where it came from. Launched and nothing
   * since: wait, as after a move made now. Never launched (Pitwall quit before restarting Claude): restart it now,
   * so it runs on the account it is shown on.
   */
  private async reconcile(id: string): Promise<void> {
    const s = this.session(id)
    if (s?.movedFrom === undefined) return
    const marker = join(this.deps.sessionDir(id), MOVED_FROM_FILE)
    const written = await stat(marker).then((st) => st.mtimeMs, () => null)
    if (written === null) {
      await this.writeMarker(id, s.movedFrom)
      return this.relaunchMoved(id)
    }
    // (The launcher stamps its events to the second.)
    const since = Math.floor(written / 1000) * 1000
    const events = (await this.deps.readEvents(id).catch(() => [])).filter((e) => e.t >= since)
    const launch = events.map((e) => e.e).lastIndexOf('pitwall:launch')
    if (launch < 0) return this.relaunchMoved(id)
    const after = events.slice(launch).map((e) => e.e)
    if (after.includes('SessionStart')) return this.finish(id)
    if (after.includes('pitwall:move-failed')) return this.fail(id)
    this.armWait(id)
  }

  private async relaunchMoved(id: string): Promise<void> {
    this.armWait(id)
    await this.deps.manager.restartClaude(id)
    this.deps.onRestarted?.(id)
  }

  /** Claude started on the new account: the move is done. */
  private async finish(id: string): Promise<void> {
    const typeContinue = this.continueAfter.has(id)
    this.forget(id)
    await this.patch(id, (x) => { delete x.movedFrom })
    await rm(join(this.deps.sessionDir(id), MOVED_FROM_FILE), { force: true })
    if (typeContinue) this.continuePending.add(id)
  }

  /** The conversation wouldn't resume there: back where it came from, never a new conversation, and it says so. */
  private async fail(id: string): Promise<void> {
    const s = this.session(id)
    const project = s && this.projectOf(s)
    if (!s || !project) return
    const to = sessionAccountId(project, s, this.ctx()) ?? DEFAULT_ACCOUNT_ID
    await this.revert(id)
    const label = await this.deps.labelFor(to).catch(() => to)
    // Kept on the session until dismissed (an ordinary error is wiped by the next event from the restarted Claude).
    this.failed.add(id)
    this.deps.manager.updateSessionExtras(id, { moveError: `Couldn't continue this conversation on ${label}.` })
  }

  /** The session's account as it was before the move, and nothing left of the move. */
  private async unmove(id: string): Promise<string | undefined> {
    const from = this.session(id)?.movedFrom
    this.forget(id)
    await this.patch(id, (x) => {
      if (x.movedFrom === undefined) return
      if (x.movedFrom === DEFAULT_ACCOUNT_ID) delete x.account
      else x.account = x.movedFrom
      delete x.movedFrom
    })
    await rm(join(this.deps.sessionDir(id), MOVED_FROM_FILE), { force: true })
    return from
  }

  /** Back on the account it came from, restarted there. */
  private async revert(id: string): Promise<void> {
    await this.unmove(id)
    await this.deps.manager.restartClaude(id)
    this.deps.onRestarted?.(id)
  }

  private forget(id: string): void {
    const h = this.waits.get(id)
    if (h !== undefined) this.timers.clearTimeout(h)
    this.waits.delete(id)
    this.continueAfter.delete(id)
    this.continuePending.delete(id)
    if (this.waiting.delete(id)) this.deps.manager.updateSessionExtras(id, { moveWaiting: undefined })
  }

  private armWait(id: string): void {
    const old = this.waits.get(id)
    if (old !== undefined) this.timers.clearTimeout(old)
    this.waits.set(id, this.timers.setTimeout(() => {
      this.waits.delete(id)
      if (this.session(id)?.movedFrom === undefined) return
      // Neither started nor failed: Claude is at a prompt there (a sign-in, the folder trust). Nothing is undone.
      this.waiting.add(id)
      this.deps.manager.updateSessionExtras(id, { moveWaiting: true })
    }, WAIT_MS))
  }

  // ---- what happens next -------------------------------------------------------------

  private onEvent(id: string, e: HookEvent): void {
    if (e.e !== 'SessionStart' && e.e !== 'pitwall:move-failed') return
    if (this.session(id)?.movedFrom === undefined) return
    void this.chain(id, async () => {
      if (this.session(id)?.movedFrom === undefined) return
      await (e.e === 'SessionStart' ? this.finish(id) : this.fail(id))
    }).catch(() => undefined)
  }

  private onSnapshot(snap: AppSnapshot): void {
    for (const v of snap.sessions) {
      if (v.moveTo !== undefined) void this.chain(v.id, () => this.tryMove(v.id)).catch(() => undefined)
      // Started on its new account and idle at its prompt: carry on from the limit it had stopped at.
      if (this.continuePending.has(v.id) && (v.status === 'read' || v.status === 'unread')) {
        this.continuePending.delete(v.id)
        void this.chain(v.id, () => this.deps.manager.sendText(v.id, 'continue')).catch(() => undefined)
      }
    }
  }
}

/** Idle at its prompt (or its Claude has exited), with no subagent at work: restarting it interrupts nothing. */
function ready(v: SessionView | undefined): boolean {
  if (!v) return false
  if (v.status !== 'read' && v.status !== 'unread' && v.status !== 'exited') return false
  return !v.subagents?.some((x) => x.state === 'running' || x.needsYou)
}
