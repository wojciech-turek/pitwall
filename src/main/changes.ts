import { open, stat } from 'node:fs/promises'
import type { ChangedFile, Session } from '../shared/types'
import { resolveInside } from './files'
import type { GitClient } from './git'
import type { SessionManager } from './sessions/manager'
import type { Store } from './store'

const MAX_BYTES = 2 * 1024 * 1024
const REFRESH_EVENTS = new Set(['Stop', 'PostToolUse', 'PostToolUseFailure'])

export interface ChangeList { base: string; baseLabel: string; files: ChangedFile[] }
export interface DiffSides { original: string; modified: string; binary: boolean; tooLarge: boolean }

export class ChangesService {
  private timers = new Map<string, NodeJS.Timeout>()
  private unsub?: () => void
  private readonly debounceMs: number

  constructor(private deps: {
    store: Store; git: GitClient; manager: Pick<SessionManager, 'onSessionEvent' | 'updateSessionExtras'>; debounceMs?: number
  }) {
    this.debounceMs = deps.debounceMs ?? 2000
  }

  private repoSession(sessionId: string): (Session & { worktreePath: string }) | undefined {
    const { sessions, subProjects } = this.deps.store.state
    const s = sessions.find((x) => x.id === sessionId && x.archivedAt === undefined)
    if (!s?.worktreePath || !s.baseCommit) return undefined
    if (subProjects.find((p) => p.id === s.subProjectId)?.kind !== 'repo') return undefined
    return s as Session & { worktreePath: string }
  }

  async list(sessionId: string): Promise<ChangeList> {
    const s = this.repoSession(sessionId)
    if (!s) return { base: '', baseLabel: '', files: [] }
    const { git } = this.deps
    const base = await git.resolveDiffBase(s.worktreePath, s.baseBranch, s.baseCommit!)
    const short = base.slice(0, 7)
    return {
      base,
      baseLabel: s.baseBranch ? `${s.baseBranch} @ ${short}` : short,
      files: await git.listChanges(s.worktreePath, base)
    }
  }

  async readDiff(sessionId: string, rel: string): Promise<DiffSides> {
    const s = this.repoSession(sessionId)
    if (!s) throw new Error('Session has no changes to show')
    const { base } = await this.list(sessionId)
    const abs = await resolveInside(s.worktreePath, rel)
    let modified = ''
    let tooLarge = false
    let binary = false
    const st = await stat(abs).catch(() => null)
    if (st?.isFile()) {
      if (st.size > MAX_BYTES) tooLarge = true
      else {
        const fh = await open(abs, 'r')
        try {
          const buf = Buffer.alloc(st.size)
          await fh.read(buf, 0, st.size, 0)
          if (buf.subarray(0, 8000).includes(0)) binary = true
          else modified = buf.toString('utf8')
        } finally { await fh.close() }
      }
    }
    if (binary || tooLarge) return { original: '', modified: '', binary, tooLarge }
    const original = (await this.deps.git.showFile(s.worktreePath, base, rel)) ?? ''
    if (Buffer.byteLength(original) > MAX_BYTES) return { original: '', modified: '', binary: false, tooLarge: true }
    if (original.slice(0, 8000).includes('\0')) return { original: '', modified: '', binary: true, tooLarge: false }
    return { original, modified, binary: false, tooLarge: false }
  }

  start(): void {
    this.unsub = this.deps.manager.onSessionEvent((id, ev) => {
      if (!REFRESH_EVENTS.has(ev.e)) return
      const prev = this.timers.get(id)
      if (prev) clearTimeout(prev)
      this.timers.set(id, setTimeout(() => {
        this.timers.delete(id)
        void this.refresh(id)
      }, this.debounceMs))
    })
    for (const s of this.deps.store.state.sessions) if (s.archivedAt === undefined) void this.refresh(s.id)
  }

  stop(): void {
    this.unsub?.()
    this.unsub = undefined
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  /** Recomputes the sidebar line counts and live branch; never throws. */
  private async refresh(sessionId: string): Promise<void> {
    try {
      const s = this.repoSession(sessionId)
      if (!s) return
      const { files } = await this.list(sessionId)
      const diffStat = files.reduce(
        (a, f) => ({ additions: a.additions + f.additions, deletions: a.deletions + f.deletions }),
        { additions: 0, deletions: 0 }
      )
      const branch = await this.deps.git.currentBranch(s.worktreePath)
      this.deps.manager.updateSessionExtras(sessionId, { diffStat, liveBranch: branch ?? undefined })
    } catch {
      // One session's failure (e.g. worktree removed) must not affect the others.
    }
  }
}
