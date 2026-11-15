import { expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { exec, findExecutable } from '../../src/main/exec'
import { WINDOWS } from '../helpers/processes'

test.skipIf(WINDOWS)('returns code and output without throwing', async () => {
  expect(await exec('sh', ['-c', 'echo hi; echo err >&2; exit 3'])).toEqual({ code: 3, stdout: 'hi\n', stderr: 'err\n' })
})
test.skipIf(WINDOWS)('pipes input', async () => {
  expect((await exec('cat', [], { input: 'abc' })).stdout).toBe('abc')
})
test('missing binary throws naming it', async () => {
  await expect(exec('nope-bin-xyz', [])).rejects.toThrow(/nope-bin-xyz/)
})
test.skipIf(WINDOWS)('timeout kills', async () => {
  expect((await exec('sleep', ['5'], { timeoutMs: 200 })).code).not.toBe(0)
})
test('a program found by path: exit code, output, input and timeout (every platform; the ones above use sh)', async () => {
  const node = (script: string, o: Parameters<typeof exec>[2] = {}) => exec(process.execPath, ['-e', script], o)
  expect(await node("process.stdout.write('hi\\n'); process.stderr.write('err\\n'); process.exit(3)"))
    .toEqual({ code: 3, stdout: 'hi\n', stderr: 'err\n' })
  expect((await node('process.stdin.pipe(process.stdout)', { input: 'abc' })).stdout).toBe('abc')
  expect((await node('setTimeout(() => {}, 5000)', { timeoutMs: 200 })).code).not.toBe(0)
})

test('findExecutable returns the first match on the path, or null', () => {
  const a = join('/a', 'tmux')
  const b = join('/b', 'tmux')
  const path = ['/a', '/b'].join(delimiter)
  expect(findExecutable('tmux', path, (p) => p === b)).toBe(b)
  expect(findExecutable('tmux', path, (p) => p.endsWith('tmux'))).toBe(a)
  expect(findExecutable('tmux', path, () => false)).toBeNull()
  expect(findExecutable('tmux', undefined, () => true)).toBeNull()
  expect(findExecutable('tmux', '', () => true)).toBeNull()
})
test('findExecutable skips empty entries and checks real files with the execute bit', async () => {
  const seen: string[] = []
  findExecutable('x', `${delimiter}${delimiter}/a`, (p) => { seen.push(p); return false })
  expect(seen).toEqual([join('/a', 'x')])
  const dir = await mkdtemp(join(tmpdir(), 'pw-find-'))
  try {
    await writeFile(join(dir, 'tool'), '#!/bin/sh\n', { mode: 0o755 })
    await writeFile(join(dir, 'plain'), 'x', { mode: 0o644 })
    await mkdir(join(dir, 'adir'))
    expect(findExecutable('tool', dir)).toBe(join(dir, 'tool'))
    if (!WINDOWS) expect(findExecutable('plain', dir)).toBeNull()
    expect(findExecutable('adir', dir)).toBeNull()
    expect(findExecutable('nope', dir)).toBeNull()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
