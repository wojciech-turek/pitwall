import { rm } from 'node:fs/promises'
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { AttachHandlers, SessionBackend } from '../../src/main/backend'
import { exec } from '../../src/main/exec'
import { MAX_TYPED, PtyBridge } from '../../src/main/pty-bridge'
import { resolveShellEnv } from '../../src/main/shell-env'
import { claudeTmuxName, Tmux } from '../../src/main/tmux'
import { TmuxBackend } from '../../src/main/tmux-backend'
import type { TermKind } from '../../src/shared/types'
import { makeTestEnv, tmuxSocketPath } from '../helpers/env'
import { WINDOWS } from '../helpers/processes'
import { waitFor } from '../helpers/wait'

let t: Awaited<ReturnType<typeof makeTestEnv>>
let bridge: PtyBridge
let data: string
let exits: Array<[string, TermKind, number]>
let inputs: Array<[string, TermKind, string]>

// tmux (macOS). On Windows only the tests with a stand-in backend run (the app's host attaches asynchronously too).
beforeEach(async () => {
  if (WINDOWS) return
  t = await makeTestEnv()
  data = ''; exits = []; inputs = []
  await t.tmux.newSession({ name: claudeTmuxName('s1'), cwd: t.tmp, argv: ['cat'] })
  bridge = new PtyBridge({
    backend: t.backend, ensureTarget: async () => {},
    onData: (_i, _k, d) => { data += d },
    onExit: (i, k, c) => { exits.push([i, k, c]) },
    onUserInput: (i, k, d) => { inputs.push([i, k, d]) }
  })
})
afterEach(async () => { bridge?.closeAll(); await t?.cleanup() })

describe.skipIf(WINDOWS)('PtyBridge', () => {
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

  test('detach closes the pty and reports one exit, so the terminal offers to reattach; tmux keeps running', async () => {
    await bridge.open('s1', 'claude', 100, 30)
    bridge.detach('s1', 'claude')
    expect(exits).toEqual([['s1', 'claude', 0]])
    await new Promise((r) => setTimeout(r, 500))
    expect(exits).toHaveLength(1) // the killed pty's own exit isn't reported again
    expect(await t.tmux.hasSession(claudeTmuxName('s1'))).toBe(true)
  })

  test('detach of a terminal that was already closed still reports an exit', async () => {
    await bridge.open('s1', 'claude', 100, 30)
    bridge.close('s1', 'claude')
    bridge.detach('s1', 'claude')
    expect(exits).toEqual([['s1', 'claude', 0]])
  })
})

describe.skipIf(WINDOWS)('PtyBridge waiting on ensureTarget', () => {
  // attachCommand runs right before pty.spawn (in TmuxBackend.attach), so recording it shows whether a pty was spawned.
  function spyBridge(ensureTarget: () => Promise<void>) {
    const attaches: string[] = []
    const targets: string[] = []
    const tmux = Object.assign(Object.create(t.tmux) as Tmux, {
      attachCommand: (name: string) => { attaches.push(name); return t.tmux.attachCommand(name) }
    })
    const b = new PtyBridge({
      backend: new TmuxBackend(tmux, t.env),
      ensureTarget: async (id) => { targets.push(id); await ensureTarget() },
      onData: () => {}, onExit: () => {}, onUserInput: () => {}
    })
    return { b, attaches, targets }
  }
  function gate() {
    let open!: () => void
    const wait = new Promise<void>((r) => { open = r })
    return { wait, open }
  }

  test('an open() that finishes waiting normally spawns one pty', async () => {
    const { b, attaches } = spyBridge(async () => {})
    await b.open('s1', 'claude', 100, 30)
    expect(attaches).toEqual([claudeTmuxName('s1')])
    b.dispose()
  })

  test('an open() whose ensureTarget resolves after dispose() never spawns', async () => {
    const g = gate()
    const { b, attaches, targets } = spyBridge(() => g.wait)
    const opening = b.open('s1', 'claude', 100, 30)
    b.dispose()
    g.open()
    await opening
    expect(attaches).toEqual([])
    // And nothing new starts once disposed: not even the tmux target.
    await b.open('s1', 'shell', 100, 30)
    expect(targets).toEqual(['s1'])
    expect(attaches).toEqual([])
  })

  test('closeAll cancels an open() still waiting on ensureTarget', async () => {
    const g = gate()
    const { b, attaches } = spyBridge(() => g.wait)
    const opening = b.open('s1', 'claude', 100, 30)
    b.closeAll()
    g.open()
    await opening
    expect(attaches).toEqual([])
    b.dispose()
  })
})

describe('PtyBridge with a backend that attaches asynchronously', () => {
  // TmuxBackend attaches at once; a backend that answers later must not leak a terminal or a late callback.
  function slow(attach: Promise<void>) {
    const closed: string[] = []
    const got: string[] = []
    const calls: string[] = []
    let h: AttachHandlers | undefined
    const backend = {
      attach: async (name: string, _c: number, _r: number, handlers: AttachHandlers) => {
        h = handlers
        await attach
        return {
          write: (d: string) => { calls.push(`write ${d}`) },
          resize: (c: number, r: number) => { calls.push(`resize ${c}x${r}`) },
          close: () => { closed.push(name) }
        }
      }
    } as unknown as SessionBackend
    const b = new PtyBridge({
      backend, ensureTarget: async () => {},
      onData: (_i, _k, d) => { got.push(d) }, onExit: (_i, _k, c) => { got.push(`exit ${c}`) }, onUserInput: () => {}
    })
    return { b, closed, got, calls, handlers: () => waitFor(async () => h, 2000, 'attach called') }
  }

  test('input typed while attaching is kept up to MAX_TYPED; the excess is dropped, with a log line', async () => {
    let arrive!: () => void
    const { b, calls, handlers } = slow(new Promise((r) => { arrive = r }))
    const opening = b.open('s1', 'claude', 100, 30)
    await handlers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      b.write('s1', 'claude', 'x'.repeat(MAX_TYPED - 1))
      b.write('s1', 'claude', 'yz') // one fits, one doesn't
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped 1 characters'))
    } finally {
      warn.mockRestore()
    }
    arrive()
    await opening
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBe(`write ${'x'.repeat(MAX_TYPED - 1)}y`)
    b.dispose()
  })

  test('a resize and keys sent while attaching reach the attachment once it arrives (the last size only)', async () => {
    let arrive!: () => void
    const { b, calls, handlers } = slow(new Promise((r) => { arrive = r }))
    const opening = b.open('s1', 'claude', 100, 30)
    await handlers()
    b.resize('s1', 'claude', 120, 40)
    b.resize('s1', 'claude', 0, 41)
    b.write('s1', 'claude', 'a')
    b.write('s1', 'claude', 'b')
    expect(calls).toEqual([])
    arrive()
    await opening
    expect(calls).toEqual(['resize 1x41', 'write ab'])
    b.resize('s1', 'claude', 130, 50)
    b.write('s1', 'claude', 'c')
    expect(calls).toEqual(['resize 1x41', 'write ab', 'resize 130x50', 'write c'])
    b.dispose()
  })

  test('output before attach() returns is forwarded; a dispose meanwhile closes the attachment once it arrives', async () => {
    let arrive!: () => void
    const { b, closed, got, handlers } = slow(new Promise((r) => { arrive = r }))
    const opening = b.open('s1', 'claude', 100, 30)
    const h = await handlers()
    h.onData('replay')
    b.dispose()
    h.onData('late')
    h.onExit(0)
    arrive()
    await opening
    expect(got).toEqual(['replay'])
    expect(closed).toEqual([claudeTmuxName('s1')])
  })

  test('a failed attach rejects open()', async () => {
    const { b, closed } = slow(Promise.reject(new Error('no host')))
    await expect(b.open('s1', 'claude', 100, 30)).rejects.toThrow('no host')
    b.write('s1', 'claude', 'x') // nothing registered: a no-op
    b.dispose()
    expect(closed).toEqual([])
  })
})

describe.skipIf(WINDOWS)('UTF-8 in a Finder-launched app', () => {
  // Claude's TUI glyphs; a non-UTF-8 tmux client prints `A_ _ _ h_llo _` instead.
  const GLYPHS = 'A❯ ⏺ ⎿ héllo ❯'
  const FINDER = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir() }
  const tmuxPath = async () => (await exec('/bin/zsh', ['-ilc', 'command -v tmux'])).stdout.trim().split('\n').pop()!

  async function render(tmux: Tmux, env: Record<string, string>): Promise<string> {
    let out = ''
    const b = new PtyBridge({
      backend: new TmuxBackend(tmux, env), ensureTarget: async () => {}, onData: (_i, _k, d) => { out += d }, onExit: () => {}, onUserInput: () => {}
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
