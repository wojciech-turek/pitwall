import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { StrayWorktree } from '@shared/types'
import type { Exec } from './exec'
import { samePath, type GitClient } from './git'
import type { Store } from './store'

export interface StrayOptions {
  repoRoot: string
  /** Worktrees that belong to live sessions (this app's and the sibling Pitwall data dirs'). */
  liveWorktrees: string[]
  git: GitClient
  exec: Exec
  env: Record<string, string>
  platform?: NodeJS.Platform
}

const GIT_CONCURRENCY = 4

/** realpath where the folder exists (macOS /var vs /private/var), else the path as given, without a trailing slash. */
async function canon(p: string, platform: NodeJS.Platform): Promise<string> {
  const real = await realpath(p).catch(() => p)
  return platform === 'win32' ? real : real.replace(/\/+$/, '') || '/'
}

/** `fn` over `items`, a few at a time, results in order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }))
  return out
}

interface Candidate { path: string; branch?: string }

/**
 * The repo's worktrees that could be strays: not the main checkout (git lists it first), not the repo root, not
 * prunable (its folder is gone), and not a live session's. Nothing here looks inside a worktree.
 */
async function candidates(o: StrayOptions): Promise<Candidate[]> {
  const platform = o.platform ?? process.platform
  const all = await o.git.listWorktrees(o.repoRoot)
  const root = await canon(o.repoRoot, platform)
  const live = await Promise.all(o.liveWorktrees.map((p) => canon(p, platform)))
  const out: Candidate[] = []
  for (const w of all.slice(1)) {
    if (w.prunable) continue
    const p = await canon(w.path, platform)
    if (samePath(p, root, platform) || live.some((l) => samePath(l, p, platform))) continue
    out.push({ path: w.path, branch: w.branch })
  }
  return out
}

/** The paths `findStrayWorktrees` could return, cheaply: what the size lookup accepts. */
export async function strayCandidates(o: StrayOptions): Promise<string[]> {
  return (await candidates(o)).map((c) => c.path)
}

let lsofWarned = false

/** Every process's working directory (realpath'd), or null when lsof isn't there or fails. macOS and Linux only. */
async function processCwds(o: StrayOptions, platform: NodeJS.Platform): Promise<string[] | null> {
  if (platform === 'win32') return null
  try {
    const r = await o.exec('lsof', ['-d', 'cwd', '-Fn'], { env: o.env, timeoutMs: 20_000 })
    if (r.code !== 0 && !r.stdout) throw new Error(r.stderr.trim() || `lsof exited ${r.code}`)
    const cwds = r.stdout.split('\n').filter((l) => l.startsWith('n/')).map((l) => l.slice(1))
    return await Promise.all(cwds.map((c) => canon(c, platform)))
  } catch (e) {
    if (!lsofWarned) {
      lsofWarned = true
      console.warn('[pitwall] could not tell which worktrees are in use (lsof failed):', e instanceof Error ? e.message : e)
    }
    return null
  }
}

/**
 * The repo's worktrees that no session owns: the ones agents made with `git worktree add`. Each says whether its
 * branch is merged into the default branch, whether it has uncommitted or untracked changes, and whether a process
 * is working inside it.
 */
export async function findStrayWorktrees(o: StrayOptions): Promise<StrayWorktree[]> {
  const platform = o.platform ?? process.platform
  const found = await candidates(o)
  if (!found.length) return []
  const cwds = await processCwds(o, platform)
  const target = await o.git.defaultBranch(o.repoRoot).catch(() => null)
  return mapLimit(found, GIT_CONCURRENCY, async (c): Promise<StrayWorktree> => {
    const p = await canon(c.path, platform)
    const [merged, dirty, lastCommitAt] = await Promise.all([
      c.branch && target ? o.git.isAncestor(o.repoRoot, c.branch, target) : false,
      o.git.isDirty(c.path),
      o.git.lastCommitAt(c.path)
    ])
    const inUse = !!cwds && cwds.some((cwd) => cwd === p || cwd.startsWith(p.endsWith('/') ? p : p + '/'))
    // No answer from lsof (off Windows) is not "idle": fail closed.
    const inUseUnknown = !cwds && platform !== 'win32'
    return { path: c.path, branch: c.branch, merged, dirty, inUse, lastCommitAt, ...(inUseUnknown ? { inUseUnknown } : {}) }
  })
}

/**
 * The worktrees of live sessions: this store's, and those of the other Pitwall data dirs next to it (`pitwall` and
 * `pitwall-dev` under `appSupportDir`), so the dev app never offers the installed app's worktrees, nor the reverse.
 * The other files are only read; missing or unreadable ones count for nothing.
 */
export async function knownLiveWorktrees(ownStore: Store, appSupportDir: string): Promise<string[]> {
  const paths = new Set<string>()
  const add = (sessions: unknown): void => {
    if (!Array.isArray(sessions)) return
    for (const s of sessions) {
      if (s && typeof s === 'object' && (s as { archivedAt?: unknown }).archivedAt == null) {
        const w = (s as { worktreePath?: unknown }).worktreePath
        if (typeof w === 'string' && w) paths.add(w)
      }
    }
  }
  add(ownStore.state.sessions)
  for (const dir of ['pitwall', 'pitwall-dev']) {
    try {
      add((JSON.parse(await readFile(join(appSupportDir, dir, 'state.json'), 'utf8')) as { sessions?: unknown }).sessions)
    } catch { /* missing or corrupt: nothing to protect from there */ }
  }
  return [...paths]
}

/** A folder's size in bytes (`du -sk`), or null when it can't be measured. */
export async function worktreeSize(exec: Exec, path: string, env: Record<string, string>): Promise<number | null> {
  try {
    const r = await exec('du', ['-sk', path], { env, timeoutMs: 120_000 })
    const kb = Number(r.stdout.trim().split(/\s+/)[0])
    return r.code === 0 && Number.isFinite(kb) ? kb * 1024 : null
  } catch {
    return null
  }
}

export interface RemoveResult { path: string; ok: boolean; message?: string }

/**
 * Removes the chosen worktrees that are still strays, merged, clean and idle, never with force. The list is worked out
 * again here: what the user saw may be minutes old. Anything else is refused with the reason.
 */
export async function removeStrayWorktrees(o: StrayOptions & { paths: string[]; deleteBranches: boolean }): Promise<RemoveResult[]> {
  const platform = o.platform ?? process.platform
  const strays = await findStrayWorktrees(o)
  const keyed = await Promise.all(strays.map(async (w) => ({ w, key: await canon(w.path, platform) })))
  const results: RemoveResult[] = []
  const done = new Set<string>()
  for (const path of o.paths) {
    const key = await canon(path, platform)
    const hit = keyed.find((k) => samePath(k.key, key, platform))
    const refuse = (message: string): void => { results.push({ path, ok: false, message }) }
    if (!hit || done.has(hit.key)) { refuse('No longer listed'); continue }
    const w = hit.w
    if (w.dirty) refuse('Has uncommitted changes')
    else if (w.inUse) refuse('In use by a running process')
    else if (w.inUseUnknown) refuse('Could not check whether it is in use')
    else if (!w.merged) refuse('Not merged')
    else {
      done.add(hit.key)
      try {
        await o.git.removeWorktree(o.repoRoot, w.path, false)
      } catch (e) {
        refuse(e instanceof Error ? e.message : 'Could not remove')
        continue
      }
      // `branch -d`: git itself refuses a branch that isn't merged.
      if (o.deleteBranches && w.branch) await o.git.deleteMergedBranch(o.repoRoot, w.branch).catch(() => undefined)
      results.push({ path, ok: true })
    }
  }
  return results
}

