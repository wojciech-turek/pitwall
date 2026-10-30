import { rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Session, StartProgress, StartResult } from '@shared/types'
import { defaultBranchName, slugify } from '@shared/slug'
import { uniquePath } from '../git'
import { sessionDir } from '../paths'
import { claudeTmuxName } from '../tmux'
import { checkIdentity, launchTmuxFor, msg, progressSteps, StepError, writeSessionFiles, type StarterDeps } from './starter'

const isDir = (p: string) => stat(p).then((s) => s.isDirectory(), () => false)

type Restored = Pick<Session, 'cwd' | 'worktreePath' | 'branch' | 'branchCreatedByPitwall' | 'baseBranch' | 'baseCommit'>

/** An archived session made active again with its recreated worktree and branch. */
function restore(s: Session, r: Restored, newBranch: boolean): Session {
  const x: Session = { ...s, ...r }
  delete x.archivedAt
  delete x.markedUnread
  delete x.branchDeleted
  if (newBranch) delete x.pr // a new branch has no PR yet
  for (const k of ['worktreePath', 'branch', 'baseBranch', 'baseCommit'] as const) if (x[k] === undefined) delete x[k]
  return x
}

/**
 * Brings an archived session back: its worktree (in the original folder when that's free), its branch (made again from
 * its pushed copy if only that's left, or a new one from the repo's main branch) and the same Claude conversation.
 * On failure nothing is left behind.
 */
export function resumeSession(
  sessionId: string,
  requestId: string,
  deps: StarterDeps,
  onProgress: (p: StartProgress) => void
): Promise<StartResult> {
  const s = deps.store.state.sessions.find((x) => x.id === sessionId)
  const sp = s && deps.store.state.subProjects.find((x) => x.id === s.subProjectId)
  // The same lock as starting a session there: both pick free folder and branch names.
  const key = sp ? (sp.repoRoot ?? sp.path) : sessionId
  return deps.mutex
    .run(key, () => doResume(sessionId, requestId, deps, onProgress))
    .catch((e): StartResult => ({ ok: false, step: 'identity', error: msg(e) }))
}

async function doResume(
  sessionId: string,
  requestId: string,
  deps: StarterDeps,
  onProgress: (p: StartProgress) => void
): Promise<StartResult> {
  const steps = progressSteps(requestId, onProgress)
  const { emit, run } = steps
  const { git, paths, tmux } = deps
  const dir = sessionDir(paths, sessionId)
  const created = {
    repoRoot: undefined as string | undefined, worktree: undefined as string | undefined,
    branch: undefined as string | undefined, dir: false, tmux: false
  }

  const rollback = async () => {
    const attempt = async (fn: () => Promise<unknown>) => {
      try {
        await fn()
      } catch {
        // best effort; never mask the original error
      }
    }
    const { repoRoot, worktree, branch } = created
    if (created.tmux) await attempt(() => tmux.killSession(claudeTmuxName(sessionId)))
    if (worktree && repoRoot) await attempt(() => git.removeWorktree(repoRoot, worktree, true))
    if (worktree) await attempt(() => rm(worktree, { recursive: true, force: true }))
    if (branch && repoRoot) await attempt(() => git.deleteBranch(repoRoot, branch))
    if (created.dir) await attempt(() => rm(dir, { recursive: true, force: true }))
  }

  try {
    const s = deps.store.state.sessions.find((x) => x.id === sessionId)
    if (!s) throw new StepError('identity', 'Session not found.')
    if (s.archivedAt === undefined) throw new StepError('identity', 'This session is already running.')
    const sub = deps.store.state.subProjects.find((x) => x.id === s.subProjectId)
    if (!sub) {
      throw new StepError('identity', "This session's folder was removed from Pitwall. Add it again to start new sessions there.")
    }
    const project = deps.store.state.projects.find((p) => p.id === sub.projectId)
    if (!project) throw new StepError('identity', 'Project not found.')

    await run('identity', () => checkIdentity(project, deps))

    const r: Restored = {
      cwd: s.cwd, worktreePath: s.worktreePath, branch: s.branch, branchCreatedByPitwall: s.branchCreatedByPitwall,
      baseBranch: s.baseBranch, baseCommit: s.baseCommit
    }
    let newBranch = false // a new branch from main: the old PR doesn't apply
    if (sub.kind === 'repo' && sub.repoRoot) {
      const root = sub.repoRoot
      created.repoRoot = root
      await run('worktree', async () => {
        if (!(await isDir(root))) throw new Error(`The repo isn't there any more: ${root}`)
        const info = await git.detectFolder(root)
        if (info.kind !== 'repo' || info.repoRoot !== root) throw new Error(`This folder isn't a git repo any more: ${root}`)
        // A worktree folder deleted by hand keeps its branch and path taken until git forgets it.
        await git.pruneWorktrees(root)
        let base: string | undefined
        let makeBranch = false // Pitwall makes the local branch now: a new one, or the old one from its pushed copy
        let track = false
        const notes: string[] = []
        const local = !!s.branch && (await git.branchExists(root, s.branch))
        // A branch archiving deleted is gone for good, even if a branch of that name exists again now.
        if (s.branch && !s.branchDeleted && local) {
          const other = (await git.listBranches(root)).find((b) => b.name === s.branch)?.checkedOutAt
          if (other) throw new Error(`Branch ${s.branch} is checked out in ${other}. Switch that folder to another branch, then resume.`)
        } else if (s.branch && !local && (await git.remoteBranchExists(root, s.branch))) {
          // Archiving deleted the local branch, but its pushed copy still has the agent's commits: start from that.
          base = `origin/${s.branch}`
          r.branchCreatedByPitwall = true
          makeBranch = true
          track = true
          notes.push(`Branch ${s.branch} ${s.branchDeleted ? 'was deleted' : 'is gone'} — recreated it from its pushed copy, origin/${s.branch}`)
        } else {
          const main = await git.defaultBranch(root)
          base = main ?? 'HEAD'
          r.branch = await git.uniqueBranchName(root, defaultBranchName(s.slug))
          r.branchCreatedByPitwall = true
          r.baseBranch = main ?? undefined
          r.baseCommit = await git.revParse(root, base)
          newBranch = true
          makeBranch = true
          const made = `new branch ${r.branch} from ${main ?? 'the current commit'}`
          notes.push(!s.branch ? `Made a ${made}` : `Branch ${s.branch} ${s.branchDeleted ? 'was deleted' : 'is gone'} — ${made}`)
        }
        // The original folder when it's free: Claude files the conversation under that folder's name. Otherwise a
        // new one; `claude --resume` finds the conversation in other folders too.
        const original = s.worktreePath ?? join(paths.worktreesRoot, slugify(sub.name), s.slug)
        const path = await uniquePath(original)
        if (path !== original && s.worktreePath) notes.unshift(`Original folder is in use — resumed in ${path}`)
        // Mark before creating so a partial failure is still cleaned up.
        created.worktree = path
        if (makeBranch) created.branch = r.branch
        await git.addWorktree({ repoRoot: root, path, branch: r.branch!, mode: makeBranch ? 'new' : 'existing', base, track })
        r.worktreePath = path
        r.cwd = join(path, sub.relPath ?? '')
        return notes.join('. ') || undefined
      }, (note) => note)
    } else {
      await run('worktree', async () => {
        if (!(await isDir(s.cwd))) throw new Error(`Folder not found: ${s.cwd}`)
      }, 'No git — runs in the folder')
    }

    const session = restore(s, r, newBranch)
    await run('files', async () => {
      created.dir = true
      await writeSessionFiles(session, deps)
      // The conversation exists: the launcher resumes it (and starts a new one if Claude can't find it).
      await writeFile(join(dir, 'started'), '')
    })
    await run('tmux', async () => {
      created.tmux = true
      await launchTmuxFor(session, deps)
      await deps.store.update((d) => {
        const i = d.sessions.findIndex((x) => x.id === sessionId)
        if (i < 0) throw new Error('Session not found.')
        d.sessions[i] = restore(d.sessions[i], r, newBranch)
      })
    })

    emit('claude', 'running')
    emit('claude', 'done', 'Resumed — answer any prompt in the terminal')
    return { ok: true, sessionId }
  } catch (e) {
    await rollback()
    return { ok: false, step: e instanceof StepError ? e.step : steps.step, error: msg(e) }
  }
}
