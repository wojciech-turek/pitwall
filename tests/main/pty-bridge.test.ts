import { rm } from 'node:fs/promises'
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { exec } from '../../src/main/exec'
import { PtyBridge } from '../../src/main/pty-bridge'
import { resolveShellEnv } from '../../src/main/shell-env'
import { claudeTmuxName, Tmux } from '../../src/main/tmux'
import type { TermKind } from '../../src/shared/types'
import { makeTestEnv, tmuxSocketPath } from '../helpers/env'
import { waitFor } from '../helpers/wait'

let t: Awaited<ReturnType<typeof makeTestEnv>>
let bridge: PtyBridge
let data: string
let exits: Array<[string, TermKind, number]>
let inputs: Array<[string, TermKind, string]>

beforeEach(async () => {
  t = await makeTestEnv()
  data = ''; exits = []; inputs = []
  await t.tmux.newSession({ name: claudeTmuxName('s1'), cwd: t.tmp, argv: ['cat'] })
  bridge = new PtyBridge({
    tmux: t.tmux, env: t.env, ensureTarget: async () => {},
    onData: (_i, _k, d) => { data += d },
    onExit: (i, k, c) => { exits.push([i, k, c]) },
    onUserInput: (i, k, d) => { inputs.push([i, k, d]) }
  })
})
afterEach(async () => { bridge.closeAll(); await t.cleanup() })

describe('PtyBridge', () => {
  test('open → write → data comes back', async () => {
    await bridge.open('s1', 'claude', 100, 30)
    bridge.write('s1', 'claude', 'ping\r')
    await waitFor(async () => data.includes('ping'), 8000, 'ping echoed')
  })

  test('close detaches but tmux session survives', async () => {
    await bridge.open('s1', 'claude', 100, 30)
    bridge.close('s1', 'claude')
    await new Promise((r) => setTimeout(r, 500))
    expect(await t.tmux.hasSession(claudeTmuxName('s1'))).toBe(true)
    expect(exits).toEqual([])
  })

  test('open twice keeps one pty', async () => {
    await bridge.open('s1', 'claude', 100, 30)
    await bridge.open('s1', 'claude', 100, 30)
    await new Promise((r) => setTimeout(r, 500))
    expect(exits).toEqual([]) // a pty we killed ourselves is not reported
    data = ''
    bridge.write('s1', 'claude', 'again\r')
    await waitFor(async () => data.includes('again'), 8000, 'data from second pty')
  })

  test('write reports user input', async () => {
    await bridge.open('s1', 'claude', 100, 30)
    bridge.write('s1', 'claude', '\x1b')
    expect(inputs).toEqual([['s1', 'claude', '\x1b']])
  })

  test('exit is forwarded when the attach ends on its own', async () => {
    await bridge.open('s1', 'claude', 100, 30)
    await t.tmux.killSession(claudeTmuxName('s1'))
    await waitFor(async () => exits.length > 0, 8000, 'exit')
    expect(exits[0][0]).toBe('s1')
  })
})

describe('UTF-8 in a Finder-launched app', () => {
  // Claude's TUI glyphs; a non-UTF-8 tmux client prints `A_ _ _ h_llo _` instead.
  const GLYPHS = 'A❯ ⏺ ⎿ héllo ❯'
  const FINDER = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir() }
  const tmuxPath = async () => (await exec('/bin/zsh', ['-ilc', 'command -v tmux'])).stdout.trim().split('\n').pop()!

  async function render(tmux: Tmux, env: Record<string, string>): Promise<string> {
    let out = ''
    const b = new PtyBridge({
      tmux, env, ensureTarget: async () => {}, onData: (_i, _k, d) => { out += d }, onExit: () => {}, onUserInput: () => {}
    })
    try {
      await tmux.newSession({ name: claudeTmuxName('u'), cwd: t.tmp, argv: ['sh', '-c', `printf '%s\\n' '${GLYPHS}'; sleep 60`] })
      await waitFor(async () => (await tmux.capturePane(claudeTmuxName('u'))).includes('héllo'), 8000, 'glyphs in pane')
      await b.open('u', 'claude', 100, 30)
      await waitFor(async () => out.includes('h') && out.includes('llo'), 8000, 'attach output')
      await new Promise((r) => setTimeout(r, 300))
      return out
    } finally {
      b.closeAll()
    }
  }

  test('attach without LANG/LC_* still renders UTF-8 (tmux -u)', { timeout: 30_000 }, async () => {
    const tmux = new Tmux({ socket: t.paths.tmuxSocket, confPath: t.paths.tmuxConf, env: t.env, exec, tmuxBin: await tmuxPath() })
    const out = await render(tmux, FINDER)
    expect(out).toContain('héllo ❯')
    expect(out).toContain('⏺ ⎿')
    expect(out).not.toContain('h_llo')
  })

  test('resolved Finder env: server and client started from it render UTF-8', { timeout: 60_000 }, async () => {
    const env = await resolveShellEnv({ shell: '/bin/zsh', base: FINDER })
    expect(env.LANG ?? env.LC_CTYPE ?? env.LC_ALL).toMatch(/utf-?8/i)
    const socket = `${t.paths.tmuxSocket}-finder`
    const tmux = new Tmux({ socket, confPath: t.paths.tmuxConf, env, exec, tmuxBin: await tmuxPath() })
    try {
      const out = await render(tmux, env)
      expect(out).toContain('héllo ❯')
      expect(out).not.toContain('h_llo')
    } finally {
      await tmux.killServer().catch(() => {})
      await rm(tmuxSocketPath(socket, env), { force: true })
    }
  })
})
