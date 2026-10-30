import { mkdir, access, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ChangedFile } from '@shared/types'
import type { Exec, ExecResult } from './exec'

export class GitError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message)
    this.name = 'GitError'
  }
}

export type FolderInfo = { kind: 'repo'; repoRoot: string; relPath: string } | { kind: 'folder' }
type Status = 'M' | 'A' | 'D' | '?'

const firstLine = (s: string) => s.trim().split('\n')[0] ?? ''
// Checking out (or deleting) a big tree can take far longer than the 30 s default.
const WORKTREE_TIMEOUT_MS = 5 * 60_000
const nulList = (s: string) => s.split('\0').filter((x) => x.length > 0)

function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0
  let n = 0
  for (const b of buf) if (b === 10) n++
  return buf[buf.length - 1] === 10 ? n : n + 1
}

export class GitClient {
  private readonly env: Record<string, string>

  constructor(private readonly exec: Exec, env: Record<string, string>) {
    // Background status/diff refreshes must not take index.lock while the agent commits.
    this.env = { ...env, GIT_OPTIONAL_LOCKS: '0' }
  }

  private raw(dir: string, args: string[], o: { input?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
    return this.exec('git', ['-C', dir, ...args], { env: this.env, ...o })
  }

  private async run(dir: string, args: string[], timeoutMs?: number): Promise<string> {
    const r = await this.raw(dir, args, { timeoutMs })
    if (r.code !== 0) throw new GitError(firstLine(r.stderr) || `git ${args[0]} failed`, r.stderr)
    return r.stdout
  }

  private async ok(dir: string, args: string[]): Promise<boolean> {
    try {
      return (await this.raw(dir, args)).code === 0
    } catch {
      return false
    }
  }

  async detectFolder(path: string): Promise<FolderInfo> {
    const r = await this.raw(path, ['rev-parse', '--show-toplevel', '--show-prefix']).catch(() => null)
    if (!r || r.code !== 0) return { kind: 'folder' }
    const [repoRoot, prefix = ''] = r.stdout.split('\n')
    if (!repoRoot) return { kind: 'folder' }
    return { kind: 'repo', repoRoot, relPath: prefix.replace(/\/+$/, '') }
  }

  hasCommits(repoRoot: string): Promise<boolean> {
    return this.ok(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  }

  async currentBranch(dir: string): Promise<string | null> {
    const r = await this.raw(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    if (r.code === 0) return r.stdout.trim() || null
    if (r.code === 1) return null // detached HEAD
    throw new GitError(firstLine(r.stderr), r.stderr)
  }

  /** The repo's main branch: origin's HEAD if known (local name when it exists), else main, else master, else the current branch. */
  async defaultBranch(repoRoot: string): Promise<string | null> {
    const r = await this.raw(repoRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
    const remote = r.code === 0 ? r.stdout.trim() : ''
    if (remote) {
      const local = remote.replace(/^origin\//, '')
      if (await this.branchExists(repoRoot, local)) return local
      // origin/HEAD can point at a branch that's gone (e.g. after master was renamed to main and pruned)
      if (await this.ok(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}^{commit}`])) return remote
    }
    for (const name of ['main', 'master']) if (await this.branchExists(repoRoot, name)) return name
    return this.currentBranch(repoRoot)
  }

  async revParse(dir: string, ref: string): Promise<string> {
    return (await this.run(dir, ['rev-parse', '--verify', `${ref}^{commit}`])).trim()
  }

  async listBranches(repoRoot: string): Promise<{ name: string; checkedOutAt?: string }[]> {
    const names = (await this.run(repoRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).split('\n').filter(Boolean)
    const checkedOut = new Map<string, string>()
    let path = ''
    for (const line of (await this.run(repoRoot, ['worktree', 'list', '--porcelain'])).split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice(9)
      else if (line.startsWith('branch refs/heads/')) checkedOut.set(line.slice(18), path)
    }
    return names.map((name) => (checkedOut.has(name) ? { name, checkedOutAt: checkedOut.get(name) } : { name }))
  }

  isValidBranchName(name: string): Promise<boolean> {
    if (!name) return Promise.resolve(false)
    return this.exec('git', ['check-ref-format', '--branch', name], { env: this.env })
      .then((r) => r.code === 0)
      .catch(() => false)
  }

  branchExists(repoRoot: string, name: string): Promise<boolean> {
    return this.ok(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`])
  }

  async uniqueBranchName(repoRoot: string, desired: string): Promise<string> {
    let candidate = desired
    for (let n = 2; await this.branchExists(repoRoot, candidate); n++) candidate = `${desired}-${n}`
    return candidate
  }

  async addWorktree(o: { repoRoot: string; path: string; branch: string; mode: 'new' | 'existing'; base?: string }): Promise<void> {
    await mkdir(dirname(o.path), { recursive: true })
    const args =
      o.mode === 'new'
        ? ['worktree', 'add', '--no-track', '-b', o.branch, o.path, ...(o.base ? [o.base] : [])]
        : ['worktree', 'add', o.path, o.branch]
    await this.run(o.repoRoot, args, WORKTREE_TIMEOUT_MS)
  }

  async removeWorktree(repoRoot: string, path: string, force: boolean): Promise<void> {
    await this.run(repoRoot, ['worktree', 'remove', ...(force ? ['--force'] : []), path], WORKTREE_TIMEOUT_MS)
  }

  async deleteBranch(repoRoot: string, name: string): Promise<void> {
    await this.run(repoRoot, ['branch', '-D', name])
  }

  async hasRemote(dir: string): Promise<boolean> {
    const r = await this.raw(dir, ['remote']).catch(() => null)
    return !!r && r.code === 0 && r.stdout.trim().length > 0
  }

  async resolveDiffBase(worktree: string, baseBranch: string | undefined, baseCommit: string): Promise<string> {
    if (baseBranch && (await this.ok(worktree, ['rev-parse', '--verify', '--quiet', `${baseBranch}^{commit}`]))) {
      const r = await this.raw(worktree, ['merge-base', baseBranch, 'HEAD'])
      if (r.code === 0 && r.stdout.trim()) return r.stdout.trim()
    }
    return baseCommit
  }

  /** Commits on `branch` that no other local branch and no remote-tracking branch has. */
  async unpushedCommits(repoRoot: string, branch: string): Promise<number> {
    const out = await this.run(repoRoot, ['rev-list', '--count', `refs/heads/${branch}`, '--not', `--exclude=${branch}`, '--branches', '--remotes'])
    return parseInt(out.trim(), 10) || 0
  }

  async workStatus(worktree: string): Promise<{ uncommittedFiles: number; unpushedCommits: number; hasRemote: boolean }> {
    const status = await this.run(worktree, ['status', '--porcelain', '-z', '-uall', '--no-renames'])
    // Work that would be lost if this branch were deleted: on no remote and no other local branch.
    const branch = await this.currentBranch(worktree)
    const exclude = branch ? [`--exclude=${branch}`] : []
    const count = await this.run(worktree, ['rev-list', '--count', 'HEAD', '--not', ...exclude, '--branches', '--remotes'])
    return {
      uncommittedFiles: nulList(status).length,
      unpushedCommits: parseInt(count.trim(), 10) || 0,
      hasRemote: await this.hasRemote(worktree)
    }
  }

  async statusMap(cwd: string): Promise<Map<string, Status>> {
    const prefix = (await this.run(cwd, ['rev-parse', '--show-prefix'])).trim()
    const out = await this.run(cwd, ['status', '--porcelain', '-z', '-uall', '--no-renames'])
    const map = new Map<string, Status>()
    for (const entry of nulList(out)) {
      const xy = entry.slice(0, 2)
      const path = entry.slice(3)
      if (xy === '!!' || !path.startsWith(prefix)) continue
      const status: Status = xy === '??' ? '?' : xy.includes('D') ? 'D' : xy.includes('A') ? 'A' : 'M'
      map.set(path.slice(prefix.length), status)
    }
    return map
  }

  async lsFiles(cwd: string): Promise<string[]> {
    const out = await this.run(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    return [...new Set(nulList(out))]
  }

  async listChanges(worktree: string, base: string): Promise<ChangedFile[]> {
    const top = (await this.run(worktree, ['rev-parse', '--show-toplevel'])).trim()
    const numstat = await this.run(top, ['diff', '--numstat', '-z', '--no-renames', base])
    const nameStatus = await this.run(top, ['diff', '--name-status', '-z', '--no-renames', base])
    const untracked = await this.run(top, ['ls-files', '--others', '--exclude-standard', '-z'])

    const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>()
    for (const rec of nulList(numstat)) {
      const [a, d, ...rest] = rec.split('\t')
      const binary = a === '-' && d === '-'
      stats.set(rest.join('\t'), { additions: binary ? 0 : Number(a), deletions: binary ? 0 : Number(d), binary })
    }
    const files: ChangedFile[] = []
    const parts = nameStatus.split('\0')
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const code = parts[i][0]
      const path = parts[i + 1]
      const status: Status = code === 'A' ? 'A' : code === 'D' ? 'D' : 'M'
      files.push({ path, status, additions: 0, deletions: 0, binary: false, ...stats.get(path) })
    }
    for (const path of nulList(untracked)) {
      let buf: Buffer
      try {
        buf = await readFile(`${top}/${path}`)
      } catch {
        continue
      }
      const binary = buf.subarray(0, 8000).includes(0)
      files.push({ path, status: '?', additions: binary ? 0 : countLines(buf), deletions: 0, binary })
    }
    return files.sort((x, y) => x.path.localeCompare(y.path))
  }

  async showFile(worktree: string, ref: string, relPath: string): Promise<string | null> {
    const r = await this.raw(worktree, ['show', `${ref}:${relPath}`])
    return r.code === 0 ? r.stdout : null
  }
}

export async function uniquePath(
  desired: string,
  exists: (p: string) => Promise<boolean> = (p) => access(p).then(() => true, () => false)
): Promise<string> {
  let candidate = desired
  for (let n = 2; await exists(candidate); n++) candidate = `${desired}-${n}`
  return candidate
}
