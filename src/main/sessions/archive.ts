import { access, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ArchiveCheck, ArchiveResult, Session, SubProject } from '@shared/types'
import { deleteEnv, mergeEnv } from '../../host/win-command'
import { buildSessionEnv, getGhToken, INHERITED_GH_TOKENS, withoutGhTokens } from '../identity'
import { eventsFile, sessionDir } from '../paths'
import type { PtyBridge } from '../pty-bridge'
import { claudeTmuxName, shellTmuxName } from '../tmux'
import type { SessionManager } from './manager'
import { snapshotLeftovers, stopLeftovers, type LeftoverOptions } from './leftovers'
import { runTeardown } from './teardown'
import { launchTmuxFor, writeSessionFiles, type StarterDeps } from './starter'

export type { ArchiveCheck, ArchiveResult }

export interface ArchiveDeps extends StarterDeps {
  manager: SessionManager
  ptyBridge: PtyBridge
  /** Teardown time limit; default 2 minutes. */
  teardownTimeoutMs?: number
  /** How leftover processes are listed and ended (a test seam). */
  leftovers?: Pick<LeftoverOptions, 'ps' | 'end' | 'kill'>
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

/**
 * Like the launcher: gh acts as the project's account, with the token only in the environment (never argv or disk).
 * With no token it runs signed out (an empty config dir), never as whichever account is active.
 */
async function applyGhAccount(env: Record<string, string>, account: string, dir: string, deps: ArchiveDeps): Promise<void> {
  if (!account) return
  const token = await getGhToken(deps.paths.ghBin, account, deps.exec, deps.env).catch(() => null)
  if (token) {
    env.GH_TOKEN = token
    return
  }
  for (const k of INHERITED_GH_TOKENS) deleteEnv(env, k, deps.platform ?? process.platform) // fail closed: no token of any kind
  env.GH_CONFIG_DIR = join(dir, 'gh-unauthenticated')
  await mkdir(env.GH_CONFIG_DIR, { recursive: true })
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
  // Once its terminals are closed, a session that stays active must get them back: the renderer then offers
  // "press any key to reattach", which relaunches the agent if it was stopped. Otherwise they stay frozen.
  let terminalsClosed = false
  const reattachable = (): void => {
    deps.ptyBridge.detach(sessionId, 'claude')
    deps.ptyBridge.detach(sessionId, 'shell')
  }
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

    const panes = [
      await deps.backend.processRoots(claudeTmuxName(s.id)),
      await deps.backend.processRoots(shellTmuxName(s.id))
    ]
    const serverPid = panes.find((p) => p.serverPid)?.serverPid ?? null
    const platform = deps.platform ?? process.platform
    const leftoverOptions: LeftoverOptions = { platform, ...deps.leftovers }
    const leftovers = await snapshotLeftovers(panes.flatMap((p) => p.panePids), serverPid, leftoverOptions)
    deps.ptyBridge.close(s.id, 'claude')
    deps.ptyBridge.close(s.id, 'shell')
    terminalsClosed = true
    await deps.backend.killSession(claudeTmuxName(s.id))
    await deps.backend.killSession(shellTmuxName(s.id))

    const repoRoot = sp?.repoRoot
    if (sp?.teardownCommand?.trim() && !o.skipTeardown && (await exists(s.cwd))) {
      const project = deps.store.state.projects.find((p) => p.id === sp.projectId)
      if (project) {
        const dir = sessionDir(deps.paths, s.id)
        const env = mergeEnv(
          // With a project account, tokens inherited from the user's shell must not stand in for it; the
          // project's own extra variables (merged next) are kept.
          project.identity.ghAccount ? withoutGhTokens(deps.env, platform) : deps.env,
          {
            ...buildSessionEnv({
              project, session: s, rootPath: sp.repoRoot ?? sp.path, sessionDir: dir,
              eventsFile: eventsFile(deps.paths, s.id), claudeBin: deps.paths.claudeBin, ghBin: deps.paths.ghBin,
              home: deps.home, platform
            }),
            PITWALL_WORKTREE_PATH: s.worktreePath ?? s.cwd,
            PITWALL_BRANCH: s.branch ?? '',
            PITWALL_SESSION_TITLE: s.title
          },
          platform
        )
        await applyGhAccount(env, project.identity.ghAccount, dir, deps)
        const r = await runTeardown(sp.teardownCommand, { cwd: s.cwd, env, timeoutMs: deps.teardownTimeoutMs, platform })
        if (r.timedOut || r.exitCode !== 0) {
          await stopLeftovers(leftovers, leftoverOptions)
          reattachable()
          return { ok: false, teardownFailed: r }
        }
      } else {
        console.warn(`Teardown skipped for ${s.id}: project ${sp.projectId} not found.`)
      }
    }
    await stopLeftovers(leftovers, leftoverOptions)
    if (check.willRemoveWorktree && repoRoot && s.worktreePath) {
      try {
        await deps.git.removeWorktree(repoRoot, s.worktreePath, true)
      } catch (e) {
        try {
          await writeSessionFiles(s, deps)
          await launchTmuxFor(s, deps)
        } catch {
          // best effort; the session stays active and reattaching relaunches it
        }
        reattachable()
        return { ok: false, error: `Couldn't remove the worktree: ${msg(e)}` }
      }
    }
    let branchDeleted = false
    if (check.willDeleteBranch && repoRoot && s.branch) {
      try {
        await deps.git.deleteBranch(repoRoot, s.branch)
        branchDeleted = true
      } catch {
        // The worktree is gone already; a branch left behind loses nothing.
      }
    }

    deps.manager.dropSession(s.id)
    await rm(sessionDir(deps.paths, s.id), { recursive: true, force: true })
    await deps.store.update((d) => {
      const x = d.sessions.find((y) => y.id === s.id)
      if (x) x.archivedAt = Date.now()
      if (x && branchDeleted) x.branchDeleted = true
    })
    return { ok: true }
  } catch (e) {
    if (terminalsClosed) reattachable()
    return { ok: false, error: msg(e) }
  }
}
