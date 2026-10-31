import { mkdtemp, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { resolvePaths, type AppPaths } from '../../src/main/paths'
import { installResources, resourcesDir } from '../../src/main/resources'
import { WINDOWS } from '../helpers/processes'

let tmp: string
let paths: AppPaths
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'pitwall-res-'))
  paths = resolvePaths({ PITWALL_DATA_DIR: join(tmp, 'App Support', 'pitwall') }, tmp)
})
afterEach(async () => { await rm(tmp, { recursive: true, force: true }) })

const launch = () => join(paths.binDir, 'pitwall-launch')

const exists = (p: string) => stat(p).then(() => true, () => false)

describe('installResources', () => {
  test('installs scripts executable and the tmux config', async () => {
    await installResources(paths, resourcesDir(), 'darwin')
    if (!WINDOWS) expect((await stat(launch())).mode & 0o777).toBe(0o755) // (no POSIX modes on Windows)
    expect(await readFile(launch(), 'utf8')).toBe(await readFile(join(resourcesDir(), 'bin', 'pitwall-launch'), 'utf8'))
    expect(await readFile(paths.tmuxConf, 'utf8')).toContain('prefix None')
  })

  test('Windows has no tmux: the scripts, but no tmux config', async () => {
    await installResources(paths, resourcesDir(), 'win32')
    expect(await readFile(join(paths.binDir, 'pitwall-hook.ps1'), 'utf8'))
      .toBe(await readFile(join(resourcesDir(), 'bin', 'pitwall-hook.ps1'), 'utf8'))
    expect(await exists(paths.tmuxConf)).toBe(false)
  })

  test("this platform's default: a tmux config except on Windows", async () => {
    await installResources(paths)
    expect(await exists(paths.tmuxConf)).toBe(!WINDOWS)
  })

  test('identical files are not rewritten', async () => {
    await installResources(paths)
    const before = await stat(launch())
    await new Promise((r) => setTimeout(r, 20))
    await installResources(paths)
    const after = await stat(launch())
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  // sh reads a running script as it goes; Windows runs no sh scripts (PowerShell reads a script whole first).
  test.skipIf(WINDOWS)('a changed script is replaced by rename, never rewritten in place under a running reader', async () => {
    await installResources(paths)
    await writeFile(launch(), '#!/bin/sh\necho old version\n')
    const before = await stat(launch())
    const reader = await open(launch(), 'r') // like sh, which reads a running script as it goes
    try {
      await installResources(paths)
      const buf = Buffer.alloc(64)
      const { bytesRead } = await reader.read(buf, 0, 64, 0)
      expect(buf.subarray(0, bytesRead).toString()).toContain('echo old version')
    } finally {
      await reader.close()
    }
    const after = await stat(launch())
    expect(after.ino).not.toBe(before.ino)
    expect(after.mode & 0o777).toBe(0o755)
    expect(await readFile(launch(), 'utf8')).toBe(await readFile(join(resourcesDir(), 'bin', 'pitwall-launch'), 'utf8'))
    expect((await readdir(paths.binDir)).filter((f) => f.includes('.tmp'))).toEqual([])
  })
})
