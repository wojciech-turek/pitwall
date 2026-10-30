import { access, rm } from 'node:fs/promises'
import type { ArchiveCheck, ArchiveResult, Session, SubProject } from '@shared/types'
import { buildSessionEnv } from '../identity'
import { eventsFile, sessionDir } from '../paths'
import type { PtyBridge } from '../pty-bridge'
import { claudeTmuxName, shellTmuxName } from '../tmux'
import type { SessionManager } from './manager'
import { runTeardown } from './teardown'
import { launchTmuxFor, writeSessionFiles, type StarterDeps } from './starter'

export type { ArchiveCheck, ArchiveResult }

export interface ArchiveDeps extends StarterDeps {
  manager: SessionManager
  ptyBridge: PtyBridge
  /** Teardown time limit; default 2 minutes. */
  teardownTimeoutMs?: number
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const exists = (p: string) => access(p).then(() => true, () => false)

const EMPTY: ArchiveCheck = {
  uncommittedFiles: 0, unpushedCommits: 0, hasRemote: false, willDeleteBranch: false, willRemoveWorktree: false
}

function find(id: string, deps: ArchiveDeps): { s: Session; sp?: SubProject } | undefined {
  const s = deps.store.state.sessions.find((x) => x.id === id && x.archivedAt === undefined)
  if (!s) return undefined
  return { s, sp: deps.store.state.subProjects.find((p) => p.id === s.subProjectId) }
}

/** Throws when the work can't be inspected; callers decide how to surface that. */
async function inspect(s: Session, sp: SubProject | undefined, deps: ArchiveDeps): Promise<ArchiveCheck> {
  const { git } = deps
  const repoRoot = sp?.kind === 'repo' ? sp.repoRoot : undefined
  if (!repoRoot || !s.worktreePath) return { ...EMPTY }
  const hasWorktree = await exists(s.worktreePath)
  let counts = { uncommittedFiles: 0, unpushedCommits: 0, hasRemote: await git.hasRemote(repoRoot) }
  let current: string | null = null
  if (hasWorktree) {
    counts = await git.workStatus(s.worktreePath)
    current = await git.currentBranch(s.worktreePath)
  }
  // Delete only a branch Pitwall created, that still exists, that the worktree still has checked out
  // (the agent may have switched or renamed it), and that the main folder isn't using.
  let willDeleteBranch = false
  if (s.branchCreatedByPitwall && s.branch && (await git.branchExists(repoRoot, s.branch))) {
    const inMain = (await git.currentBranch(repoRoot).catch(() => null)) === s.branch
    willDeleteBranch = !inMain && (!hasWorktree || current === s.branch)
    // Folder deleted by hand: the branch may still hold the only copy of the agent's commits.
    if (willDeleteBranch && !hasWorktree) counts.unpushedCommits = await git.unpushedCommits(repoRoot, s.branch)
  }
  return {
    ...counts,
    ...(s.branch ? { branch: s.branch } : {}),
    willDeleteBranch,
    willRemoveWorktree: hasWorktree,
    worktreePath: s.worktreePath
  }
}

/** Never throws. If the work can't be inspected the counts are zero; archiveSession re-checks and refuses. */
export async function checkArchive(sessionId: string, deps: ArchiveDeps): Promise<ArchiveCheck> {
  try {
    const f = find(sessionId, deps)
    return f ? await inspect(f.s, f.sp, deps) : { ...EMPTY }
  } catch {
    return { ...EMPTY }
  }
}

export async function archiveSession(
  sessionId: string,
  o: { confirmedDataLoss: boolean; skipTeardown?: boolean },
  deps: ArchiveDeps
): Promise<ArchiveResult> {
  try {
    const f = find(sessionId, deps)
    if (!f) return { ok: false, error: 'Session not found.' }
    const { s, sp } = f
    let check: ArchiveCheck
    try {
      check = await inspect(s, sp, deps)
    } catch (e) {
      return { ok: false, error: `Couldn't check the session's work, so nothing was removed: ${msg(e)}` }
    }
    if ((check.uncommittedFiles > 0 || check.unpushedCommits > 0) && !o.confirmedDataLoss) {
      return { ok: false, needsConfirm: check }
    }

    deps.ptyBridge.close(s.id, 'claude')
    deps.ptyBridge.close(s.id, 'shell')
    await deps.tmux.killSession(claudeTmuxName(s.id))
    await deps.tmux.killSession(shellTmuxName(s.id))

    const repoRoot = sp?.repoRoot
    if (sp?.teardownCommand?.trim() && !o.skipTeardown && (await exists(s.cwd))) {
      const project = deps.store.state.projects.find((p) => p.id === sp.projectId)
      if (project) {
        const r = await runTeardown(sp.teardownCommand, {
          cwd: s.cwd,
          env: {
            ...deps.env,
            ...buildSessionEnv({
              project, session: s, rootPath: sp.repoRoot ?? sp.path, sessionDir: sessionDir(deps.paths, s.id),
              eventsFile: eventsFile(deps.paths, s.id), claudeBin: deps.paths.claudeBin, ghBin: deps.paths.ghBin,
              home: deps.home
            }),
            PITWALL_WORKTREE_PATH: s.worktreePath ?? s.cwd,
            PITWALL_BRANCH: s.branch ?? '',
            PITWALL_SESSION_TITLE: s.title
          },
          timeoutMs: deps.teardownTimeoutMs
        })
        if (r.timedOut || r.exitCode !== 0) return { ok: false, teardownFailed: r }
      }
    }
    if (check.willRemoveWorktree && repoRoot && s.worktreePath) {
      try {
        await deps.git.removeWorktree(repoRoot, s.worktreePath, true)
      } catch (e) {
        try {
          await writeSessionFiles(s, deps)
          await launchTmuxFor(s, deps)
        } catch {
          // best effort; the session stays active and reconcile relaunches it
        }
        return { ok: false, error: `Couldn't remove the worktree: ${msg(e)}` }
      }
    }
    if (check.willDeleteBranch && repoRoot && s.branch) {
      try {
        await deps.git.deleteBranch(repoRoot, s.branch)
      } catch {
        // The worktree is gone already; a branch left behind loses nothing.
      }
    }

    deps.manager.dropSession(s.id)
    await rm(sessionDir(deps.paths, s.id), { recursive: true, force: true })
    await deps.store.update((d) => {
      const x = d.sessions.find((y) => y.id === s.id)
      if (x) x.archivedAt = Date.now()
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: msg(e) }
  }
}
