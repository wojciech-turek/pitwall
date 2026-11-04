import type { Exec } from './exec'
import { getGhToken } from './identity'
import type { GitClient } from './git'
import type { AppPaths } from './paths'
import type { Notifier } from './notifier'
import type { SessionManager } from './sessions/manager'
import type { Store } from './store'
import type { ChecksState, PrInfo, PrState } from '../shared/types'

const FAILING = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const PENDING = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED'])
const TOKEN_TTL_MS = 10 * 60 * 1000
const PR_STATES = new Set<string>(['OPEN', 'CLOSED', 'MERGED'])

const str = (v: unknown): string => (typeof v === 'string' ? v.toUpperCase() : '')

/** Handles both CheckRun (`status`, `conclusion`) and StatusContext (`state`) entries of statusCheckRollup. */
export function summarizeChecks(rollup: unknown[]): ChecksState {
  if (rollup.length === 0) return 'none'
  const fields = rollup.map((c) => {
    const o = (c ?? {}) as Record<string, unknown>
    return { done: [str(o.conclusion), str(o.state)], live: [str(o.status), str(o.state)] }
  })
  if (fields.some((f) => f.done.some((v) => FAILING.has(v)))) return 'failing'
  if (fields.some((f) => f.live.some((v) => PENDING.has(v)))) return 'pending'
  return 'passing'
}

/** The branch's newest PR; 'none' when GitHub has none for it; null when the lookup failed. */
export async function fetchPr(o: {
  ghBin: string; cwd: string; branch: string; token: string; exec: Exec; env: Record<string, string>
}): Promise<PrInfo | 'none' | null> {
  const r = await o.exec(
    o.ghBin,
    ['pr', 'list', '--head', o.branch, '--state', 'all', '--json', 'number,url,title,state,isDraft,statusCheckRollup,updatedAt', '--limit', '1'],
    { cwd: o.cwd, env: { ...o.env, GH_TOKEN: o.token } }
  )
  if (r.code !== 0) return null
  let list: unknown
  try { list = JSON.parse(r.stdout) } catch { return null }
  if (!Array.isArray(list)) return null
  if (list.length === 0) return 'none'
  const p = list[0] as Record<string, unknown>
  const state = str(p.state)
  if (typeof p.number !== 'number' || !PR_STATES.has(state)) return null
  const updated = typeof p.updatedAt === 'string' ? Date.parse(p.updatedAt) : NaN
  const pr: PrInfo = {
    number: p.number,
    url: String(p.url ?? ''),
    title: String(p.title ?? ''),
    state: state as PrState,
    checks: summarizeChecks(Array.isArray(p.statusCheckRollup) ? p.statusCheckRollup : []),
    updatedAt: Number.isNaN(updated) ? Date.now() : updated
  }
  if (p.isDraft === true) pr.draft = true
  return pr
}

const same = (a: PrInfo | undefined, b: PrInfo): boolean =>
  !!a && a.number === b.number && a.state === b.state && a.checks === b.checks && a.title === b.title && a.url === b.url &&
  a.draft === b.draft

export class PrPoller {
  private tokens = new Map<string, { token: string; at: number }>()
  private timers = new Map<string, NodeJS.Timeout>()
  private inFlight = new Set<string>()
  private interval?: NodeJS.Timeout
  private unsub?: () => void
  private stopped = true
  private readonly intervalMs: number
  private readonly debounceMs: number

  constructor(private deps: {
    store: Store; manager: Pick<SessionManager, 'onSessionEvent' | 'snapshot'>; git: Pick<GitClient, 'hasRemote'>; exec: Exec
    env: Record<string, string>; paths: Pick<AppPaths, 'ghBin'>; notifier: Notifier; intervalMs?: number; debounceMs?: number
  }) {
    this.intervalMs = deps.intervalMs ?? 60_000
    this.debounceMs = deps.debounceMs ?? 5000
  }

  start(): void {
    this.stop()
    this.stopped = false
    this.unsub = this.deps.manager.onSessionEvent((id, ev) => { if (ev.e === 'Stop') this.refreshSoon(id) })
    this.interval = setInterval(() => { void this.pollAll() }, this.intervalMs)
    void this.pollAll()
  }

  stop(): void {
    this.stopped = true
    this.unsub?.()
    this.unsub = undefined
    if (this.interval) clearInterval(this.interval)
    this.interval = undefined
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  refreshSoon(sessionId: string): void {
    if (this.stopped) return
    const prev = this.timers.get(sessionId)
    if (prev) clearTimeout(prev)
    this.timers.set(sessionId, setTimeout(() => {
      this.timers.delete(sessionId)
      void this.pollOne(sessionId)
    }, this.debounceMs))
  }

  private async pollAll(): Promise<void> {
    for (const s of [...this.deps.store.state.sessions]) {
      if (this.stopped) return
      if (s.archivedAt === undefined) await this.pollOne(s.id)
    }
  }

  private async token(account: string): Promise<string | null> {
    const hit = this.tokens.get(account)
    if (hit && Date.now() - hit.at < TOKEN_TTL_MS) return hit.token
    const token = await getGhToken(this.deps.paths.ghBin, account, this.deps.exec, this.deps.env)
    if (!token) { this.tokens.delete(account); return null }
    this.tokens.set(account, { token, at: Date.now() })
    return token
  }

  private async pollOne(sessionId: string): Promise<void> {
    if (this.inFlight.has(sessionId)) return
    this.inFlight.add(sessionId)
    try {
      await this.check(sessionId)
    } catch {
      // A failing lookup for one session must not affect the others; it is retried on the next poll.
    } finally {
      this.inFlight.delete(sessionId)
    }
  }

  private async check(sessionId: string): Promise<void> {
    const { store, git, notifier, paths, exec, env } = this.deps
    const st = store.state
    const s = st.sessions.find((x) => x.id === sessionId)
    if (!s || s.archivedAt !== undefined) return
    const sub = st.subProjects.find((p) => p.id === s.subProjectId)
    if (sub?.kind !== 'repo') return
    const account = st.projects.find((p) => p.id === sub.projectId)?.identity.ghAccount
    if (!account) return // never fall back to the machine's active gh account
    const dir = s.worktreePath ?? s.cwd
    const branch = this.deps.manager.snapshot().sessions.find((x) => x.id === sessionId)?.liveBranch ?? s.branch
    if (!branch || !(await git.hasRemote(dir))) return
    const token = await this.token(account)
    if (!token || this.stopped) return
    const pr = await fetchPr({ ghBin: paths.ghBin, cwd: dir, branch, token, exec, env })
    if (!pr || this.stopped) return
    const before = store.state.sessions.find((x) => x.id === sessionId)?.pr
    if (pr === 'none') {
      // GitHub has no PR for the branch the session is on now, so the one it had was for an earlier branch (a
      // follow-up started after a merge): showing it would make the session look finished.
      if (!before) return
      await store.update((d) => {
        const t = d.sessions.find((x) => x.id === sessionId)
        if (t) delete t.pr
      })
      return
    }
    if (same(before, pr)) return
    await store.update((d) => {
      const t = d.sessions.find((x) => x.id === sessionId)
      if (t) t.pr = pr
    })
    // A muted project's PR badge still updates; it just doesn't notify.
    const muted = store.state.projects.find((p) => p.id === sub.projectId)?.muted === true
    if (before && before.state !== 'MERGED' && pr.state === 'MERGED' && !muted) {
      // Sounds on: Pitwall's sounds are for needing you and finishing; this one makes none, not even the system's.
      const silent = store.state.settings.sounds ? { silent: true } : {}
      notifier.notify({ sessionId, title: `PR #${pr.number} merged`, body: `Archive "${s.title}"?`, ...silent })
    }
  }
}
