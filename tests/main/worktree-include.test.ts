import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { exec } from '../../src/main/exec'
import { copyWorktreeIncludes } from '../../src/main/worktree-include'
import { WINDOWS } from '../helpers/processes'
import { makeRepo } from '../helpers/repo'

let r: Awaited<ReturnType<typeof makeRepo>>
let wt: string

beforeEach(async () => {
  r = await makeRepo()
  wt = await realpath(await mkdtemp(join(tmpdir(), 'pitwall-wt-')))
  await writeFile(join(r.root, '.gitignore'), '.env.local\nsecrets/\nnode_modules/\nbig.bin\n')
  await writeFile(join(r.root, '.worktreeinclude'), '# env\n\n.env.local\nsecrets/*.json\n**/.env.local\nREADME.md\nbig.bin\n')
  await writeFile(join(r.root, '.env.local'), 'TOKEN=1\n')
  await mkdir(join(r.root, 'secrets'), { recursive: true })
  await writeFile(join(r.root, 'secrets', 'a.json'), '{"a":1}')
  await mkdir(join(r.root, 'node_modules', 'x'), { recursive: true })
  await writeFile(join(r.root, 'node_modules', 'x', '.env.local'), 'no')
})
afterEach(async () => {
  await rm(wt, { recursive: true, force: true })
  await r.cleanup()
})

const run = () => copyWorktreeIncludes({ repoRoot: r.root, worktree: wt, exec, env: r.env })

describe('copyWorktreeIncludes', () => {
  test('copies matching gitignored files with their content', async () => {
    const res = await run()
    expect(res.copied.sort()).toEqual(['.env.local', 'secrets/a.json'])
    expect(await readFile(join(wt, '.env.local'), 'utf8')).toBe('TOKEN=1\n')
    expect(await readFile(join(wt, 'secrets', 'a.json'), 'utf8')).toBe('{"a":1}')
  })

  test('skips node_modules and tracked files', async () => {
    const res = await run()
    expect(res.copied).not.toContain('node_modules/x/.env.local')
    await expect(readFile(join(wt, 'node_modules', 'x', '.env.local'))).rejects.toThrow()
    await expect(readFile(join(wt, 'README.md'))).rejects.toThrow()
    expect(res.skipped.some((s) => s.path === 'README.md' && (s.reason === 'tracked' || s.reason === 'not-ignored'))).toBe(true)
  })

  test('keeps an existing file in the worktree', async () => {
    await writeFile(join(wt, '.env.local'), 'mine\n')
    const res = await run()
    expect(await readFile(join(wt, '.env.local'), 'utf8')).toBe('mine\n')
    expect(res.skipped).toContainEqual({ path: '.env.local', reason: 'exists' })
  })

  test('skips a file over 20 MB', async () => {
    await writeFile(join(r.root, 'big.bin'), Buffer.alloc(21 * 1024 * 1024))
    const res = await run()
    expect(res.skipped).toContainEqual({ path: 'big.bin', reason: 'too-large' })
    expect(res.copied).not.toContain('big.bin')
  })

  test('copies non-ASCII and spaced names', async () => {
    await writeFile(join(r.root, '.gitignore'), 'café.env\nmy secret.env\n')
    await writeFile(join(r.root, '.worktreeinclude'), '*.env\n')
    await writeFile(join(r.root, 'café.env'), 'a')
    await writeFile(join(r.root, 'my secret.env'), 'b')
    const res = await run()
    expect(res.copied.sort()).toEqual(['café.env', 'my secret.env'])
    expect(await readFile(join(wt, 'café.env'), 'utf8')).toBe('a')
  })

  test.skipIf(WINDOWS)('skips a file reached through a symlinked directory out of the repo', async () => {
    const out = await mkdtemp(join(tmpdir(), 'pitwall-out-'))
    try {
      await writeFile(join(out, '.env'), 'x')
      await symlink(out, join(r.root, 'link'))
      await writeFile(join(r.root, '.gitignore'), 'link/\n.env\n')
      await writeFile(join(r.root, '.worktreeinclude'), 'link/.env\n')
      const res = await run()
      expect(res.copied).toEqual([])
      await expect(readFile(join(wt, 'link', '.env'))).rejects.toThrow()
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })

  test.skipIf(WINDOWS)('never writes through a symlinked directory in the worktree', async () => {
    const out = await mkdtemp(join(tmpdir(), 'pitwall-out-'))
    try {
      await symlink(out, join(wt, 'secrets'))
      const res = await run()
      expect(res.skipped).toContainEqual({ path: 'secrets/a.json', reason: 'outside' })
      await expect(readFile(join(out, 'a.json'))).rejects.toThrow()
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })

  test('returns nothing without a .worktreeinclude', async () => {
    await writeFile(join(r.root, '.worktreeinclude'), '')
    const { rm } = await import('node:fs/promises')
    await rm(join(r.root, '.worktreeinclude'))
    expect(await run()).toEqual({ copied: [], skipped: [] })
  })
})
