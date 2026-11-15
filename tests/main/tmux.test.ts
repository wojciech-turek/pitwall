import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { exec } from '../../src/main/exec'
import { claudeTmuxName, serverTmuxName, shellTmuxName, tmuxNameFor } from '../../src/main/tmux'
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
    expect(serverTmuxName('abc')).toBe('pw-abc-srv')
    expect(tmuxNameFor('a', 'claude')).toBe('pw-a')
    expect(tmuxNameFor('a', 'shell')).toBe('pw-a-sh')
    expect(tmuxNameFor('a', 'server')).toBe('pw-a-srv')
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

  test('listAllPanes: every live pane by session name in one call; dead panes skipped; no server is empty', async () => {
    expect(await t.tmux.listAllPanes()).toEqual({ serverPid: null, panes: new Map() })
    await t.tmux.newSession({ name: 'pw-a', cwd: t.tmp, argv: ['sleep', '30'] })
    await t.tmux.newSession({ name: 'pw-a-sh', cwd: t.tmp, argv: ['sleep', '30'] })
    const r = await t.tmux.listAllPanes()
    expect([...r.panes.keys()].sort()).toEqual(['pw-a', 'pw-a-sh'])
    expect(r.serverPid).toBeGreaterThan(1)
    for (const pids of r.panes.values()) expect(pids).toHaveLength(1)
    const one = await t.tmux.listPanePids('pw-a')
    expect(r.panes.get('pw-a')).toEqual(one.panePids)
    expect(r.serverPid).toBe(one.serverPid)
  })

  test('listAllPanes skips a dead pane (remain-on-exit)', async () => {
    await t.tmux.newSession({ name: 'pw-keep', cwd: t.tmp, argv: ['sleep', '30'] })
    await t.tmux.newSession({ name: 'pw-dead', cwd: t.tmp, argv: ['sh', '-c', 'exit 0'] })
    // The test conf may not keep dead panes; either way a dead one must not be listed.
    await waitFor(async () => !(await t.tmux.listAllPanes()).panes.has('pw-dead'), 8000, 'dead pane not listed')
    expect((await t.tmux.listAllPanes()).panes.has('pw-keep')).toBe(true)
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
