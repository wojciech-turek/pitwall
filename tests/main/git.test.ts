import { execFile } from 'node:child_process'
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import { exec } from '../../src/main/exec'
import { fromGit, GitClient, GitError, samePath, uniquePath } from '../../src/main/git'
import { makeRepo } from '../helpers/repo'

const run = promisify(execFile)
type Repo = Awaited<ReturnType<typeof makeRepo>>
const repos: Repo[] = []
async function setup(o?: Parameters<typeof makeRepo>[0]) {
  const r = await makeRepo(o)
  repos.push(r)
  const git = new GitClient(exec, r.env)
  const sh = (cwd: string, ...args: string[]) => run('git', args, { cwd, env: r.env }).then((x) => x.stdout.trim())
  return { ...r, git, sh }
}
afterEach(async () => {
  while (repos.length) await repos.pop()!.cleanup()
})

describe('GitClient', () => {
  test('detectFolder: root, subfolder, plain, parent-of-repos', async () => {
    const { root, git } = await setup()
    await mkdir(join(root, 'packages/api'), { recursive: true })
    const real = await realpath(root)
    expect(await git.detectFolder(root)).toEqual({ kind: 'repo', repoRoot: real, relPath: '' })
    expect(await git.detectFolder(join(root, 'packages/api'))).toEqual({ kind: 'repo', repoRoot: real, relPath: 'packages/api' })
    const plain = join(root, '..', 'plain')
    await mkdir(plain)
    expect(await git.detectFolder(plain)).toEqual({ kind: 'folder' })
    expect(await git.detectFolder(join(root, '..'))).toEqual({ kind: 'folder' })
  })

  test('hasCommits false for fresh init, true after commit', async () => {
    const { root, git, sh } = await setup({ commits: false })
    expect(await git.hasCommits(root)).toBe(false)
    await writeFile(join(root, 'a'), 'x\n')
    await sh(root, 'add', '-A')
    await sh(root, 'commit', '-m', 'c')
    expect(await git.hasCommits(root)).toBe(true)
  })

  test('addWorktree new branch from base', async () => {
    const { root, git, sh } = await setup()
    const wt = join(root, '..', 'wts', 'a', 'fix')
    await git.addWorktree({ repoRoot: root, path: wt, branch: 'pitwall/fix', mode: 'new', base: 'main' })
    expect(await sh(wt, 'branch', '--show-current')).toBe('pitwall/fix')
    expect(await git.currentBranch(wt)).toBe('pitwall/fix')
    await git.removeWorktree(root, wt, false)
    await git.deleteBranch(root, 'pitwall/fix')
    expect(await git.branchExists(root, 'pitwall/fix')).toBe(false)
  })

  test('addWorktree existing branch checked out elsewhere throws GitError', async () => {
    const { root, git } = await setup()
    const p = addWt(root, 'x')
    await expect(git.addWorktree({ repoRoot: root, path: p, branch: 'main', mode: 'existing' })).rejects.toBeInstanceOf(GitError)
  })

  test('uniqueBranchName appends -2, -3', async () => {
    const { root, git, sh } = await setup()
    expect(await git.uniqueBranchName(root, 'pitwall/x')).toBe('pitwall/x')
    await sh(root, 'branch', 'pitwall/x')
    expect(await git.uniqueBranchName(root, 'pitwall/x')).toBe('pitwall/x-2')
    await sh(root, 'branch', 'pitwall/x-2')
    expect(await git.uniqueBranchName(root, 'pitwall/x')).toBe('pitwall/x-3')
  })

  test('isValidBranchName', async () => {
    const { git } = await setup()
    expect(await git.isValidBranchName('pitwall/ok')).toBe(true)
    expect(await git.isValidBranchName('bad name')).toBe(false)
    expect(await git.isValidBranchName('a..b')).toBe(false)
  })

  test("defaultBranch: origin's HEAD, else main/master, else the current branch", async () => {
    const { root, git, sh } = await setup({ remote: true })
    await sh(root, 'checkout', '-b', 'feature/wip')
    expect(await git.defaultBranch(root)).toBe('main') // no origin/HEAD yet: local main
    await sh(root, 'push', 'origin', 'feature/wip:develop')
    await sh(root, 'fetch', 'origin')
    await sh(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop')
    expect(await git.defaultBranch(root)).toBe('origin/develop') // no local develop: the remote branch
    await sh(root, 'branch', 'develop', 'origin/develop')
    expect(await git.defaultBranch(root)).toBe('develop')

    // origin/HEAD left pointing at a branch that no longer exists (master renamed to main, then pruned)
    await sh(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master')
    expect(await git.defaultBranch(root)).toBe('main')

    const m = await setup()
    await m.sh(m.root, 'branch', '-m', 'main', 'master')
    await m.sh(m.root, 'checkout', '-b', 'other')
    expect(await m.git.defaultBranch(m.root)).toBe('master')
    await m.sh(m.root, 'branch', '-D', 'master')
    expect(await m.git.defaultBranch(m.root)).toBe('other')
  })

  test('addWorktree from a remote base does not track it (a push never targets main)', async () => {
    const { root, git, sh } = await setup({ remote: true })
    const wt = join(root, '..', 'wt-remote')
    await git.addWorktree({ repoRoot: root, path: wt, branch: 'pitwall/x', mode: 'new', base: 'origin/main' })
    expect(await sh(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('pitwall/x')
    await expect(sh(root, 'config', 'branch.pitwall/x.merge')).rejects.toThrow()
  })

  test('listBranches marks checked-out branches', async () => {
    const { root, git, sh } = await setup()
    await sh(root, 'branch', 'other')
    const list = await git.listBranches(root)
    expect(list.find((b) => b.name === 'main')?.checkedOutAt).toBe(await realpath(root))
    expect(list.find((b) => b.name === 'other')?.checkedOutAt).toBeUndefined()
  })

  test('listChanges covers committed, uncommitted, untracked, deleted, binary', async () => {
    const { root, git, sh } = await setup()
    await writeFile(join(root, 'a.txt'), '1\n2\n3\n')
    await writeFile(join(root, 'd.txt'), 'x\ny\n')
    await sh(root, 'add', '-A')
    await sh(root, 'commit', '-m', 'seed')
    const wt = addWt(root, 'changes')
    await git.addWorktree({ repoRoot: root, path: wt, branch: 'pitwall/changes', mode: 'new', base: 'main' })
    const base = await git.revParse(wt, 'HEAD')
    await writeFile(join(wt, 'b.txt'), 'b1\nb2\nb3\n')
    await writeFile(join(wt, 'img.png'), Buffer.from([0x89, 0x50, 0, 1, 2, 3]))
    await sh(wt, 'add', '-A')
    await sh(wt, 'commit', '-m', 'add b and img')
    await writeFile(join(wt, 'a.txt'), '1\nTWO\nTHREE\n') // +2 -1? replace lines 2,3 -> 2/2
    await writeFile(join(wt, 'a.txt'), '1\n2x\n3\n4\n') // line 2 changed, line 4 added -> +2 -1
    await writeFile(join(wt, 'c.txt'), 'c1\nc2\nc3\n')
    await rm(join(wt, 'd.txt'))
    const changes = Object.fromEntries((await git.listChanges(wt, base)).map((c) => [c.path, c]))
    expect(changes['a.txt']).toMatchObject({ status: 'M', additions: 2, deletions: 1, binary: false })
    expect(changes['b.txt']).toMatchObject({ status: 'A', additions: 3, deletions: 0 })
    expect(changes['c.txt']).toMatchObject({ status: '?', additions: 3, deletions: 0 })
    expect(changes['d.txt']).toMatchObject({ status: 'D', additions: 0, deletions: 2 })
    expect(changes['img.png']).toMatchObject({ status: 'A', binary: true })
    expect(Object.keys(changes)).toHaveLength(5)
  })

  test('listChanges marks untracked binary', async () => {
    const { root, git } = await setup()
    await writeFile(join(root, 'bin.dat'), Buffer.from([1, 0, 2]))
    const c = await git.listChanges(root, 'HEAD')
    expect(c).toEqual([{ path: 'bin.dat', status: '?', additions: 0, deletions: 0, binary: true }])
  })

  test('resolveDiffBase uses fork point after base advances', async () => {
    const { root, git, sh } = await setup()
    const fork = await git.revParse(root, 'main')
    const wt = addWt(root, 'fp')
    await git.addWorktree({ repoRoot: root, path: wt, branch: 'pitwall/fp', mode: 'new', base: 'main' })
    await writeFile(join(root, 'adv.txt'), 'x\n')
    await sh(root, 'add', '-A')
    await sh(root, 'commit', '-m', 'advance')
    expect(await git.resolveDiffBase(wt, 'main', 'deadbeef')).toBe(fork)
    expect(await git.resolveDiffBase(wt, 'gone-branch', fork)).toBe(fork)
    expect(await git.resolveDiffBase(wt, undefined, fork)).toBe(fork)
  })

  test('workStatus', async () => {
    const { root, git, sh } = await setup({ remote: true })
    const wt = addWt(root, 'ws')
    await git.addWorktree({ repoRoot: root, path: wt, branch: 'pitwall/ws', mode: 'new', base: 'main' })
    expect(await git.workStatus(wt)).toEqual({ uncommittedFiles: 0, unpushedCommits: 0, hasRemote: true })
    await writeFile(join(wt, 'n.txt'), 'n\n')
    await sh(wt, 'add', '-A')
    await sh(wt, 'commit', '-m', 'n')
    expect((await git.workStatus(wt)).unpushedCommits).toBe(1)
    await sh(wt, 'push', '-u', 'origin', 'pitwall/ws')
    await writeFile(join(wt, 'dirty.txt'), 'd\n')
    expect(await git.workStatus(wt)).toEqual({ uncommittedFiles: 1, unpushedCommits: 0, hasRemote: true })
  })

  test('workStatus without remote counts only commits unique to the branch', async () => {
    const { root, git, sh } = await setup()
    const wt = addWt(root, 'nr')
    await git.addWorktree({ repoRoot: root, path: wt, branch: 'pitwall/nr', mode: 'new', base: 'main' })
    expect(await git.workStatus(wt)).toEqual({ uncommittedFiles: 0, unpushedCommits: 0, hasRemote: false })
    await writeFile(join(wt, 'n.txt'), 'n\n')
    await sh(wt, 'add', '-A')
    await sh(wt, 'commit', '-m', 'n')
    expect(await git.workStatus(wt)).toEqual({ uncommittedFiles: 0, unpushedCommits: 1, hasRemote: false })
    await sh(root, 'branch', 'keep', 'pitwall/nr')
    expect((await git.workStatus(wt)).unpushedCommits).toBe(0)
  })

  test('detached HEAD workStatus excludes commits on any branch', async () => {
    const { root, git, sh } = await setup()
    await sh(root, 'checkout', '--detach')
    expect((await git.workStatus(root)).unpushedCommits).toBe(0)
    await writeFile(join(root, 'd.txt'), 'd\n')
    await sh(root, 'add', '-A')
    await sh(root, 'commit', '-m', 'd')
    expect((await git.workStatus(root)).unpushedCommits).toBe(1)
  })

  test('git calls get GIT_OPTIONAL_LOCKS=0', async () => {
    const { root, env } = await setup()
    const seen: (Record<string, string> | undefined)[] = []
    const spy: typeof exec = (f, a, o) => (seen.push(o?.env), exec(f, a, o))
    await new GitClient(spy, env).hasCommits(root)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((e) => e?.GIT_OPTIONAL_LOCKS === '0')).toBe(true)
  })

  test('detached HEAD: currentBranch null and worktree from commit works', async () => {
    const { root, git, sh } = await setup()
    const sha = await sh(root, 'rev-parse', 'HEAD')
    await sh(root, 'checkout', '--detach')
    expect(await git.currentBranch(root)).toBeNull()
    const wt = addWt(root, 'det')
    await git.addWorktree({ repoRoot: root, path: wt, branch: 'pitwall/det', mode: 'new', base: sha })
    expect(await git.currentBranch(wt)).toBe('pitwall/det')
    expect(await git.revParse(wt, 'HEAD')).toBe(sha)
  })

  test('worktree add/remove get a 5-minute timeout (big repos, slow checkouts)', async () => {
    const r = await setup()
    const seen: Array<[string, number | undefined]> = []
    const git = new GitClient(async (file, args, opts) => {
      if (args.includes('worktree')) seen.push([args.slice(2, 4).join(' '), opts?.timeoutMs])
      return exec(file, args, opts)
    }, r.env)
    const wt = join(r.root, '..', 'wt-timeout')
    await git.addWorktree({ repoRoot: r.root, path: wt, branch: 'b-timeout', mode: 'new' })
    await git.removeWorktree(r.root, wt, true)
    expect(seen).toEqual([['worktree add', 300_000], ['worktree remove', 300_000]])
  })

  test('statusMap relative to subfolder cwd', async () => {
    const { root, git, sh } = await setup()
    await mkdir(join(root, 'packages/api'), { recursive: true })
    await writeFile(join(root, 'packages/api/x.ts'), '1\n')
    await writeFile(join(root, 'top.ts'), '1\n')
    await sh(root, 'add', '-A')
    await sh(root, 'commit', '-m', 'x')
    await writeFile(join(root, 'packages/api/x.ts'), '2\n')
    await writeFile(join(root, 'packages/api/new.ts'), '2\n')
    await writeFile(join(root, 'top.ts'), '2\n')
    const m = await git.statusMap(join(root, 'packages/api'))
    expect(Object.fromEntries(m)).toEqual({ 'x.ts': 'M', 'new.ts': '?' })
  })

  test('lsFiles excludes ignored files', async () => {
    const { root, git, sh } = await setup()
    await writeFile(join(root, '.gitignore'), 'node_modules\n')
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'node_modules/x'), '1')
    await sh(root, 'add', '-A')
    await sh(root, 'commit', '-m', 'ig')
    await writeFile(join(root, 'new.ts'), '1')
    const files = await git.lsFiles(root)
    expect(files).toContain('new.ts')
    expect(files).toContain('README.md')
    expect(files.some((f) => f.startsWith('node_modules'))).toBe(false)
  })

  test('showFile returns content, null for missing path at ref', async () => {
    const { root, git } = await setup()
    expect(await git.showFile(root, 'HEAD', 'README.md')).toBe('# test\n')
    expect(await git.showFile(root, 'HEAD', 'nope.txt')).toBeNull()
  })

  test('hasRemote', async () => {
    const a = await setup()
    expect(await a.git.hasRemote(a.root)).toBe(false)
    const b = await setup({ remote: true })
    expect(await b.git.hasRemote(b.root)).toBe(true)
  })

  test('failures throw GitError with first stderr line', async () => {
    const { root, git } = await setup()
    const err = await git.revParse(root, 'nonexistent-ref').catch((e) => e)
    expect(err).toBeInstanceOf(GitError)
    expect(err.message).not.toContain('\n')
    expect(err.stderr.length).toBeGreaterThan(0)
  })
})

describe('uniquePath', () => {
  test('appends -2, -3', async () => {
    const taken = new Set(['/a/x', '/a/x-2'])
    expect(await uniquePath('/a/x', async (p) => taken.has(p))).toBe('/a/x-3')
    expect(await uniquePath('/a/y', async (p) => taken.has(p))).toBe('/a/y')
  })
})

describe('paths git prints, on Windows', () => {
  test('fromGit: C:/… becomes C:\\…; elsewhere unchanged', () => {
    expect(fromGit('C:/Users/Zoë Ł/repo', 'win32')).toBe('C:\\Users\\Zoë Ł\\repo')
    expect(fromGit('//server/share/repo', 'win32')).toBe('\\\\server\\share\\repo')
    expect(fromGit('', 'win32')).toBe('')
    expect(fromGit('/Users/w/repo', 'darwin')).toBe('/Users/w/repo')
  })

  test('samePath: separators, letter case and a trailing separator on Windows; exact elsewhere', () => {
    expect(samePath('C:/Users/Me/repo', 'c:\\users\\me\\repo\\', 'win32')).toBe(true)
    expect(samePath('C:\\a\\b', 'C:\\a\\bb', 'win32')).toBe(false)
    expect(samePath('/Users/w/Repo', '/Users/w/repo', 'darwin')).toBe(false)
    expect(samePath('/Users/w/repo', '/Users/w/repo', 'darwin')).toBe(true)
  })

  test('GitClient gives the paths git prints in Windows form there (repo root, worktrees, checked-out branches)', async () => {
    const out: Record<string, string> = {
      'rev-parse': 'C:/Users/me/repo\nsub/dir/\n',
      'worktree': 'worktree C:/Users/me/repo\nHEAD 1\nbranch refs/heads/main\n\nworktree C:/Users/me/pitwall/worktrees/r/x\nHEAD 2\nbranch refs/heads/pitwall/x\nprunable gitdir file points to non-existent location\n',
      'for-each-ref': 'main\npitwall/x\n'
    }
    const exec = async (_f: string, args: string[]) => ({ code: 0, stdout: out[args[2]] ?? '', stderr: '' })
    const git = new GitClient(exec, {}, 'win32')
    expect(await git.detectFolder('C:\\Users\\me\\repo\\sub\\dir')).toEqual({ kind: 'repo', repoRoot: 'C:\\Users\\me\\repo', relPath: 'sub/dir' })
    expect(await git.listWorktrees('C:\\Users\\me\\repo')).toEqual([
      { path: 'C:\\Users\\me\\repo', prunable: false }, { path: 'C:\\Users\\me\\pitwall\\worktrees\\r\\x', prunable: true }
    ])
    expect(await git.listBranches('C:\\Users\\me\\repo')).toEqual([
      { name: 'main', checkedOutAt: 'C:\\Users\\me\\repo' }, { name: 'pitwall/x', checkedOutAt: 'C:\\Users\\me\\pitwall\\worktrees\\r\\x' }
    ])
    // macOS: as printed.
    expect(await new GitClient(exec, {}, 'darwin').listWorktrees('/r')).toMatchObject([{ path: 'C:/Users/me/repo' }, {}])
  })
})

function addWt(root: string, name: string) {
  return join(root, '..', 'wts', name)
}
