import { resetTimeFor } from '../../shared/reset-time'
import type { ClaudeUsage } from '../../shared/types'
import type { Store } from '../store'
import type { SessionManager } from './manager'

const HOUR = 3_600_000
/** A saved time already past at boot fires this soon, once the app is up. */
const OVERDUE_DELAY = 5_000
/** A saved time older than this is stale: the person has moved on. */
const STALE_AFTER = 12 * HOUR

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/**
 * Types "continue" into a session that stopped at a usage limit, once the limit resets. The time is saved on the
 * session (`continueAt`), so it survives a restart. Nothing is typed unless the session is still idle and still
 * stopped at the limit: the person may have carried on by hand.
 */
export class ContinueScheduler {
  private readonly pending = new Map<string, unknown>()
  private readonly now: () => number
  private readonly timers: Timers

  constructor(private readonly deps: {
    store: Pick<Store, 'state' | 'update'>
    manager: Pick<SessionManager, 'snapshot' | 'sendText'>
    usageFor: (sessionId: string) => ClaudeUsage | undefined
    now?: () => number
    timers?: Timers
  }) {
    this.now = deps.now ?? Date.now
    this.timers = deps.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout)
    }
  }

  /** Re-arms every saved time; an overdue one fires soon, a stale one is dropped. */
  start(): void {
    const now = this.now()
    for (const s of this.deps.store.state.sessions) {
      if (s.continueAt === undefined) continue
      if (s.continueAt > now) this.arm(s.id, s.continueAt - now)
      else if (now - s.continueAt < STALE_AFTER) this.arm(s.id, OVERDUE_DELAY)
      else void this.clear(s.id)
    }
  }

  async schedule(sessionId: string): Promise<number> {
    const at = resetTimeFor(this.deps.usageFor(sessionId), this.now())
    this.arm(sessionId, at - this.now())
    await this.deps.store.update((d) => {
      const s = d.sessions.find((x) => x.id === sessionId)
      if (s) s.continueAt = at
    })
    return at
  }

  async cancel(sessionId: string): Promise<void> {
    this.disarm(sessionId)
    await this.clear(sessionId)
  }

  stop(): void {
    for (const h of this.pending.values()) this.timers.clearTimeout(h)
    this.pending.clear()
  }

  private arm(sessionId: string, delay: number): void {
    this.disarm(sessionId)
    this.pending.set(sessionId, this.timers.setTimeout(() => { void this.fire(sessionId) }, Math.max(0, delay)))
  }

  private disarm(sessionId: string): void {
    const h = this.pending.get(sessionId)
    if (h === undefined) return
    this.timers.clearTimeout(h)
    this.pending.delete(sessionId)
  }

  private async fire(sessionId: string): Promise<void> {
    this.pending.delete(sessionId)
    const s = this.deps.manager.snapshot().sessions.find((x) => x.id === sessionId)
    try {
      if (s && (s.status === 'read' || s.status === 'unread') && s.limitHit) {
        await this.deps.manager.sendText(sessionId, 'continue')
      }
    } catch { /* the session went away; nothing to continue */ }
    await this.clear(sessionId)
  }

  private async clear(sessionId: string): Promise<void> {
    if (this.deps.store.state.sessions.find((x) => x.id === sessionId)?.continueAt === undefined) return
    await this.deps.store.update((d) => {
      const s = d.sessions.find((x) => x.id === sessionId)
      if (s) delete s.continueAt
    })
  }
}
