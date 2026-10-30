import { randomUUID } from 'node:crypto'
import { access, mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '../atomic'
import type {
  NewSessionDefaults, NewSessionInput, Project, Session, StartProgress, StartResult, StartStep, SubProject
} from '@shared/types'
import { defaultBranchName, slugify } from '@shared/slug'
import type { Exec } from '../exec'
import { GitClient, uniquePath } from '../git'
import { buildHookSettings, findUserStatusLine, hookCommandFor, statusLineCommandFor } from '../hooks/settings'
import { buildSessionEnv, claudeConfigDir, getGhToken, renderEnvFile } from '../identity'
import { eventsFile, sessionDir, type AppPaths } from '../paths'
import { newId, type Store } from '../store'
import { claudeTmuxName, type Tmux } from '../tmux'
import type { KeyedMutex } from './mutex'

export type { NewSessionDefaults, NewSessionInput, StartProgress, StartResult, StartStep }

export interface StarterDeps {
  store: Store
  paths: AppPaths
  git: GitClient
  tmux: Tmux
  exec: Exec
  env: Record<string, string>
  home: string
  mutex: KeyedMutex
}

export class StepError extends Error {
  constructor(readonly step: StartStep, message: string) {
    super(message)
  }
}

export const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const exists = (p: string) => access(p).then(() => true, () => false)

/** Progress reporting for starting (or resuming) a session: each step is reported running, then done or failed. */
export function progressSteps(requestId: string, onProgress: (p: StartProgress) => void) {
  let current: StartStep = 'identity'
  const emit = (step: StartStep, state: StartProgress['state'], message?: string) => {
    try {
      onProgress({ requestId, step, state, ...(message ? { message } : {}) })
    } catch {
      // a broken listener must not break the start
    }
  }
  const run = async <T>(s: StartStep, fn: () => Promise<T>, doneMessage?: string | ((v: T) => string | undefined)): Promise<T> => {
    current = s
    emit(s, 'running')
    try {
      const v = await fn()
      emit(s, 'done', typeof doneMessage === 'function' ? doneMessage(v) : doneMessage)
      return v
    } catch (e) {
      emit(s, 'failed', msg(e))
      throw e instanceof StepError ? e : new StepError(s, msg(e))
    }
  }
  return { emit, run, get step() { return current } }
}

/** The project's SSH key exists and its GitHub account can give a token. */
export async function checkIdentity(project: Project, deps: StarterDeps): Promise<void> {
  const key = project.identity.sshKeyPath
  const keyPath = key === '~' || key.startsWith('~/') ? join(deps.home, key.slice(2)) : key
  if (key && !(await exists(keyPath))) throw new Error(`SSH key not found: ${key}`)
  if (!project.identity.ghAccount) return
  const token = await getGhToken(deps.paths.ghBin, project.identity.ghAccount, deps.exec, deps.env)
  if (token === null) {
    throw new Error(`Couldn't get a GitHub token for ${project.identity.ghAccount}. Check \`gh auth status\`.`)
  }
}

function findSubProject(deps: StarterDeps, id: string): SubProject {
  const sp = deps.store.state.subProjects.find((s) => s.id === id)
  if (!sp) throw new Error('Sub-project not found.')
  return sp
}

export async function prepareNewSession(subProjectId: string, deps: StarterDeps): Promise<NewSessionDefaults> {
  const sp = findSubProject(deps, subProjectId)
  if (sp.kind === 'folder' || !sp.repoRoot) return { kind: 'folder', hasCommits: false, baseBranch: null, defaultBranch: null, branches: [] }
  const hasCommits = await deps.git.hasCommits(sp.repoRoot)
  if (!hasCommits) return { kind: 'repo', hasCommits, baseBranch: null, defaultBranch: null, branches: [] }
  const main = await deps.git.defaultBranch(sp.repoRoot)
  return { kind: 'repo', hasCommits, baseBranch: main, defaultBranch: main, branches: await deps.git.listBranches(sp.repoRoot) }
}

export async function writeSessionFiles(session: Session, deps: StarterDeps): Promise<void> {
  const sp = findSubProject(deps, session.subProjectId)
  const project = deps.store.state.projects.find((p) => p.id === sp.projectId)
  if (!project) throw new Error('Project not found.')
  const dir = sessionDir(deps.paths, session.id)
  const events = eventsFile(deps.paths, session.id)
  const env = buildSessionEnv({
    project,
    session,
    rootPath: sp.repoRoot ?? sp.path,
    sessionDir: dir,
    eventsFile: events,
    claudeBin: deps.paths.claudeBin,
    ghBin: deps.paths.ghBin,
    setupCommand: sp.setupCommand,
    userStatusLine: await findUserStatusLine(session.cwd, claudeConfigDir(project, deps.home, deps.env)),
    home: deps.home
  })
  await mkdir(dir, { recursive: true })
  // Atomic: a relaunching launcher may be sourcing env.sh while a project edit rewrites it.
  await writeFileAtomic(join(dir, 'env.sh'), renderEnvFile(env), 0o600)
  const hook = hookCommandFor(join(deps.paths.binDir, 'pitwall-hook'), events, session.id)
  const statusLine = statusLineCommandFor(join(deps.paths.binDir, 'pitwall-statusline'), dir)
  // Atomic: a running Claude or the launcher may read these at any moment.
  await writeFileAtomic(join(dir, 'hooks.json'), JSON.stringify(buildHookSettings(hook, statusLine), null, 2))
  // Re-read: a /clear may have recorded a new conversation id while the files above were written.
  const claudeId = deps.store.state.sessions.find((x) => x.id === session.id)?.claudeSessionId ?? session.claudeSessionId
  await writeFileAtomic(join(dir, 'claude-id'), claudeId + '\n')
}

/** tmux would silently start in $HOME instead; an agent must never run in the wrong folder. */
export async function assertSessionFolder(cwd: string): Promise<void> {
  const st = await stat(cwd).catch(() => null)
  if (!st?.isDirectory()) throw new Error(`Session folder not found: ${cwd}`)
}

export async function launchTmuxFor(session: Session, deps: StarterDeps): Promise<void> {
  await assertSessionFolder(session.cwd)
  await deps.tmux.newSession({
    name: claudeTmuxName(session.id),
    cwd: session.cwd,
    argv: [join(deps.paths.binDir, 'pitwall-launch'), sessionDir(deps.paths, session.id)]
  })
}

export function startSession(
  input: NewSessionInput,
  deps: StarterDeps,
  onProgress: (p: StartProgress) => void
): Promise<StartResult> {
  let key = input.subProjectId
  const sp = deps.store.state.subProjects.find((s) => s.id === input.subProjectId)
  if (sp) key = sp.repoRoot ?? sp.path
  return deps.mutex
    .run(key, () => doStart(input, deps, onProgress))
    .catch((e): StartResult => ({ ok: false, step: 'identity', error: msg(e) }))
}

async function doStart(
  input: NewSessionInput,
  deps: StarterDeps,
  onProgress: (p: StartProgress) => void
): Promise<StartResult> {
  const steps = progressSteps(input.requestId, onProgress)
  const { emit, run } = steps
  const { paths, git, tmux } = deps
  const id = newId('s')
  const dir = sessionDir(paths, id)
  const created = { worktree: undefined as string | undefined, branch: undefined as string | undefined, tmux: false }
  let repoRoot: string | undefined

  const rollback = async () => {
    const attempt = async (fn: () => Promise<unknown>) => {
      try {
        await fn()
      } catch {
        // best effort; never mask the original error
      }
    }
    if (created.tmux) await attempt(() => tmux.killSession(claudeTmuxName(id)))
    if (created.worktree && repoRoot) await attempt(() => git.removeWorktree(repoRoot!, created.worktree!, true))
    if (created.worktree) await attempt(() => rm(created.worktree!, { recursive: true, force: true }))
    if (created.branch && repoRoot) await attempt(() => git.deleteBranch(repoRoot!, created.branch!))
    await attempt(() => rm(dir, { recursive: true, force: true }))
  }

  try {
    const sub = deps.store.state.subProjects.find((s) => s.id === input.subProjectId)
    if (!sub) throw new StepError('identity', 'Sub-project not found.')
    const project = deps.store.state.projects.find((p) => p.id === sub.projectId)
    if (!project) throw new StepError('identity', 'Project not found.')
    repoRoot = sub.kind === 'repo' ? sub.repoRoot : undefined

    await run('identity', () => checkIdentity(project, deps))

    const title = input.title.trim() || 'Untitled'
    const slug = slugify(title)
    let cwd = sub.path
    let worktreePath: string | undefined
    let branch: string | undefined
    let baseBranch: string | undefined
    let baseCommit: string | undefined

    if (repoRoot) {
      const root = repoRoot
      await run('worktree', async () => {
        if (!(await git.hasCommits(root))) {
          throw new Error('This repo has no commits yet. Make a first commit, then start a session.')
        }
        let base: string | undefined
        if (input.branchMode === 'new') {
          const wanted = input.branch.trim() || defaultBranchName(slug)
          if (!(await git.isValidBranchName(wanted))) throw new Error(`Branch name isn't valid: ${wanted}`)
          branch = await git.uniqueBranchName(root, wanted)
          const main = await git.defaultBranch(root)
          base = input.baseBranch ?? main ?? 'HEAD'
          baseBranch = input.baseBranch ?? main ?? undefined
          baseCommit = await git.revParse(root, base)
        } else {
          const wanted = input.branch.trim()
          if (!wanted || !(await git.branchExists(root, wanted))) throw new Error(`Branch ${wanted} doesn't exist.`)
          const other = (await git.listBranches(root)).find((b) => b.name === wanted)?.checkedOutAt
          if (other) throw new Error(`Branch ${wanted} is already checked out in ${other}.`)
          const main = await git.defaultBranch(root)
          if (wanted === main) {
            throw new Error(`${wanted} is the repo's main branch. Start a new branch from it instead, so ${wanted} stays free to check out in your own folder.`)
          }
          branch = wanted
          const cmp = input.baseBranch ?? main ?? undefined
          baseBranch = cmp && cmp !== wanted ? cmp : undefined
          baseCommit = await git.revParse(root, baseBranch ?? wanted)
        }
        const desired = join(paths.worktreesRoot, slugify(sub.name), slug)
        worktreePath = await uniquePath(desired)
        // Mark before creating so a partial failure is still cleaned up.
        created.worktree = worktreePath
        if (input.branchMode === 'new') created.branch = branch
        await git.addWorktree({ repoRoot: root, path: worktreePath, branch, mode: input.branchMode, base })
        cwd = join(worktreePath, sub.relPath ?? '')
      })
    } else {
      emit('worktree', 'running')
      emit('worktree', 'done', 'No git — runs in the folder')
    }

    const session: Session = {
      id,
      subProjectId: sub.id,
      title,
      slug,
      claudeSessionId: randomUUID(),
      cwd,
      worktreePath,
      branch,
      branchCreatedByPitwall: input.branchMode === 'new' && !!repoRoot,
      baseBranch,
      baseCommit,
      createdAt: Date.now(),
      lastViewedAt: Date.now()
    }

    await run('files', () => writeSessionFiles(session, deps))
    await run('tmux', async () => {
      created.tmux = true
      await launchTmuxFor(session, deps)
      await deps.store.update((d) => {
        d.sessions.push(session)
      })
    })

    // Never wait for Claude here: real Claude first asks whether to trust the new folder, and only the terminal
    // can answer that. The manager shows a hint if no hook event arrives in time.
    emit('claude', 'running')
    emit('claude', 'done', 'Started — answer any prompt in the terminal')
    return { ok: true, sessionId: id }
  } catch (e) {
    await rollback()
    const s = e instanceof StepError ? e.step : steps.step
    return { ok: false, step: s, error: msg(e) }
  }
}
