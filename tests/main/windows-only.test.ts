/**
 * What only Windows can prove: cmd.exe escaping, teardown in cmd.exe, taskkill. Skipped elsewhere; Task 4's Windows
 * runner runs them.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { exec } from '../../src/main/exec'
import { snapshotLeftovers, stopLeftovers } from '../../src/main/sessions/leftovers'
import { runTeardown } from '../../src/main/sessions/teardown'
import { waitFor } from '../helpers/wait'

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe.skipIf(process.platform !== 'win32')('on Windows', () => {
  let dir: string
  beforeEach(async () => {
    // A space and a non-ASCII letter, like many Windows profile folders.
    dir = await mkdtemp(join(tmpdir(), 'pitwall wïn-'))
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) })

  test('exec runs a .cmd found on PATH with every argument intact', async () => {
    await writeFile(join(dir, 'args.mjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
    await writeFile(join(dir, 'showargs.cmd'), '@node "%~dp0args.mjs" %*\r\n')
    const args = ['plain', 'two words', 'a & b | c', '50% off', '"quoted"', 'caret ^ x', 'C:\\path with\\', 'tick`$x', '(paren)!', 'Zoë']
    const env = { ...process.env, Path: `${dir};${process.env.Path ?? process.env.PATH ?? ''}` } as Record<string, string>
    delete env.PATH
    const r = await exec('showargs', args, { env })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual(args)
  })

  test('teardown runs in cmd.exe in the folder with the session env, and reports its exit code', async () => {
    const r = await runTeardown('echo %PITWALL_BRANCH%& cd & exit /b 3', {
      cwd: dir, env: { ...(process.env as Record<string, string>), PITWALL_BRANCH: 'pitwall/x' }
    })
    expect(r.exitCode).toBe(3)
    expect(r.output).toContain('pitwall/x')
    expect(r.output.toLowerCase()).toContain(dir.toLowerCase())
  })

  test("teardown: the command reaches cmd.exe byte for byte (quoted values with & | < > ^, && chains, one %-expansion, !), and its output reads in any language", async () => {
    const env = {
      ...(process.env as Record<string, string>),
      V: 'a=1&b=2|c>d^e', PITWALL_SESSION_TITLE: 'Search & filter', V2: 'two', V3: '%OTHER%', OTHER: 'expanded twice'
    }
    const out = async (command: string) => (await runTeardown(command, { cwd: dir, env })).output
    expect(await out('echo "%V%"')).toBe('"a=1&b=2|c>d^e"\r\n')
    expect(await out('echo "%PITWALL_SESSION_TITLE%"')).toBe('"Search & filter"\r\n')
    expect(await out('echo first %V2%&& echo second %V2%')).toBe('first two\r\nsecond two\r\n')
    expect(await out('echo [%V3%]')).toBe('[%OTHER%]\r\n')
    expect(await out('echo hi! there!')).toBe('hi! there!\r\n')
    expect(await out('echo zażółć gęślą jaźń')).toBe('zażółć gęślą jaźń\r\n')
  })

  test('a teardown that runs too long is stopped with everything it started', async () => {
    const pidFile = join(dir, 'child.pid')
    await writeFile(join(dir, 'spin.mjs'),
      `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'\n` +
      `const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })\n` +
      `writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000)\n`)
    const r = await runTeardown(`node "${join(dir, 'spin.mjs')}"`, {
      cwd: dir, env: process.env as Record<string, string>, timeoutMs: 3000
    })
    expect(r.timedOut).toBe(true)
    const child = Number(await readFile(pidFile, 'utf8'))
    await waitFor(async () => !alive(child), 10_000, 'the teardown\'s child ended')
  })

  test('leftovers: a pane of this "host" and everything below it are found by creation time and ended; nothing else', async () => {
    const pidFile = join(dir, 'grandchild.pid')
    const pane = spawn(process.execPath, ['-e',
      `const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });` +
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000)`],
    { stdio: 'ignore' })
    const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      await waitFor(async () => !!(await readFile(pidFile, 'utf8').catch(() => '')), 10_000, 'grandchild started')
      const grandchild = Number(await readFile(pidFile, 'utf8'))
      // This test process stands in for the host: the pane is its child. (Pitwall itself is never included, so the
      // "host" here can't be this process; its pid is the pane's parent all the same.)
      const snap = await snapshotLeftovers([pane.pid!, bystander.pid!], process.pid, { platform: 'win32' })
      expect([...snap.keys()].sort()).toEqual([pane.pid!, bystander.pid!, grandchild].sort())
      snap.delete(bystander.pid!)
      await stopLeftovers(snap, { platform: 'win32' })
      await waitFor(async () => !alive(pane.pid!) && !alive(grandchild), 10_000, 'the pane tree ended')
      expect(alive(bystander.pid!)).toBe(true)
    } finally {
      bystander.kill()
      pane.kill()
    }
  })
})
