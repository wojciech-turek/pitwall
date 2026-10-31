import { mkdir, mkdtemp, realpath, rm, symlink, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { exec } from '../../src/main/exec'
import { GitClient } from '../../src/main/git'
import {
  formatAgentReference, listSessionFiles, readForEditor, resolveInside, writeFromEditor
} from '../../src/main/files'
import { WINDOWS } from '../helpers/processes'
import { makeRepo } from '../helpers/repo'

const dirs: string[] = []
async function tmp(): Promise<string> {
  const d = await realpath(await mkdtemp(join(tmpdir(), 'pitwall-files-')))
  dirs.push(d)
  return d
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})

describe('files', () => {
  test('resolveInside blocks escapes', async () => {
    const root = await tmp()
    const outside = await tmp()
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src/a.ts'), 'x')
    await writeFile(join(outside, 'secret'), 's')
    // Windows: a junction for the folder (needs no privilege); a file symlink needs Developer Mode or an admin.
    await symlink(outside, join(root, 'link'), WINDOWS ? 'junction' : undefined)
    const fileLink = await symlink(join(outside, 'secret'), join(root, 'src/leak'))
      .then(() => true, (e: NodeJS.ErrnoException) => { if (WINDOWS && e.code === 'EPERM') return false; throw e })
    await expect(resolveInside(root, '../x')).rejects.toThrow('Path is outside the session folder')
    await expect(resolveInside(root, '/etc/passwd')).rejects.toThrow('Path is outside the session folder')
    await expect(resolveInside(root, 'link/secret')).rejects.toThrow('Path is outside the session folder')
    if (fileLink) await expect(resolveInside(root, 'src/leak')).rejects.toThrow('Path is outside the session folder')
    expect(await resolveInside(root, 'src/a.ts')).toBe(join(root, 'src/a.ts'))
    // a not-yet-existing file inside the root is fine (writes)
    expect(await resolveInside(root, 'src/new.ts')).toBe(join(root, 'src/new.ts'))
  })

  test('repo listing respects .gitignore and includes untracked', async () => {
    const r = await makeRepo()
    try {
      await writeFile(join(r.root, '.gitignore'), 'ignored.log\n')
      await writeFile(join(r.root, 'ignored.log'), 'x')
      await writeFile(join(r.root, 'new.txt'), 'x')
      await writeFile(join(r.root, 'README.md'), 'changed\n')
      const git = new GitClient(exec, r.env)
      const { files, truncated } = await listSessionFiles(r.root, 'repo', git)
      const map = new Map(files.map((f) => [f.path, f.status]))
      expect(truncated).toBe(false)
      expect(map.has('ignored.log')).toBe(false)
      expect(map.get('new.txt')).toBe('?')
      expect(map.get('README.md')).toBe('M')
    } finally { await r.cleanup() }
  })

  test('repo listing includes deleted files with status D', async () => {
    const r = await makeRepo()
    try {
      await rm(join(r.root, 'README.md'))
      const git = new GitClient(exec, r.env)
      const { files } = await listSessionFiles(r.root, 'repo', git)
      expect(files).toContainEqual({ path: 'README.md', status: 'D' })
    } finally { await r.cleanup() }
  })

  test('folder listing skips .git, node_modules, .DS_Store', async () => {
    const root = await tmp()
    await mkdir(join(root, '.git'))
    await mkdir(join(root, 'node_modules/x'), { recursive: true })
    await mkdir(join(root, 'notes'))
    await writeFile(join(root, '.git/HEAD'), 'x')
    await writeFile(join(root, 'node_modules/x/i.js'), 'x')
    await writeFile(join(root, '.DS_Store'), 'x')
    await writeFile(join(root, 'notes/a.md'), 'x')
    await writeFile(join(root, 'b.md'), 'x')
    const { files } = await listSessionFiles(root, 'folder', new GitClient(exec, {}))
    expect(files.map((f) => f.path).sort()).toEqual(['b.md', 'notes/a.md'])
    expect(files.every((f) => f.status === undefined)).toBe(true)
  })

  test('listing caps and flags truncation', async () => {
    const root = await tmp()
    for (let i = 0; i < 10; i++) await writeFile(join(root, `f${i}.txt`), 'x')
    const { files, truncated } = await listSessionFiles(root, 'folder', new GitClient(exec, {}), 5)
    expect(files).toHaveLength(5)
    expect(truncated).toBe(true)
  })

  test('readForEditor text, binary, too large', async () => {
    const root = await tmp()
    await writeFile(join(root, 'a.txt'), 'héllo\n')
    await writeFile(join(root, 'p.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]))
    await writeFile(join(root, 'big.txt'), Buffer.alloc(3 * 1024 * 1024, 97))
    const t = await readForEditor(root, 'a.txt')
    expect(t).toMatchObject({ kind: 'text', content: 'héllo\n' })
    expect((t as { mtimeMs: number }).mtimeMs).toBeGreaterThan(0)
    expect(await readForEditor(root, 'p.png')).toEqual({ kind: 'binary' })
    expect(await readForEditor(root, 'big.txt')).toEqual({ kind: 'too_large', size: 3 * 1024 * 1024 })
    await expect(readForEditor(root, '../nope')).rejects.toThrow('outside')
  })

  test('write detects changed-on-disk', async () => {
    const root = await tmp()
    await writeFile(join(root, 'a.txt'), 'one')
    const first = await readForEditor(root, 'a.txt')
    if (first.kind !== 'text') throw new Error('expected text')
    const ok = await writeFromEditor(root, 'a.txt', 'two', first.mtimeMs)
    expect(ok.ok).toBe(true)
    // external modification
    await writeFile(join(root, 'a.txt'), 'external')
    const later = new Date(Date.now() + 5000)
    await utimes(join(root, 'a.txt'), later, later)
    expect(await writeFromEditor(root, 'a.txt', 'three', first.mtimeMs)).toEqual({ ok: false, reason: 'changed_on_disk' })
    // overwrite without expectation
    const forced = await writeFromEditor(root, 'a.txt', 'three')
    expect(forced.ok).toBe(true)
    const again = await readForEditor(root, 'a.txt')
    expect(again).toMatchObject({ kind: 'text', content: 'three' })
    await expect(writeFromEditor(root, '../evil', 'x')).rejects.toThrow('outside')
  })

  test('formatAgentReference', () => {
    expect(formatAgentReference('src/a.ts')).toBe('@src/a.ts ')
    expect(formatAgentReference('src/a.ts', { fromLine: 3, toLine: 5 })).toBe('@src/a.ts (lines 3-5) ')
    expect(formatAgentReference('src/a.ts', { fromLine: 3, toLine: 3 })).toBe('@src/a.ts (line 3) ')
    expect(formatAgentReference('docs/my file.md')).toBe('@"docs/my file.md" ')
  })
})
