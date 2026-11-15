import { constants } from 'node:fs'
import { copyFile, glob, lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import type { Exec } from './exec'

export type IncludeSkip = { path: string; reason: 'tracked' | 'not-ignored' | 'exists' | 'too-large' | 'symlink' | 'limit' | 'outside' }

const MAX_FILES = 200
const MAX_BYTES = 20 * 1024 * 1024

const inside = (dir: string, root: string) => dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep)
const skipDir = (p: string) => p.split(/[\\/]/).some((s) => s === 'node_modules' || s === '.git')

/**
 * Copies the gitignored files that the repo's committed `.worktreeinclude` lists (globs relative to the repo root, like
 * .env.local) into a new worktree, since git leaves ignored files behind. Nothing is overwritten and symlinks aren't
 * followed. A failed copy throws, naming the file.
 */
export async function copyWorktreeIncludes(o: {
  repoRoot: string
  worktree: string
  exec: Exec
  env: Record<string, string>
}): Promise<{ copied: string[]; skipped: IncludeSkip[] }> {
  const copied: string[] = []
  const skipped: IncludeSkip[] = []
  let text: string
  try {
    text = await readFile(join(o.repoRoot, '.worktreeinclude'), 'utf8')
  } catch {
    return { copied, skipped }
  }
  const patterns = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))

  const found = new Set<string>()
  for (const pattern of patterns) {
    for await (const p of glob(pattern, { cwd: o.repoRoot, exclude: (name) => skipDir(String(name)) })) {
      found.add(p.replace(/\\/g, '/'))
    }
  }
  const repoReal = await realpath(o.repoRoot)
  // A symlinked directory on the way must not lead out of the repo (git itself refuses such paths, failing the batch).
  const candidates: string[] = []
  for (const p of [...found].filter((p) => !skipDir(p)).sort()) {
    const dir = await realpath(dirname(join(o.repoRoot, p))).catch(() => null)
    if (dir && inside(dir, repoReal)) candidates.push(p)
    else if (dir) skipped.push({ path: p, reason: 'outside' })
  }
  if (!candidates.length) return { copied, skipped }

  // One git call for all of them. Exit 1 just means none is ignored.
  const r = await o.exec('git', ['-C', o.repoRoot, 'check-ignore', '-z', '--stdin'], { env: o.env, input: candidates.join('\0') + '\0' })
  if (r.code > 1) throw new Error(`Couldn't check .worktreeinclude files against .gitignore: ${r.stderr.trim()}`)
  const ignored = new Set(r.code === 0 ? r.stdout.split('\0').filter(Boolean) : [])

  const wtReal = await realpath(o.worktree)
  let total = 0
  for (const rel of candidates) {
    const src = join(o.repoRoot, rel)
    const st = await lstat(src).catch(() => null)
    if (!st) continue
    if (st.isSymbolicLink()) { skipped.push({ path: rel, reason: 'symlink' }); continue }
    if (!st.isFile()) continue
    if (!ignored.has(rel)) { skipped.push({ path: rel, reason: 'not-ignored' }); continue }
    if (st.size > MAX_BYTES) { skipped.push({ path: rel, reason: 'too-large' }); continue }
    if (copied.length >= MAX_FILES || total + st.size > MAX_BYTES) { skipped.push({ path: rel, reason: 'limit' }); continue }
    const dest = join(o.worktree, rel)
    if (await lstat(dest).then(() => true, () => false)) { skipped.push({ path: rel, reason: 'exists' }); continue }
    try {
      await mkdir(dirname(dest), { recursive: true })
      if (!inside(await realpath(dirname(dest)), wtReal)) { skipped.push({ path: rel, reason: 'outside' }); continue }
      await copyFile(src, dest, constants.COPYFILE_EXCL) // keeps the file mode
    } catch (e) {
      throw new Error(`Couldn't copy ${rel} from .worktreeinclude: ${e instanceof Error ? e.message : String(e)}`)
    }
    total += st.size
    copied.push(rel)
  }
  return { copied, skipped }
}
