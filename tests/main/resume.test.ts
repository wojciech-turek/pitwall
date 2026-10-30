import { execFile } from 'node:child_process'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { exec } from '../../src/main/exec'
import { GitClient } from '../../src/main/git'
import { sessionDir } from '../../src/main/paths'
import { archiveSession, type ArchiveDeps } from '../../src/main/sessions/archive'
import { SessionManager } from '../../src/main/sessions/manager'
import { KeyedMutex } from '../../src/main/sessions/mutex'
import { resumeSession } from '../../src/main/sessions/resume'
import { Store } from '../../src/main/store'
import { claudeTmuxName, type Tmux } from '../../src/main/tmux'
import type { NewSessionInput, Project, Session, StartProgress, SubProject } from '../../src/shared/types'
import { makeTestEnv } from '../helpers/env'
import { makeRepo } from '../helpers/repo'
import { waitFor } from '../helpers/wait'

const run = promisify(execFile)
const has = (p: string) => access(p).then(() => true, () => false)

let t: Awaited<ReturnType<typeof makeTestEnv>>
let repos: Awaited<ReturnType<typeof makeRepo>>[] = []
let store: Store
let manager: SessionManager
let deps: ArchiveDeps
let progress: StartProgress[]
let claudeLog: string

const project: Project = {
  id: 'p_1', name: 'P', createdAt: 0, extraEnv: [],
  identity: { sshKeyPath: '', ghAccount: 'dev-work', gitName: 'Jane', gitEmail: 'm@x.io' }
}

beforeEach(async () => {
  t = await makeTestEnv()
  repos = []
  progress = []
  claudeLog = join(t.tmp, 'claude.log')
  t.env.STUB_CLAUDE_LOG = claudeLog
  await mkdir(t.paths.sshDir, { recursive: true })
  project.identity.sshKeyPath = join(t.paths.sshDir, 'id_test')
  await writeFile(project.identity.sshKeyPath, 'fake')
  store = await Store.open(t.paths.stateFile)
  await store.update((d) => {
    d.projects.push(structuredClone(project))
  })
})
afterEach(async () => {
  manager?.dispose()
  for (const r of repos) await r.cleanup()
  await t.cleanup()
})

function setup(gitEnv: Record<string, string>, over: Partial<ArchiveDeps> = {}): ArchiveDeps {
  const git = new GitClient(exec, gitEnv)
  manager?.dispose()
  const base = { store, paths: t.paths, git, tmux: t.tmux, exec, env: t.env, home: t.tmp, mutex: new KeyedMutex() }
  manager = new SessionManager({ ...base, ...over, firstEventTimeoutMs: 8000, notifier: { notify: () => {}, setBadge: () => {} } })
  deps = {
    ...base, manager, ...over,
    ptyBridge: { close: () => {} } as unknown as ArchiveDeps['ptyBridge']
  }
  return deps
}

async function addRepo() {
  const r = await makeRepo({ dirName: 'tax-service' })
  repos.push(r)
  const sp: SubProject = {
    id: 'sp_1', projectId: 'p_1', name: 'tax-service', kind: 'repo', path: r.root, repoRoot: r.root, relPath: '', createdAt: 0
  }
  await store.update((d) => {
    d.subProjects.push(sp)
  })
  setup(r.env)
  return { r, sp }
}

async function addFolder(name = 'notes') {
  const folder = join(t.tmp, name)
  await mkdir(folder, { recursive: true })
  const sp: SubProject = { id: `sp_${name}`, projectId: 'p_1', name, kind: 'folder', path: folder, createdAt: 0 }
  await store.update((d) => {
    d.subProjects.push(sp)
  })
  setup(t.env)
  return { folder, sp }
}

const input = (sp: SubProject, o: Partial<NewSessionInput> = {}): NewSessionInput => ({
  requestId: 'r1', subProjectId: sp.id, title: 'Fix tax rounding', branchMode: 'new', branch: '', ...o
})
const get = (id: string): Session => store.state.sessions.find((s) => s.id === id)!
async function startOne(sp: SubProject, o: Partial<NewSessionInput> = {}): Promise<Session> {
  const res = await manager.start(input(sp, o), () => {})
  if (!res.ok) throw new Error(res.error)
  const s = get(res.sessionId)
  await waitFor(async () => (await readFile(claudeLog, 'utf8').catch(() => '')).includes(`--session-id ${s.claudeSessionId}`), 8000, 'claude started')
  return s
}
async function archive(s: Session, confirmedDataLoss = false): Promise<void> {
  const res = await archiveSession(s.id, { confirmedDataLoss }, deps)
  expect(res).toEqual({ ok: true })
  expect(get(s.id).archivedAt).toBeGreaterThan(0)
}
const resume = (id: string, d: ArchiveDeps = deps) => resumeSession(id, 'rq', d, (p) => progress.push(p))
const git = (r: { env: Record<string, string> }, cwd: string, ...args: string[]) => run('git', args, { cwd, env: r.env })
const branchesOf = async (r: { root: string; env: Record<string, string> }) =>
  (await git(r, r.root, 'branch', '--format=%(refname:short)')).stdout.split('\n').filter(Boolean)
const worktrees = async (r: { root: string; env: Record<string, string> }) =>
  (await git(r, r.root, 'worktree', 'list', '--porcelain')).stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9))

/** Nothing of a failed resume is left: still archived, no tmux, no session files, the given folder not created. */
async function expectNothingCreated(s: Session, notCreated?: string) {
  expect(get(s.id).archivedAt).toBeGreaterThan(0)
  expect(await t.tmux.hasSession(claudeTmuxName(s.id))).toBe(false)
  expect(await has(sessionDir(t.paths, s.id))).toBe(false)
  if (notCreated) expect(await has(notCreated)).toBe(false)
  expect(manager.snapshot().sessions.map((x) => x.id)).not.toContain(s.id)
}

describe('resumeSession', () => {
  test('back in the same worktree folder, on a new branch from main when its branch is gone; the conversation resumes', async () => {
    const { r, sp } = await addRepo()
    const s = await startOne(sp)
    await archive(s)
    expect(await branchesOf(r)).toEqual(['main']) // Pitwall's branch went with the archive
    expect(await has(s.worktreePath!)).toBe(false)

    const res = await manager.resume(s.id, 'rq', (p) => progress.push(p))
    expect(res).toEqual({ ok: true, sessionId: s.id })
    const back = get(s.id)
    expect(back.archivedAt).toBeUndefined()
    expect(back.worktreePath).toBe(s.worktreePath)
    expect(back.cwd).toBe(s.cwd)
    expect(back.branch).toBe('pitwall/fix-tax-rounding')
    expect(back.branchCreatedByPitwall).toBe(true)
    expect(back.baseBranch).toBe('main')
    expect(back.claudeSessionId).toBe(s.claudeSessionId)
    expect((await git(r, s.worktreePath!, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()).toBe('pitwall/fix-tax-rounding')
    expect(await t.tmux.hasSession(claudeTmuxName(s.id))).toBe(true)
    expect(await has(join(sessionDir(t.paths, s.id), 'started'))).toBe(true)
    await waitFor(async () => (await readFile(claudeLog, 'utf8')).includes(`--resume ${s.claudeSessionId}`), 8000, 'claude --resume')
    expect((await readFile(claudeLog, 'utf8')).match(/--session-id/g)).toHaveLength(1) // only the original start
    const steps = ['identity', 'worktree', 'files', 'tmux', 'claude']
    expect(progress.map((p) => `${p.step}:${p.state}`)).toEqual(steps.flatMap((x) => [`${x}:running`, `${x}:done`]))
    expect(progress.every((p) => p.requestId === 'rq')).toBe(true)
    expect(progress.at(-1)?.message).toBe('Resumed — answer any prompt in the terminal')
    const snap = manager.snapshot()
    expect(snap.sessions.map((x) => x.id)).toEqual([s.id])
    expect(snap.archived).toEqual([])
    await waitFor(async () => manager.snapshot().sessions[0].status !== 'starting', 8000, 'tracked')
  })

  test('the original branch is reused when it still exists', async () => {
    const { r, sp } = await addRepo()
    await git(r, r.root, 'checkout', '-b', 'feature/x')
    await writeFile(join(r.root, 'x.txt'), 'x')
    await git(r, r.root, 'add', '-A')
    await git(r, r.root, 'commit', '-m', 'x')
    await git(r, r.root, 'checkout', 'main')
    const s = await startOne(sp, { branchMode: 'existing', branch: 'feature/x' })
    await writeFile(join(s.worktreePath!, 'y.txt'), 'y')
    await git(r, s.worktreePath!, 'add', '-A')
    await git(r, s.worktreePath!, 'commit', '-m', 'agent work')
    const head = (await git(r, s.worktreePath!, 'rev-parse', 'HEAD')).stdout.trim()
    await archive(s, true)
    expect(await branchesOf(r)).toContain('feature/x')

    const res = await resume(s.id)
    expect(res.ok).toBe(true)
    const back = get(s.id)
    expect(back.branch).toBe('feature/x')
    expect(back.branchCreatedByPitwall).toBe(false)
    expect(back.baseCommit).toBe(s.baseCommit)
    expect(back.worktreePath).toBe(s.worktreePath)
    expect((await git(r, s.worktreePath!, 'rev-parse', 'HEAD')).stdout.trim()).toBe(head)
    expect(await readFile(join(s.worktreePath!, 'y.txt'), 'utf8')).toBe('y')
  })

  test("original folder now used by another session: a new folder, and the other session's is left alone", async () => {
    const { r, sp } = await addRepo()
    const a = await startOne(sp)
    await archive(a)
    const b = await startOne(sp) // same title: gets the same folder and branch name
    expect(b.worktreePath).toBe(a.worktreePath)
    await writeFile(join(b.worktreePath!, 'b-work.txt'), 'b')

    const res = await resume(a.id)
    expect(res).toEqual({ ok: true, sessionId: a.id })
    const back = get(a.id)
    expect(back.worktreePath).toBe(`${a.worktreePath}-2`)
    expect(back.cwd).toBe(`${a.worktreePath}-2`)
    expect(back.branch).toBe('pitwall/fix-tax-rounding-2')
    expect(await readFile(join(b.worktreePath!, 'b-work.txt'), 'utf8')).toBe('b')
    expect((await git(r, b.worktreePath!, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()).toBe(b.branch)
    expect(await t.tmux.hasSession(claudeTmuxName(b.id))).toBe(true)
    await waitFor(async () => (await readFile(claudeLog, 'utf8')).includes(`--resume ${a.claudeSessionId}`), 8000, 'claude --resume')
  })

  test('original folder taken by something else: a new folder on the same branch; the folder is left alone', async () => {
    const { r, sp } = await addRepo()
    await git(r, r.root, 'branch', 'feature/x')
    const s = await startOne(sp, { branchMode: 'existing', branch: 'feature/x' })
    await archive(s)
    await mkdir(s.worktreePath!, { recursive: true })
    await writeFile(join(s.worktreePath!, 'mine.txt'), 'keep')
    const res = await resume(s.id)
    expect(res.ok).toBe(true)
    expect(get(s.id).worktreePath).toBe(`${s.worktreePath}-2`)
    expect(get(s.id).branch).toBe('feature/x')
    expect(await readFile(join(s.worktreePath!, 'mine.txt'), 'utf8')).toBe('keep')
  })

  test('the repo is gone: a clear error and nothing is created', async () => {
    const { r, sp } = await addRepo()
    const s = await startOne(sp)
    await archive(s)
    await rm(r.root, { recursive: true, force: true })
    const res = await resume(s.id)
    expect(res).toEqual({ ok: false, step: 'worktree', error: `The repo isn't there any more: ${r.root}` })
    await expectNothingCreated(get(s.id), s.worktreePath)
    expect(progress.find((p) => p.state === 'failed')).toMatchObject({ step: 'worktree' })
  })

  test('the folder is no longer a git repo: a clear error', async () => {
    const { r, sp } = await addRepo()
    const s = await startOne(sp)
    await archive(s)
    await rm(join(r.root, '.git'), { recursive: true, force: true })
    const res = await resume(s.id)
    expect(res).toEqual({ ok: false, step: 'worktree', error: `This folder isn't a git repo any more: ${r.root}` })
    await expectNothingCreated(get(s.id), s.worktreePath)
  })

  test('the branch is checked out elsewhere: a clear error and nothing is created', async () => {
    const { r, sp } = await addRepo()
    await git(r, r.root, 'branch', 'feature/x')
    const s = await startOne(sp, { branchMode: 'existing', branch: 'feature/x' })
    await archive(s)
    await git(r, r.root, 'checkout', 'feature/x')
    const res = await resume(s.id)
    expect(res).toEqual({
      ok: false, step: 'worktree',
      error: `Branch feature/x is checked out in ${r.root}. Switch that folder to another branch, then resume.`
    })
    await expectNothingCreated(get(s.id), s.worktreePath)
    expect(await worktrees(r)).toEqual([r.root])
    expect(await branchesOf(r)).toEqual(['feature/x', 'main'])
  })

  test('a failure after the worktree is made removes the worktree and the new branch', async () => {
    const { r, sp } = await addRepo()
    const s = await startOne(sp)
    await archive(s)
    const broken = Object.assign(Object.create(t.tmux) as Tmux, {
      newSession: async () => { throw new Error('tmux broke') }
    })
    const res = await resume(s.id, { ...deps, tmux: broken })
    expect(res).toEqual({ ok: false, step: 'tmux', error: 'tmux broke' })
    await expectNothingCreated(get(s.id), s.worktreePath)
    expect(await worktrees(r)).toEqual([r.root])
    expect(await branchesOf(r)).toEqual(['main'])
    // And it can be resumed once tmux works again.
    expect((await resume(s.id)).ok).toBe(true)
  })

  test('a worktree folder deleted by hand before archiving: resumes at the same path', async () => {
    const { r, sp } = await addRepo()
    const s = await startOne(sp)
    await rm(s.worktreePath!, { recursive: true, force: true })
    await archive(s, true)
    const res = await resume(s.id)
    expect(res.ok).toBe(true)
    expect(get(s.id).worktreePath).toBe(s.worktreePath)
    expect(await worktrees(r)).toEqual([r.root, s.worktreePath])
  })

  test('only an archived session can be resumed', async () => {
    const { sp } = await addRepo()
    const s = await startOne(sp)
    const res = await resume(s.id)
    expect(res).toEqual({ ok: false, step: 'identity', error: 'This session is already running.' })
    expect(await t.tmux.hasSession(claudeTmuxName(s.id))).toBe(true)
    expect(await resume('s_nope')).toEqual({ ok: false, step: 'identity', error: 'Session not found.' })
  })

  test('two resumes at once: one wins, the other is told it is running', async () => {
    const { sp } = await addRepo()
    const s = await startOne(sp)
    await archive(s)
    const results = await Promise.all([resume(s.id), resume(s.id)])
    expect(results.filter((x) => x.ok)).toHaveLength(1)
    expect(results.find((x) => !x.ok)).toEqual({ ok: false, step: 'identity', error: 'This session is already running.' })
  })

  test("a session whose folder was removed from Pitwall can't be resumed", async () => {
    const { sp } = await addFolder()
    const s = await startOne(sp)
    await archive(s)
    await store.update((d) => { d.subProjects = [] })
    expect(await resume(s.id)).toEqual({
      ok: false, step: 'identity', error: "This session's folder was removed from Pitwall. Add it again to start new sessions there."
    })
    await expectNothingCreated(get(s.id))
  })

  test('a folder session resumes in its folder', async () => {
    const { folder, sp } = await addFolder()
    const s = await startOne(sp)
    await archive(s)
    const res = await manager.resume(s.id, 'rq', (p) => progress.push(p))
    expect(res.ok).toBe(true)
    expect(get(s.id).cwd).toBe(folder)
    expect(get(s.id).worktreePath).toBeUndefined()
    expect(progress.find((p) => p.step === 'worktree' && p.state === 'done')?.message).toBe('No git — runs in the folder')
    await waitFor(async () => (await readFile(claudeLog, 'utf8')).includes(`--resume ${s.claudeSessionId}`), 8000, 'claude --resume')
  })

  test('a folder session whose folder is gone fails clearly', async () => {
    const { folder, sp } = await addFolder()
    const s = await startOne(sp)
    await archive(s)
    await rm(folder, { recursive: true, force: true })
    expect(await resume(s.id)).toEqual({ ok: false, step: 'worktree', error: `Folder not found: ${folder}` })
    await expectNothingCreated(get(s.id), folder)
  })

  test('the conversation id at resume is the latest one (after /clear)', async () => {
    const { sp } = await addFolder()
    const s = await startOne(sp)
    await t.tmux.sendKeys(claudeTmuxName(s.id), ['clear', 'Enter'])
    await waitFor(async () => get(s.id).claudeSessionId === `${s.claudeSessionId}-cleared`, 8000, 'cleared')
    await archive(s)
    expect((await resume(s.id)).ok).toBe(true)
    expect(await readFile(join(sessionDir(t.paths, s.id), 'claude-id'), 'utf8')).toBe(`${s.claudeSessionId}-cleared\n`)
    expect(get(s.id).pastClaudeIds).toEqual([s.claudeSessionId])
  })
})
