import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { exec, type Exec } from '../../src/main/exec'
import { GitClient } from '../../src/main/git'
import { Store } from '../../src/main/store'
import { findStrayWorktrees, knownLiveWorktrees, removeStrayWorktrees, strayCandidates, worktreeSize } from '../../src/main/stray-worktrees'
import { WINDOWS } from '../helpers/processes'
import { makeRepo } from '../helpers/repo'

const run = promisify(execFile)
type Repo = Awaited<ReturnType<typeof makeRepo>>
const repos: Repo[] = []
const children: ChildProcess[] = []

async function setup() {
  const r = await makeRepo()
  repos.push(r)
  const sh = (cwd: string, ...args: string[]) => run('git', args, { cwd, env: r.env }).then((x) => x.stdout.trim())
  const git = new GitClient(exec, r.env)
  const wt = (name: string) => join(r.root, '..', 'wts', name)
  /** What an agent leaves behind: a plain `git worktree add -b`. */
  const stray = async (name: string, o: { commit?: boolean; mergeIntoMain?: boolean; untracked?: boolean } = {}) => {
    const path = wt(name)
    await sh(r.root, 'worktree', 'add', '-q', '-b', name, path, 'main')
    if (o.commit) {
      await writeFile(join(path, `${name}.txt`), 'x\n')
      await sh(path, 'add', '-A')
      await sh(path, 'commit', '-q', '-m', name)
    }
    if (o.mergeIntoMain) await sh(r.root, 'merge', '-q', '--no-ff', '-m', `merge ${name}`, name)
    if (o.untracked) await writeFile(join(path, 'scratch.txt'), 'wip\n')
    return path
  }
  const base = (liveWorktrees: string[] = []) => ({ repoRoot: r.root, liveWorktrees, git, exec, env: r.env })
  return { ...r, sh, git, wt, stray, base }
}
const exists = (p: string) => stat(p).then(() => true, () => false)

afterEach(async () => {
  while (children.length) children.pop()!.kill('SIGKILL')
  while (repos.length) await repos.pop()!.cleanup()
  vi.restoreAllMocks()
})

describe('findStrayWorktrees', () => {
  test('lists worktrees no session owns, with merged, dirty and in-use flags', async () => {
    const t = await setup()
    const clean = await t.stray('merged-clean', { commit: true, mergeIntoMain: true })
    const unmerged = await t.stray('unmerged', { commit: true })
    const dirty = await t.stray('merged-dirty', { untracked: true })
    const live = await t.stray('live-session')
    const found = await findStrayWorktrees(t.base([live]))
    expect(found.map((w) => w.path).sort()).toEqual([clean, dirty, unmerged].sort())
    const by = (p: string) => found.find((w) => w.path === p)!
    expect(by(clean)).toMatchObject({ branch: 'merged-clean', merged: true, dirty: false, inUse: false })
    expect(by(unmerged)).toMatchObject({ branch: 'unmerged', merged: false, dirty: false, inUse: false })
    expect(by(dirty)).toMatchObject({ branch: 'merged-dirty', merged: true, dirty: true, inUse: false })
    expect(by(clean).lastCommitAt).toBeGreaterThan(Date.now() - 60_000)
  })

  test('never lists the main checkout, the repo root, a prunable entry or a session worktree', async () => {
    const t = await setup()
    const gone = await t.stray('gone')
    await rm(gone, { recursive: true, force: true })
    const live = await t.stray('live')
    expect(await findStrayWorktrees(t.base([live]))).toEqual([])
    // Not even when the repo root is the only one passed in some other spelling.
    expect(await findStrayWorktrees({ ...t.base([live]), repoRoot: t.root + '/' })).toEqual([])
  })

  test('a detached worktree is never merged', async () => {
    const t = await setup()
    const d = t.wt('detached')
    await t.sh(t.root, 'worktree', 'add', '-q', '--detach', d, 'main')
    const [w] = await findStrayWorktrees(t.base())
    expect(w).toMatchObject({ path: d, merged: false, dirty: false })
    expect(w.branch).toBeUndefined()
  })

  test.skipIf(WINDOWS)('a process whose cwd is inside a worktree marks it in use (a subfolder too); others stay idle', async () => {
    const t = await setup()
    const busy = await t.stray('busy')
    const idle = await t.stray('idle')
    await mkdir(join(busy, 'sub'))
    const child = spawn('sleep', ['30'], { cwd: join(busy, 'sub'), stdio: 'ignore' })
    children.push(child)
    await new Promise((r) => setTimeout(r, 300))
    const found = await findStrayWorktrees(t.base())
    expect(found.find((w) => w.path === busy)!.inUse).toBe(true)
    expect(found.find((w) => w.path === idle)!.inUse).toBe(false)
  })

  test.skipIf(WINDOWS)('a path that merely shares a prefix with a busy one is not in use', async () => {
    const t = await setup()
    const ab = await t.stray('ab')
    const abc = await t.stray('abc')
    const child = spawn('sleep', ['30'], { cwd: abc, stdio: 'ignore' })
    children.push(child)
    await new Promise((r) => setTimeout(r, 300))
    const found = await findStrayWorktrees(t.base())
    expect(found.find((w) => w.path === ab)!.inUse).toBe(false)
    expect(found.find((w) => w.path === abc)!.inUse).toBe(true)
  })

  test.skipIf(WINDOWS)('when lsof fails every row is inUseUnknown (fail closed), and removal refuses all of them', async () => {
    const t = await setup()
    const a = await t.stray('a')
    const b = await t.stray('b')
    const failing: Exec = (file, args, o) => (file === 'lsof' ? Promise.resolve({ code: 127, stdout: '', stderr: 'nope' }) : exec(file, args, o))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const found = await findStrayWorktrees({ ...t.base(), exec: failing })
    expect(found.map((w) => w.inUseUnknown)).toEqual([true, true])
    expect(found.map((w) => w.inUse)).toEqual([false, false])
    const res = await removeStrayWorktrees({ ...t.base(), exec: failing, paths: [a, b], deleteBranches: true })
    expect(res.map((r) => r.message)).toEqual(['Could not check whether it is in use', 'Could not check whether it is in use'])
    expect(await exists(a)).toBe(true)
    expect(await exists(b)).toBe(true)
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1)
  })

  test.skipIf(WINDOWS)('when lsof works, rows are not inUseUnknown and a clean merged idle one is removed', async () => {
    const t = await setup()
    const a = await t.stray('a')
    const found = await findStrayWorktrees(t.base())
    expect(found[0].inUseUnknown).toBeUndefined()
    expect(await removeStrayWorktrees({ ...t.base(), paths: [a], deleteBranches: true })).toEqual([{ path: a, ok: true }])
  })

  test('on Windows inUse is always false and lsof is never run', async () => {
    const t = await setup()
    await t.stray('a')
    const seen: string[] = []
    const spy: Exec = (file, args, o) => { seen.push(file); return exec(file, args, o) }
    const found = await findStrayWorktrees({ ...t.base(), exec: spy, platform: 'win32' })
    expect(found.map((w) => w.inUse)).toEqual([false])
    expect(found[0].inUseUnknown).toBeUndefined()
    expect(seen).not.toContain('lsof')
  })
})

describe('strayCandidates', () => {
  test('is the stray-eligible worktrees before the status and process checks', async () => {
    const t = await setup()
    const a = await t.stray('a', { untracked: true })
    const live = await t.stray('live')
    expect(await strayCandidates(t.base([live]))).toEqual([a])
  })
})

describe('knownLiveWorktrees', () => {
  const state = (sessions: unknown[]) => JSON.stringify({ version: 1, projects: [], subProjects: [], sessions, settings: {} })

  test('reads this store and the sibling pitwall and pitwall-dev state files, read-only', async () => {
    const t = await setup()
    const app = join(t.root, '..', 'Application Support')
    await mkdir(join(app, 'pitwall'), { recursive: true })
    await mkdir(join(app, 'pitwall-dev'), { recursive: true })
    const prod = state([{ id: 'p', worktreePath: '/w/prod' }, { id: 'old', worktreePath: '/w/archived', archivedAt: 5 }, { id: 'nowt' }, { id: 'nul', worktreePath: '/w/null-archived', archivedAt: null }])
    const dev = state([{ id: 'd', worktreePath: '/w/dev' }])
    await writeFile(join(app, 'pitwall', 'state.json'), prod)
    await writeFile(join(app, 'pitwall-dev', 'state.json'), dev)
    const before = [(await stat(join(app, 'pitwall', 'state.json'))).mtimeMs, (await stat(join(app, 'pitwall-dev', 'state.json'))).mtimeMs]
    const store = await Store.open(join(app, 'pitwall-dev', 'state.json'))
    await store.update((d) => { d.sessions.push({ id: 'own', worktreePath: '/w/own' } as never) })
    const dirBefore = await readFile(join(app, 'pitwall', 'state.json'), 'utf8')
    const live = await knownLiveWorktrees(store, app)
    expect(live.sort()).toEqual(['/w/dev', '/w/null-archived', '/w/own', '/w/prod'])
    expect(await readFile(join(app, 'pitwall', 'state.json'), 'utf8')).toBe(dirBefore)
    expect((await stat(join(app, 'pitwall', 'state.json'))).mtimeMs).toBe(before[0])
  })

  test('a missing or corrupt sibling file is ignored', async () => {
    const t = await setup()
    const app = join(t.root, '..', 'App Support 2')
    await mkdir(join(app, 'pitwall'), { recursive: true })
    await writeFile(join(app, 'pitwall', 'state.json'), '{ not json')
    const store = await Store.open(join(app, 'mine', 'state.json'))
    expect(await knownLiveWorktrees(store, app)).toEqual([])
  })
})

describe('worktreeSize', () => {
  test('bytes from du -sk, or null when it fails', async () => {
    const t = await setup()
    const p = await t.stray('big')
    await writeFile(join(p, 'blob.bin'), Buffer.alloc(300 * 1024))
    const n = await worktreeSize(exec, p, t.env)
    expect(n).toBeGreaterThanOrEqual(300 * 1024)
    expect(n! % 1024).toBe(0)
    expect(await worktreeSize(exec, join(p, 'nothing-here'), t.env)).toBeNull()
  })
})

describe('removeStrayWorktrees', () => {
  test('removes only the merged, clean, idle worktree, deletes its branch, and says why for the rest', async () => {
    const t = await setup()
    const clean = await t.stray('merged-clean', { commit: true, mergeIntoMain: true })
    const unmerged = await t.stray('unmerged', { commit: true })
    const dirty = await t.stray('merged-dirty', { untracked: true })
    const res = await removeStrayWorktrees({ ...t.base(), paths: [clean, unmerged, dirty], deleteBranches: true })
    expect(res.find((r) => r.path === clean)).toEqual({ path: clean, ok: true })
    expect(res.find((r) => r.path === dirty)).toEqual({ path: dirty, ok: false, message: 'Has uncommitted changes' })
    expect(res.find((r) => r.path === unmerged)).toEqual({ path: unmerged, ok: false, message: 'Not merged' })
    expect(await exists(unmerged)).toBe(true)
    expect(await exists(clean)).toBe(false)
    expect(await exists(dirty)).toBe(true)
    expect(await t.git.branchExists(t.root, 'merged-clean')).toBe(false)
    expect(await t.git.branchExists(t.root, 'merged-dirty')).toBe(true)
    expect(await t.git.branchExists(t.root, 'unmerged')).toBe(true)
  })

  test('deleteBranches off keeps the branch', async () => {
    const t = await setup()
    const p = await t.stray('keep-branch')
    const res = await removeStrayWorktrees({ ...t.base(), paths: [p], deleteBranches: false })
    expect(res).toEqual([{ path: p, ok: true }])
    expect(await t.git.branchExists(t.root, 'keep-branch')).toBe(true)
  })

  test('never forces: no --force on worktree remove, and branches go with -d, never -D', async () => {
    const t = await setup()
    const a = await t.stray('a')
    const b = await t.stray('b', { commit: true, mergeIntoMain: true })
    const calls: string[][] = []
    const spy: Exec = (file, args, o) => { if (file === 'git') calls.push(args); return exec(file, args, o) }
    const git = new GitClient(spy, t.env)
    await removeStrayWorktrees({ ...t.base(), git, exec: spy, paths: [a, b], deleteBranches: true })
    const flat = calls.map((c) => c.join(' '))
    expect(flat.some((c) => c.includes('worktree remove'))).toBe(true)
    expect(flat.some((c) => /worktree remove.* (--force|-f)( |$)/.test(c) || c.includes('--force'))).toBe(false)
    expect(flat.some((c) => / branch -D /.test(c))).toBe(false)
    expect(flat.some((c) => / branch -d /.test(c))).toBe(true)
  })

  test('a detached worktree is refused as not merged (its commits would have no branch)', async () => {
    const t = await setup()
    const d = t.wt('detached')
    await t.sh(t.root, 'worktree', 'add', '-q', '--detach', d, 'main')
    const res = await removeStrayWorktrees({ ...t.base(), paths: [d], deleteBranches: true })
    expect(res).toEqual([{ path: d, ok: false, message: 'Not merged' }])
    expect(await exists(d)).toBe(true)
  })

  test('a worktree that got changes after it was listed is refused, not forced', async () => {
    const t = await setup()
    const p = await t.stray('late')
    expect((await findStrayWorktrees(t.base()))[0].dirty).toBe(false)
    await writeFile(join(p, 'new.txt'), 'late work\n')
    const res = await removeStrayWorktrees({ ...t.base(), paths: [p], deleteBranches: true })
    expect(res).toEqual([{ path: p, ok: false, message: 'Has uncommitted changes' }])
    expect(await exists(join(p, 'new.txt'))).toBe(true)
    expect(await t.git.branchExists(t.root, 'late')).toBe(true)
  })

  test.skipIf(WINDOWS)('a worktree a process is using is refused', async () => {
    const t = await setup()
    const p = await t.stray('busy')
    children.push(spawn('sleep', ['30'], { cwd: p, stdio: 'ignore' }))
    await new Promise((r) => setTimeout(r, 300))
    const res = await removeStrayWorktrees({ ...t.base(), paths: [p], deleteBranches: true })
    expect(res).toEqual([{ path: p, ok: false, message: 'In use by a running process' }])
    expect(await exists(p)).toBe(true)
  })

  test('anything no longer stray is "No longer listed": main checkout, repo root, session worktree, prunable, unknown paths', async () => {
    const t = await setup()
    const live = await t.stray('live')
    const gone = await t.stray('gone')
    await rm(gone, { recursive: true, force: true })
    const outside = join(t.root, '..', 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'precious'), 'x')
    const paths = [t.root, live, gone, outside, join(t.root, 'README.md'), '/']
    const res = await removeStrayWorktrees({ ...t.base([live]), paths, deleteBranches: true })
    expect(res).toEqual(paths.map((path) => ({ path, ok: false, message: 'No longer listed' })))
    expect(await exists(t.root)).toBe(true)
    expect(await exists(live)).toBe(true)
    expect(await exists(join(outside, 'precious'))).toBe(true)
    expect(await t.git.branchExists(t.root, 'main')).toBe(true)
  })

  test('the same path twice is removed once and the second is refused', async () => {
    const t = await setup()
    const p = await t.stray('twice')
    const res = await removeStrayWorktrees({ ...t.base(), paths: [p, p], deleteBranches: false })
    expect(res.map((r) => r.ok)).toEqual([true, false])
    expect(res[1].message).toBe('No longer listed')
  })
})
