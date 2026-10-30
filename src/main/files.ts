import { open, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { FileContent, FileEntry, SubProjectKind } from '@shared/types'
import { formatAgentReference } from '@shared/agent-ref'
import type { GitClient } from './git'

export type { FileContent, FileEntry }
export { formatAgentReference }

const MAX_BYTES = 2 * 1024 * 1024
const SKIP_DIRS = new Set(['.git', 'node_modules'])
const SKIP_FILES = new Set(['.DS_Store'])
const OUTSIDE = 'Path is outside the session folder'

const isInside = (root: string, p: string): boolean => p === root || p.startsWith(root + sep)

/**
 * Resolves `rel` against `root`, rejecting anything that lexically or through symlinks
 * ends up outside it. The target itself may not exist yet (writes).
 */
export async function resolveInside(root: string, rel: string): Promise<string> {
  if (isAbsolute(rel)) throw new Error(OUTSIDE)
  const realRoot = await realpath(root)
  const target = resolve(realRoot, rel)
  if (!isInside(realRoot, target)) throw new Error(OUTSIDE)
  // Walk up to the nearest existing ancestor and make sure its real location is inside.
  let probe = target
  for (;;) {
    try {
      const real = await realpath(probe)
      if (!isInside(realRoot, real)) throw new Error(OUTSIDE)
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      const up = dirname(probe)
      if (up === probe) throw new Error(OUTSIDE)
      probe = up
    }
  }
  return target
}

async function walk(root: string, cap: number): Promise<{ paths: string[]; truncated: boolean }> {
  const paths: string[] = []
  const stack = ['']
  while (stack.length) {
    const rel = stack.pop()!
    const entries = await readdir(join(root, rel), { withFileTypes: true }).catch(() => [])
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(childRel)
      } else if (!SKIP_FILES.has(e.name)) {
        if (paths.length >= cap) return { paths, truncated: true }
        paths.push(childRel)
      }
    }
  }
  return { paths, truncated: false }
}

export async function listSessionFiles(
  cwd: string, kind: SubProjectKind, git: GitClient, cap = 20000
): Promise<{ files: FileEntry[]; truncated: boolean }> {
  if (kind === 'folder') {
    const { paths, truncated } = await walk(cwd, cap)
    return { files: paths.map((path) => ({ path })), truncated }
  }
  const [tracked, status] = await Promise.all([git.lsFiles(cwd), git.statusMap(cwd)])
  const all = new Set(tracked)
  for (const [path, st] of status) if (st === 'D') all.add(path) // staged deletions are not in ls-files
  const sorted = [...all].sort()
  const truncated = sorted.length > cap
  const files = sorted.slice(0, cap).map((path): FileEntry => {
    const st = status.get(path)
    return st ? { path, status: st } : { path }
  })
  return { files, truncated }
}

export async function readForEditor(root: string, rel: string): Promise<FileContent> {
  const abs = await resolveInside(root, rel)
  const st = await stat(abs)
  if (st.size > MAX_BYTES) return { kind: 'too_large', size: st.size }
  const fh = await open(abs, 'r')
  try {
    const head = Buffer.alloc(Math.min(8000, st.size))
    await fh.read(head, 0, head.length, 0)
    if (head.includes(0)) return { kind: 'binary' }
    const content = await fh.readFile({ encoding: 'utf8' })
    return { kind: 'text', content, mtimeMs: st.mtimeMs }
  } finally {
    await fh.close()
  }
}

export async function writeFromEditor(
  root: string, rel: string, content: string, expectedMtimeMs?: number
): Promise<{ ok: true; mtimeMs: number } | { ok: false; reason: 'changed_on_disk' }> {
  const abs = await resolveInside(root, rel)
  if (expectedMtimeMs !== undefined) {
    const cur = await stat(abs).catch(() => null)
    if (cur && cur.mtimeMs !== expectedMtimeMs) return { ok: false, reason: 'changed_on_disk' }
  }
  await writeFile(abs, content, 'utf8')
  return { ok: true, mtimeMs: (await stat(abs)).mtimeMs }
}
