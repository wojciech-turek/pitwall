import { execFile, spawn } from 'node:child_process'
import { access, appendFile, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { exec } from '../../src/main/exec'
import { GitClient } from '../../src/main/git'
import { sessionDir } from '../../src/main/paths'
import { archiveSession, checkArchive, type ArchiveDeps } from '../../src/main/sessions/archive'
import { SessionManager } from '../../src/main/sessions/manager'
import { KeyedMutex } from '../../src/main/sessions/mutex'
import { Store } from '../../src/main/store'
import { claudeTmuxName, shellTmuxName } from '../../src/main/tmux'
import type { NewSessionInput, Project, Session, SubProject } from '../../src/shared/types'
import { makeTestEnv } from '../helpers/env'
import { makeRepo } from '../helpers/repo'

const run = promisify(execFile)
const has = (p: string) => access(p).then(() => true, () => false)

let t: Awaited<ReturnType<typeof makeTestEnv>>
let repos: Awaited<ReturnType<typeof makeRepo>>[] = []
let store: Store
let manager: SessionManager
let git: GitClient
let closed: string[]

const project: Project = {
  id: 'p_1', name: 'P', createdAt: 0, extraEnv: [],
  identity: { sshKeyPath: '', ghAccount: 'dev-work', gitName: 'Jane', gitEmail: 'm@x.io' }
}

beforeEach(async () => {
  t = await makeTestEnv()
  repos = []
  closed = []
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

function setup(gitEnv: Record<string, string>, g?: GitClient): ArchiveDeps {
  git = g ?? new GitClient(exec, gitEnv)
  manager = new SessionManager({
    store, paths: t.paths, git, tmux: t.tmux, exec, env: t.env, home: t.tmp, mutex: new KeyedMutex(),
    firstEventTimeoutMs: 8000, notifier: { notify: () => {}, setBadge: () => {} }
  })
  return {
    store, paths: t.paths, git, tmux: t.tmux, exec, env: t.env, home: t.tmp, mutex: new KeyedMutex(), manager,
    ptyBridge: { close: (id: string, kind: string) => { closed.push(`${id}:${kind}`) } } as unknown as ArchiveDeps['ptyBridge']
  }
}

async function addRepo(o: { remote?: boolean } = {}) {
  const r = await makeRepo({ remote: o.remote })
  repos.push(r)
  const sp: SubProject = {
    id: 'sp_1', projectId: 'p_1', name: 'My Repo', kind: 'repo', path: r.root, repoRoot: r.root, relPath: '', createdAt: 0
  }
  await store.update((d) => {
    d.subProjects.push(sp)
  })
  return { r, sp, deps: setup(r.env) }
}

const input = (sp: SubProject, o: Partial<NewSessionInput> = {}): NewSessionInput => ({
  requestId: 'r1', subProjectId: sp.id, title: 'Fix tax rounding', branchMode: 'new', branch: '', ...o
})
async function startOne(sp: SubProject, o: Partial<NewSessionInput> = {}): Promise<Session> {
  const res = await manager.start(input(sp, o), () => {})
  if (!res.ok) throw new Error(res.error)
  return store.state.sessions.find((s) => s.id === res.sessionId)!
}
const branchesOf = async (r: { root: string; env: Record<string, string> }) =>
  (await run('git', ['branch', '--format=%(refname:short)'], { cwd: r.root, env: r.env })).stdout.split('\n').filter(Boolean)
const sh = (r: { env: Record<string, string> }, cwd: string, ...args: string[]) => run('git', args, { cwd, env: r.env })

describe('archive', () => {
  test('clean pushed session archives fully', async () => {
    const { r, sp, deps } = await addRepo({ remote: true })
    const s = await startOne(sp)
    await sh(r, s.worktreePath!, 'push', 'origin', s.branch!)
    const check = await checkArchive(s.id, deps)
    expect(check).toMatchObject({
      uncommittedFiles: 0, unpushedCommits: 0, hasRemote: true, branch: s.branch,
      willDeleteBranch: true, willRemoveWorktree: true, worktreePath: s.worktreePath
    })
    expect(await archiveSession(s.id, { confirmedDataLoss: false }, deps)).toEqual({ ok: true })
    expect(await has(s.worktreePath!)).toBe(false)
    expect(await branchesOf(r)).toEqual(['main'])
    expect(await t.tmux.hasSession(claudeTmuxName(s.id))).toBe(false)
    expect(await t.tmux.hasSession(shellTmuxName(s.id))).toBe(false)
    expect(await has(sessionDir(t.paths, s.id))).toBe(false)
    expect(closed.sort()).toEqual([`${s.id}:claude`, `${s.id}:shell`])
    const snap = manager.snapshot()
    expect(snap.sessions).toHaveLength(0)
    expect(snap.archived.map((x) => x.id)).toEqual([s.id])
    expect(snap.archived[0].archivedAt).toBeGreaterThan(0)
  })

  test('dirty session needs confirmation and touches nothing', async () => {
    const { sp, deps } = await addRepo()
    const s = await startOne(sp)
    await writeFile(join(s.worktreePath!, 'wip.txt'), 'x')
    const res = await archiveSession(s.id, { confirmedDataLoss: false }, deps)
    expect(res).toMatchObject({ ok: false, needsConfirm: { uncommittedFiles: 1 } })
    expect(await has(s.worktreePath!)).toBe(true)
    expect(await t.tmux.hasSession(claudeTmuxName(s.id))).toBe(true)
    expect(closed).toEqual([])
    expect(store.state.sessions[0].archivedAt).toBeUndefined()
    expect(manager.snapshot().sessions).toHaveLength(1)
  })

  test('confirmed dirty session archives', async () => {
    const { r, sp, deps } = await addRepo()
    const s = await startOne(sp)
    await writeFile(join(s.worktreePath!, 'wip.txt'), 'x')
    expect(await archiveSession(s.id, { confirmedDataLoss: true }, deps)).toEqual({ ok: true })
    expect(await has(s.worktreePath!)).toBe(false)
    expect(await branchesOf(r)).toEqual(['main'])
    expect(manager.snapshot().archived).toHaveLength(1)
  })

  test('local-only commits count as unpushed', async () => {
    const { r, sp, deps } = await addRepo()
    const s = await startOne(sp)
    await writeFile(join(s.worktreePath!, 'a.txt'), 'a')
    await sh(r, s.worktreePath!, 'add', '-A')
    await sh(r, s.worktreePath!, 'commit', '-m', 'local')
    const check = await checkArchive(s.id, deps)
    expect(check).toMatchObject({ uncommittedFiles: 0, unpushedCommits: 1 })
    const res = await archiveSession(s.id, { confirmedDataLoss: false }, deps)
    expect(res).toMatchObject({ ok: false, needsConfirm: { unpushedCommits: 1 } })
    expect(await has(s.worktreePath!)).toBe(true)
  })

  test('worktree folder deleted by hand: unpushed commits on the branch still need confirmation', async () => {
    const { r, sp, deps } = await addRepo()
    const s = await startOne(sp)
    await writeFile(join(s.worktreePath!, 'a.txt'), 'a')
    await sh(r, s.worktreePath!, 'add', '-A')
    await sh(r, s.worktreePath!, 'commit', '-m', 'local only')
    await rm(s.worktreePath!, { recursive: true, force: true })
    const check = await checkArchive(s.id, deps)
    expect(check).toMatchObject({ willRemoveWorktree: false, willDeleteBranch: true, unpushedCommits: 1 })
    const res = await archiveSession(s.id, { confirmedDataLoss: false }, deps)
    expect(res).toMatchObject({ ok: false, needsConfirm: { unpushedCommits: 1 } })
    expect(await branchesOf(r)).toContain(s.branch)
    expect(store.state.sessions[0].archivedAt).toBeUndefined()
  })

  test('worktree folder deleted by hand, nothing unpushed: archives without asking', async () => {
    const { sp, deps } = await addRepo()
    const s = await startOne(sp)
    await rm(s.worktreePath!, { recursive: true, force: true })
    expect(await checkArchive(s.id, deps)).toMatchObject({ willRemoveWorktree: false, willDeleteBranch: true, unpushedCommits: 0 })
    expect(await archiveSession(s.id, { confirmedDataLoss: false }, deps)).toEqual({ ok: true })
  })

  test('existing-branch session keeps its branch', async () => {
    const { r, sp, deps } = await addRepo()
    await sh(r, r.root, 'branch', 'feature/keep')
    const s = await startOne(sp, { branchMode: 'existing', branch: 'feature/keep' })
    const check = await checkArchive(s.id, deps)
    expect(check).toMatchObject({ willDeleteBranch: false, willRemoveWorktree: true })
    expect(await archiveSession(s.id, { confirmedDataLoss: false }, deps)).toEqual({ ok: true })
    expect(await has(s.worktreePath!)).toBe(false)
    expect(await branchesOf(r)).toContain('feature/keep')
  })

  test('branch renamed by the agent is left alone', async () => {
    const { r, sp, deps } = await addRepo()
    const s = await startOne(sp)
    await sh(r, s.worktreePath!, 'branch', '-m', 'renamed-by-agent')
    expect((await checkArchive(s.id, deps)).willDeleteBranch).toBe(false)
    expect(await archiveSession(s.id, { confirmedDataLoss: false }, deps)).toEqual({ ok: true })
    expect(await branchesOf(r)).toContain('renamed-by-agent')
  })

  test('research folder only stops the agent', async () => {
    const folder = join(t.tmp, 'research')
    await mkdir(folder)
    await writeFile(join(folder, 'notes.md'), 'keep me')
    const sp: SubProject = { id: 'sp_f', projectId: 'p_1', name: 'R', kind: 'folder', path: folder, createdAt: 0 }
    await store.update((d) => {
      d.subProjects.push(sp)
    })
    const deps = setup(t.env)
    const s = await startOne(sp)
    expect(await checkArchive(s.id, deps)).toMatchObject({
      uncommittedFiles: 0, unpushedCommits: 0, willDeleteBranch: false, willRemoveWorktree: false
    })
    expect(await archiveSession(s.id, { confirmedDataLoss: false }, deps)).toEqual({ ok: true })
    expect(await has(join(folder, 'notes.md'))).toBe(true)
    expect(await t.tmux.hasSession(claudeTmuxName(s.id))).toBe(false)
    expect(manager.snapshot().archived).toHaveLength(1)
  })

  test('worktree removal failure leaves session running', async () => {
    const r = await makeRepo()
    repos.push(r)
    const sp: SubProject = {
      id: 'sp_1', projectId: 'p_1', name: 'My Repo', kind: 'repo', path: r.root, repoRoot: r.root, relPath: '', createdAt: 0
    }
    await store.update((d) => {
      d.subProjects.push(sp)
    })
    class FailingGit extends GitClient {
      override async removeWorktree(): Promise<void> {
        throw new Error('worktree is locked')
      }
    }
    const deps = setup(r.env, new FailingGit(exec, r.env))
    const s = await startOne(sp)
    const res = await archiveSession(s.id, { confirmedDataLoss: false }, deps)
    expect(res).toEqual({ ok: false, error: expect.stringContaining('worktree is locked') })
    expect(await has(s.worktreePath!)).toBe(true)
    expect(await branchesOf(r)).toContain(s.branch)
    expect(await t.tmux.hasSession(claudeTmuxName(s.id))).toBe(true)
    expect(store.state.sessions[0].archivedAt).toBeUndefined()
    expect(manager.snapshot().sessions).toHaveLength(1)
  })

  test('unknown session never throws', async () => {
    const { deps } = await addRepo()
    expect(await archiveSession('nope', { confirmedDataLoss: true }, deps)).toEqual({ ok: false, error: 'Session not found.' })
    expect(await checkArchive('nope', deps)).toMatchObject({ willRemoveWorktree: false, willDeleteBranch: false })
  })

  describe('teardown', () => {
    const setTeardown = (cmd: string) => store.update((d) => { d.subProjects[0].teardownCommand = cmd })

    test('runs after tmux is killed, before the worktree is removed, in the folder, with the session env', async () => {
      const { sp, deps } = await addRepo()
      const s = await startOne(sp)
      const out = join(t.tmp, 'td.txt')
      const order = join(t.tmp, 'order.txt')
      const real = deps.tmux.killSession.bind(deps.tmux)
      deps.tmux = Object.assign(Object.create(deps.tmux), {
        killSession: async (n: string) => { await appendFile(order, `kill\n`); return real(n) }
      })
      const wt = await realpath(s.worktreePath!)
      await setTeardown(
        `{ pwd -P; echo "$PITWALL_ROOT_PATH|$PITWALL_WORKTREE_PATH|$PITWALL_BRANCH|$PITWALL_SESSION_TITLE|$GIT_AUTHOR_NAME"; ` +
        `[ -d "$PWD" ] && echo dir-exists; echo teardown >> ${order}; } > ${out}`
      )
      expect(await archiveSession(s.id, { confirmedDataLoss: false }, deps)).toEqual({ ok: true })
      const lines = (await readFile(out, 'utf8')).trim().split('\n')
      expect(lines[0]).toBe(wt)
      expect(lines[1]).toBe(`${sp.repoRoot}|${s.worktreePath}|${s.branch}|Fix tax rounding|Jane`)
      expect(lines[2]).toBe('dir-exists')
      expect((await readFile(order, 'utf8')).trim().split('\n')).toEqual(['kill', 'kill', 'teardown'])
      expect(await has(s.worktreePath!)).toBe(false)
    })

    test('non-zero exit reports the code and last 4 KB, leaves the worktree', async () => {
      const { sp, deps } = await addRepo()
      const s = await startOne(sp)
      await setTeardown('head -c 10000 /dev/zero | tr "\\0" x; echo; echo boom >&2; exit 3')
      const res = await archiveSession(s.id, { confirmedDataLoss: false }, deps)
      expect(res).toMatchObject({ ok: false, teardownFailed: { exitCode: 3, timedOut: false } })
      const out = (res as { teardownFailed: { output: string } }).teardownFailed.output
      expect(out.length).toBeLessThanOrEqual(4096)
      expect(out).toContain('boom')
      expect(await has(s.worktreePath!)).toBe(true)
      expect(store.state.sessions[0].archivedAt).toBeUndefined()
    })

    test('skipTeardown archives without running it', async () => {
      const { sp, deps } = await addRepo()
      const s = await startOne(sp)
      const marker = join(t.tmp, 'ran')
      await setTeardown(`touch ${marker}; exit 1`)
      expect(await archiveSession(s.id, { confirmedDataLoss: false, skipTeardown: true }, deps)).toEqual({ ok: true })
      expect(await has(marker)).toBe(false)
      expect(await has(s.worktreePath!)).toBe(false)
    })

    test('a command past the limit is killed with its process group', async () => {
      const { sp, deps } = await addRepo()
      const s = await startOne(sp)
      const marker = join(t.tmp, 'late')
      await setTeardown(`(sleep 2; touch ${marker}) & sleep 30`)
      deps.teardownTimeoutMs = 300
      const t0 = Date.now()
      const res = await archiveSession(s.id, { confirmedDataLoss: false }, deps)
      expect(res).toMatchObject({ ok: false, teardownFailed: { exitCode: null, timedOut: true } })
      expect(Date.now() - t0).toBeLessThan(5000)
      await new Promise((r) => setTimeout(r, 2500))
      expect(await has(marker)).toBe(false)
      expect(await has(s.worktreePath!)).toBe(true)
    })

    test('a backgrounded child that outlives the command does not keep archive waiting', async () => {
      const { sp, deps } = await addRepo()
      const s = await startOne(sp)
      await setTeardown('sleep 20 & echo started')
      deps.teardownTimeoutMs = 10_000
      const t0 = Date.now()
      expect(await archiveSession(s.id, { confirmedDataLoss: false }, deps)).toEqual({ ok: true })
      expect(Date.now() - t0).toBeLessThan(5000)
    })

    test('no teardown command: unchanged', async () => {
      const { sp, deps } = await addRepo()
      const s = await startOne(sp)
      expect(await archiveSession(s.id, { confirmedDataLoss: false }, deps)).toEqual({ ok: true })
    })

    test('folder sessions run it in the folder', async () => {
      const dir = join(t.tmp, 'plain')
      await mkdir(dir)
      const sp: SubProject = { id: 'sp_f', projectId: 'p_1', name: 'Plain', kind: 'folder', path: dir, createdAt: 0, teardownCommand: 'pwd -P > where.txt' }
      await store.update((d) => { d.subProjects.push(sp) })
      const deps = setup({})
      const s = await startOne(sp)
      expect(await archiveSession(s.id, { confirmedDataLoss: false }, deps)).toEqual({ ok: true })
      expect((await readFile(join(dir, 'where.txt'), 'utf8')).trim()).toBe(await realpath(dir))
    })
  })

  test('archiving stops processes the session left running, and only those', async () => {
    const { sp, deps } = await addRepo()
    const s = await startOne(sp)
    const f1 = join(t.tmp, 'pid1'), f2 = join(t.tmp, 'pid2')
    await manager.ensureTerminalTarget(s.id, 'shell')
    const shellName = shellTmuxName(s.id)
    await t.tmux.sendKeys(shellName, [`nohup sleep 301 >/dev/null 2>&1 & echo $! > ${f1}; sh -c 'sleep 302 & echo $! > ${f2}; wait' &`], true)
    await t.tmux.sendKeys(shellName, ['Enter'])
    const outside = spawn('sleep', ['303'], { stdio: 'ignore' })
    const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
    const pidOf = async (f: string) => {
      for (let i = 0; i < 100; i++) {
        const n = Number((await readFile(f, 'utf8').catch(() => '')).trim())
        if (n) return n
        await new Promise((r) => setTimeout(r, 100))
      }
      throw new Error('pid file never appeared')
    }
    try {
      const p1 = await pidOf(f1), p2 = await pidOf(f2)
      expect(alive(p1) && alive(p2)).toBe(true)
      expect(await archiveSession(s.id, { confirmedDataLoss: false }, deps)).toEqual({ ok: true })
      await new Promise((r) => setTimeout(r, 300))
      expect(alive(p1)).toBe(false)
      expect(alive(p2)).toBe(false)
      expect(alive(outside.pid!)).toBe(true)
    } finally {
      outside.kill('SIGKILL')
    }
  })
})
