import { randomUUID } from 'node:crypto'
import { access, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '../atomic'
import type { LauncherChoice, SessionBackend } from '../backend'
import type {
  NewSessionDefaults, NewSessionInput, Project, Session, StartProgress, StartResult, StartStep, SubProject
} from '@shared/types'
import { defaultBranchName, slugify } from '@shared/slug'
import type { Exec } from '../exec'
import { GitClient, uniquePath } from '../git'
import { isFile } from '../exec'
import {
  buildHookSettings, findUserStatusLine, hookCommandFor, statusLineCommandFor, windowsHookCommand, windowsStatusLineCommand
} from '../hooks/settings'
import { buildSessionEnv, claudeConfigDir, getGhToken, renderEnvFile } from '../identity'
import { eventsFile, sessionDir, type AppPaths } from '../paths'
import { findGitBash, windowsPowerShell } from '../platform'
import { newId, type Store } from '../store'
import { claudeTmuxName } from '../tmux'
import type { KeyedMutex } from './mutex'

export type { NewSessionDefaults, NewSessionInput, StartProgress, StartResult, StartStep }

export interface StarterDeps {
  store: Store
  paths: AppPaths
  git: GitClient
  backend: SessionBackend
  exec: Exec
  env: Record<string, string>
  home: string
  mutex: KeyedMutex
  /** Default: this machine's. Tests pass 'win32' to check what Windows gets. */
  platform?: NodeJS.Platform
  /** What starts Claude (see launcherChoice). Default: the host's launcher on Windows, pitwall-launch elsewhere. */
  launcher?: LauncherChoice
}

/** True when the host's launcher runs this app's sessions (Windows; PITWALL_LAUNCHER=host elsewhere). */
export function usesHostLauncher(deps: Pick<StarterDeps, 'launcher' | 'platform'>): boolean {
  return (deps.launcher ?? ((deps.platform ?? process.platform) === 'win32' ? 'host' : 'script')) === 'host'
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
  const home = key === '~' || key.startsWith('~/') || ((deps.platform ?? process.platform) === 'win32' && key.startsWith('~\\'))
  const keyPath = home ? join(deps.home, key.slice(2)) : key
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
  const windows = (deps.platform ?? process.platform) === 'win32'
  const userStatusLine = await findUserStatusLine(session.cwd, claudeConfigDir(project, deps.home, deps.env))
  const env = buildSessionEnv({
    project,
    session,
    rootPath: sp.repoRoot ?? sp.path,
    sessionDir: dir,
    eventsFile: events,
    claudeBin: deps.paths.claudeBin,
    ghBin: deps.paths.ghBin,
    setupCommand: sp.setupCommand,
    userStatusLine,
    gitBash: windows && userStatusLine ? findGitBash(deps.env, isFile) ?? undefined : undefined,
    home: deps.home,
    platform: deps.platform
  })
  await mkdir(dir, { recursive: true })
  // Atomic: a relaunching launcher may be sourcing env.sh while a project edit rewrites it.
  await writeFileAtomic(join(dir, 'env.sh'), renderEnvFile(env), 0o600)
  // The same for the host's launcher (Windows), which reads JSON, not sh.
  await writeFileAtomic(join(dir, 'env.json'), JSON.stringify(env, null, 2) + '\n', 0o600)
  // Windows: PowerShell scripts, the hook in exec form (no shell between Claude and the paths).
  const hook = windows
    ? windowsHookCommand(windowsPowerShell(deps.env), join(deps.paths.binDir, 'pitwall-hook.ps1'), events, session.id)
    : hookCommandFor(join(deps.paths.binDir, 'pitwall-hook'), events, session.id)
  const statusLine = windows
    ? windowsStatusLineCommand(join(deps.paths.binDir, 'pitwall-statusline.ps1'), dir)
    : statusLineCommandFor(join(deps.paths.binDir, 'pitwall-statusline'), dir)
  // Atomic: a running Claude or the launcher may read these at any moment.
  await writeFileAtomic(join(dir, 'hooks.json'), JSON.stringify(buildHookSettings(hook, statusLine), null, 2))
  // Re-read: a /clear may have recorded a new conversation id while the files above were written.
  const claudeId = deps.store.state.sessions.find((x) => x.id === session.id)?.claudeSessionId ?? session.claudeSessionId
  await writeFileAtomic(join(dir, 'claude-id'), claudeId + '\n')
  // Read by the launcher at every start of Claude (written again here, so it follows the session to a new folder).
  if (session.continuedFrom) await writeFileAtomic(join(dir, 'continue-note.txt'), continueNote(session))
}

/**
 * What Claude is told in a session that continues a conversation run outside Pitwall. Its recorded system prompt names
 * the folder the conversation began in, so the launcher has Claude rebuild it for this session's folder, with this
 * note. In a worktree: work there, and leave the folder it began in alone. In a folder without git the session runs in
 * that folder (or the one around it), so there's nothing to keep out of.
 */
export function continueNote(s: Pick<Session, 'cwd' | 'worktreePath' | 'branch' | 'continuedFrom'>): string {
  const from = s.continuedFrom ?? ''
  if (!s.worktreePath) return `This conversation began in ${from}. It now continues in ${s.cwd}. Work only in ${s.cwd}.\n`
  const on = s.branch ? `, on branch ${s.branch}` : ''
  return `This conversation began in ${from}. It now continues in a separate git worktree at ${s.cwd}${on}. ` +
    `Work only in ${s.cwd}: don't read from or change files under ${from}.\n`
}

/** tmux would silently start in $HOME instead; an agent must never run in the wrong folder. */
export async function assertSessionFolder(cwd: string): Promise<void> {
  const st = await stat(cwd).catch(() => null)
  if (!st?.isDirectory()) throw new Error(`Session folder not found: ${cwd}`)
}

export async function launchTmuxFor(session: Session, deps: StarterDeps): Promise<void> {
  await assertSessionFolder(session.cwd)
  const dir = sessionDir(deps.paths, session.id)
  if (usesHostLauncher(deps)) {
    // The host runs Claude itself, as pitwall-launch would (Windows has no sh).
    await deps.backend.newSession({ name: claudeTmuxName(session.id), cwd: session.cwd, argv: [], launcher: { kind: 'claude', sessionDir: dir } })
    return
  }
  await deps.backend.newSession({
    name: claudeTmuxName(session.id),
    cwd: session.cwd,
    argv: [join(deps.paths.binDir, 'pitwall-launch'), dir]
  })
}

/** The lock starting a session in a folder takes: starts and resumes in one repo pick free folder and branch names. */
export function startLockKey(deps: Pick<StarterDeps, 'store'>, subProjectId: string): string {
  const sp = deps.store.state.subProjects.find((s) => s.id === subProjectId)
  return sp ? (sp.repoRoot ?? sp.path) : subProjectId
}

export function startSession(
  input: NewSessionInput,
  deps: StarterDeps,
  onProgress: (p: StartProgress) => void
): Promise<StartResult> {
  return deps.mutex
    .run(startLockKey(deps, input.subProjectId), () => startSessionLocked(input, deps, onProgress))
    .catch((e): StartResult => ({ ok: false, step: 'identity', error: msg(e) }))
}

/** startSession, for a caller that holds deps.mutex for startLockKey already. On failure nothing is left behind. */
export async function startSessionLocked(
  input: NewSessionInput,
  deps: StarterDeps,
  onProgress: (p: StartProgress) => void
): Promise<StartResult> {
  const steps = progressSteps(input.requestId, onProgress)
  const { emit, run } = steps
  const { paths, git, backend } = deps
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
    if (created.tmux) await attempt(() => backend.killSession(claudeTmuxName(id)))
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
      claudeSessionId: input.continueClaudeId ?? randomUUID(),
      cwd,
      worktreePath,
      branch,
      branchCreatedByPitwall: input.branchMode === 'new' && !!repoRoot,
      baseBranch,
      baseCommit,
      createdAt: Date.now(),
      lastViewedAt: Date.now()
    }
    if (input.continueClaudeId && input.continuedFrom) session.continuedFrom = input.continuedFrom

    await run('files', async () => {
      await writeSessionFiles(session, deps)
      // A conversation to continue exists already: the launcher resumes it (as after resuming an archived session).
      if (input.continueClaudeId) await writeFile(join(dir, 'started'), '')
    })
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
