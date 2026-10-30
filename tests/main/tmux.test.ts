import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { exec } from '../../src/main/exec'
import { claudeTmuxName, shellTmuxName } from '../../src/main/tmux'
import { access } from 'node:fs/promises'
import { makeTestEnv, tmuxSocketPath } from '../helpers/env'
import { waitFor } from '../helpers/wait'

let t: Awaited<ReturnType<typeof makeTestEnv>>
beforeEach(async () => { t = await makeTestEnv() })
afterEach(async () => { await t.cleanup() })

describe('Tmux', () => {
  test('names', () => {
    expect(claudeTmuxName('abc')).toBe('pw-abc')
    expect(shellTmuxName('abc')).toBe('pw-abc-sh')
  })

  test('new/list/capture/kill on private socket', async () => {
    await t.tmux.newSession({ name: 'pw-a', cwd: t.tmp, argv: ['sh', '-c', 'echo hello; sleep 30'] })
    expect(await t.tmux.hasSession('pw-a')).toBe(true)
    expect(await t.tmux.listSessions()).toEqual(['pw-a'])
    await waitFor(async () => (await t.tmux.capturePane('pw-a')).includes('hello'), 8000, 'hello in pane')
    await t.tmux.killSession('pw-a')
    expect(await t.tmux.hasSession('pw-a')).toBe(false)
    await t.tmux.killSession('pw-a') // missing is ignored
  })

  test('test cleanup kills the server and removes its socket file', async () => {
    const own = await makeTestEnv()
    await own.tmux.newSession({ name: 'pw-z', cwd: own.tmp, argv: ['sleep', '30'] })
    const sock = tmuxSocketPath(own.paths.tmuxSocket, own.env)
    await access(sock)
    await own.cleanup()
    await expect(access(sock)).rejects.toThrow()
    expect(await own.tmux.listSessions()).toEqual([])
  })

  test('listSessions with no server → []', async () => {
    expect(await t.tmux.listSessions()).toEqual([])
    expect(await t.tmux.hasSession('nope')).toBe(false)
  })

  test('config applied: prefix None, status off', async () => {
    await t.tmux.newSession({ name: 'pw-c', cwd: t.tmp, argv: ['sleep', '30'] })
    const sock = t.paths.tmuxSocket
    const prefix = await exec('tmux', ['-L', sock, '-f', t.paths.tmuxConf, 'show', '-g', 'prefix'], { env: t.env })
    expect(prefix.stdout).toContain('None')
    const status = await exec('tmux', ['-L', sock, '-f', t.paths.tmuxConf, 'show', '-g', 'status'], { env: t.env })
    expect(status.stdout).toContain('off')
  })

  test('pasteText delivers text', async () => {
    await t.tmux.newSession({ name: 'pw-p', cwd: t.tmp, argv: ['cat'] })
    await t.tmux.pasteText('pw-p', 'hello @x')
    await waitFor(async () => (await t.tmux.capturePane('pw-p')).includes('hello @x'), 8000, 'pasted text')
  })

  test('sendKeys and attachCommand', async () => {
    await t.tmux.newSession({ name: 'pw-k', cwd: t.tmp, argv: ['cat'] })
    await t.tmux.sendKeys('pw-k', ['typed', 'Enter'])
    await waitFor(async () => (await t.tmux.capturePane('pw-k')).includes('typed'), 8000, 'typed text')
    const a = t.tmux.attachCommand('pw-k')
    expect(a.args).toEqual(['-u', '-L', t.paths.tmuxSocket, '-f', t.paths.tmuxConf, 'attach-session', '-t', '=pw-k'])
  })
})
