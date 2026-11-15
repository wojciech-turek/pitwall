import { beforeEach, describe, expect, test, vi } from 'vitest'

// The handlers registerIpc gives Electron, by channel, called as the renderer would call them.
const electron = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) => {
      electron.handlers.set(channel, (...args) => fn({}, ...args))
    },
    on: () => {},
    removeHandler: () => {},
    removeAllListeners: () => {}
  },
  shell: { openExternal: async () => {} }
}))

import { IPC } from '../../src/shared/api'
import { registerIpc, type IpcDeps } from '../../src/main/ipc'

const ok = { ok: true, sessionId: 's_1' }
const invalid = { ok: false, step: 'identity', error: 'Invalid request.' }
let manager: {
  onSnapshot: () => () => void
  start: ReturnType<typeof vi.fn>
  listConversations: ReturnType<typeof vi.fn>
  searchConversations: ReturnType<typeof vi.fn>
  continueConversation: ReturnType<typeof vi.fn>
  setPinned: ReturnType<typeof vi.fn>
}
let history: { search: ReturnType<typeof vi.fn>; forgetFiles: ReturnType<typeof vi.fn> }

const call = (channel: string, ...args: unknown[]) => {
  const fn = electron.handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  return fn(...args)
}

beforeEach(() => {
  electron.handlers.clear()
  manager = {
    onSnapshot: () => () => {},
    start: vi.fn(async () => ok),
    listConversations: vi.fn(async () => ({ items: [{ kind: 'outside', id: 'c', title: 'T', updatedAt: 1 }], truncated: false })),
    searchConversations: vi.fn(async () => [{ kind: 'outside', id: 'c', matchedIn: 'title', snippet: '' }]),
    continueConversation: vi.fn(async () => ok),
    setPinned: vi.fn(async () => {})
  }
  history = { search: vi.fn(async () => []), forgetFiles: vi.fn() }
  registerIpc({
    manager, history,
    pr: { feedbackContext: async () => ({ ok: false as const, message: 'x' }) },
    accounts: { onChange: () => () => {} },
    usage: { current: () => [], onChange: () => () => {} },
    systemStats: { current: () => null, onChange: () => () => {} },
    updates: { state: () => null, checkNow: async () => {}, onChange: () => () => {}, hasFeed: () => false },
    send: () => {}, onViewing: () => {}, env: {}, home: '/home/me', dev: false
  } as unknown as IpcDeps)
})

describe('IPC from the renderer', () => {
  test('startSession can never continue an outside conversation: continueClaudeId and continuedFrom are dropped', async () => {
    const input = {
      requestId: 'r', subProjectId: 'sp_1', title: 'Fix it', branchMode: 'new', branch: '',
      continueClaudeId: '00000001-0000-4000-8000-00000000000a', continuedFrom: '/x/repo'
    }
    expect(await call(IPC.startSession, input)).toEqual(ok)
    expect(manager.start).toHaveBeenCalledTimes(1)
    const passed = manager.start.mock.calls[0][0] as Record<string, unknown>
    expect(passed.continueClaudeId).toBeUndefined()
    expect(passed.continuedFrom).toBeUndefined()
    expect(passed).toEqual({ requestId: 'r', subProjectId: 'sp_1', title: 'Fix it', branchMode: 'new', branch: '' })
  })

  test('startSession cannot pass createdBy or initialPrompt: only the pitwall command may', async () => {
    const input = { requestId: 'r', subProjectId: 'sp_1', title: 'T', branchMode: 'new', branch: '', createdBy: 's_x', initialPrompt: 'do evil' }
    await call(IPC.startSession, input)
    const passed = manager.start.mock.calls[0][0] as Record<string, unknown>
    expect(passed.createdBy).toBeUndefined()
    expect(passed.initialPrompt).toBeUndefined()
  })

  test('listConversations, searchConversations and continueConversation refuse arguments of the wrong type, never reaching the manager', async () => {
    for (const bad of [undefined, null, 1, true, {}, ['sp_1']]) {
      expect(await call(IPC.listConversations, bad)).toEqual({ items: [], truncated: false })
      expect(await call(IPC.searchConversations, bad, 'tax')).toEqual([])
      expect(await call(IPC.searchConversations, 'sp_1', bad)).toEqual([])
      expect(await call(IPC.continueConversation, bad, 'c', 'r')).toEqual(invalid)
      expect(await call(IPC.continueConversation, 'sp_1', bad, 'r')).toEqual(invalid)
      expect(await call(IPC.continueConversation, 'sp_1', 'c', bad)).toEqual(invalid)
    }
    expect(manager.listConversations).not.toHaveBeenCalled()
    expect(manager.searchConversations).not.toHaveBeenCalled()
    expect(manager.continueConversation).not.toHaveBeenCalled()
    // Strings get through.
    expect(await call(IPC.listConversations, 'sp_1')).toEqual({ items: [{ kind: 'outside', id: 'c', title: 'T', updatedAt: 1 }], truncated: false })
    expect(manager.listConversations).toHaveBeenCalledWith('sp_1')
    expect(await call(IPC.searchConversations, 'sp_1', 'tax')).toEqual([{ kind: 'outside', id: 'c', matchedIn: 'title', snippet: '' }])
    expect(manager.searchConversations).toHaveBeenCalledWith('sp_1', 'tax')
    expect(await call(IPC.continueConversation, 'sp_1', 'c', 'r')).toEqual(ok)
    expect(manager.continueConversation).toHaveBeenCalledWith('sp_1', 'c', 'r', expect.any(Function))
  })

  test('forgetConversationText (the dialog closed) drops the conversation text its searches kept', async () => {
    await call(IPC.forgetConversationText)
    expect(history.forgetFiles).toHaveBeenCalledTimes(1)
  })

  test('setSessionPinned pins only on a literal true', async () => {
    await call(IPC.setSessionPinned, 's_1', true)
    await call(IPC.setSessionPinned, 's_1', 'yes')
    await call(IPC.setSessionPinned, 's_1', false)
    expect(manager.setPinned.mock.calls).toEqual([['s_1', true], ['s_1', false], ['s_1', false]])
  })
})

describe('IPC: stray worktrees', () => {
  const calls: string[][] = []
  const store = { state: { sessions: [], subProjects: [
    { id: 'sp_repo', kind: 'repo', repoRoot: '/r' }, { id: 'sp_plain', kind: 'folder' }
  ] } }
  const git = { listWorktrees: vi.fn(async () => [{ path: '/r', prunable: false, detached: false }, { path: '/w/a', prunable: false, detached: false, branch: 'a' }]) }
  const exec = vi.fn(async (file: string, args: string[]) => { calls.push([file, ...args]); return { code: 0, stdout: '', stderr: '' } })

  beforeEach(() => {
    calls.length = 0
    git.listWorktrees.mockClear()
    registerIpc({
      manager, history, store, git, exec, paths: { dataDir: '/nowhere/pitwall' },
      pr: { feedbackContext: async () => ({ ok: false as const, message: 'x' }) },
      accounts: { onChange: () => () => {} },
      usage: { current: () => [], onChange: () => () => {} },
      systemStats: { current: () => null, onChange: () => () => {} },
      updates: { state: () => null, checkNow: async () => {}, onChange: () => () => {}, hasFeed: () => false },
      send: () => {}, onViewing: () => {}, env: {}, home: '/home/me', dev: false
    } as unknown as IpcDeps)
  })

  test('worktreeSize measures only a path the folder could list as a stray', async () => {
    expect(await call(IPC.worktreeSize, 'sp_repo', '/etc')).toBeNull()
    expect(await call(IPC.worktreeSize, 'sp_repo', '/r')).toBeNull() // the main checkout
    expect(await call(IPC.worktreeSize, 'sp_repo', '/w/a/../../etc')).toBeNull()
    expect(await call(IPC.worktreeSize, 'sp_plain', '/w/a')).toBeNull()
    expect(await call(IPC.worktreeSize, 'nope', '/w/a')).toBeNull()
    for (const bad of [undefined, null, 1, {}, ['/w/a']]) expect(await call(IPC.worktreeSize, 'sp_repo', bad)).toBeNull()
    expect(calls.filter((c) => c[0] === 'du')).toEqual([])
    await call(IPC.worktreeSize, 'sp_repo', '/w/a')
    expect(calls.filter((c) => c[0] === 'du')).toEqual([['du', '-sk', '/w/a']])
  })

  test('arguments of the wrong type never reach git: nothing is listed or removed', async () => {
    for (const bad of [undefined, null, 1, {}, ['sp_repo']]) {
      expect(await call(IPC.listStrayWorktrees, bad)).toEqual([])
      expect(await call(IPC.removeStrayWorktrees, bad, ['/w/a'], true)).toEqual([])
    }
    for (const bad of [undefined, null, 'x', 1, [1], ['/w/a', 2], {}]) {
      expect(await call(IPC.removeStrayWorktrees, 'sp_repo', bad, true)).toEqual([])
    }
    expect(await call(IPC.listStrayWorktrees, 'sp_plain')).toEqual([])
    expect(await call(IPC.removeStrayWorktrees, 'sp_plain', ['/w/a'], true)).toEqual([])
    expect(git.listWorktrees).not.toHaveBeenCalled()
  })
})

describe('IPC: pasting into a session that needs you', () => {
  const ANSWER_FIRST = 'Claude is waiting for your answer. Answer it first, then send this.'
  const pasted: string[] = []
  let status = 'needs_you'
  const store = { state: { sessions: [{ id: 's_1', subProjectId: 'sp_1', cwd: '/w' }], subProjects: [{ id: 'sp_1', kind: 'folder' }] } }
  const pr = {
    number: 3, url: 'https://github.com/o/r/pull/3', title: 't', state: 'OPEN', checks: 'failing', updatedAt: 0, failing: [{ name: 'build' }]
  }

  beforeEach(() => {
    pasted.length = 0
    status = 'needs_you'
    registerIpc({
      manager: { ...manager, snapshot: () => ({ sessions: [{ id: 's_1', status }] }) },
      history, store, paths: { dataDir: '/nowhere/pitwall', ghBin: 'gh' },
      backend: { pasteText: async (_n: string, x: string) => { pasted.push(x) } },
      pr: { feedbackContext: async () => ({ ok: true as const, pr, dir: '/w', token: 't', owner: 'o', repo: 'r' }) },
      accounts: { onChange: () => () => {} },
      usage: { current: () => [], onChange: () => () => {} },
      systemStats: { current: () => null, onChange: () => () => {} },
      updates: { state: () => null, checkNow: async () => {}, onChange: () => () => {}, hasFeed: () => false },
      send: () => {}, onViewing: () => {}, env: {}, home: '/home/me', dev: false
    } as unknown as IpcDeps)
  })

  test('Send to agent (a review, a file reference) and PR feedback are refused, so the paste never lands in an answer', async () => {
    await expect(call(IPC.sendToAgent, 's_1', 'Review of your changes')).rejects.toThrow(ANSWER_FIRST)
    expect(await call(IPC.sendPrFeedback, 's_1', 'checks')).toEqual({ ok: false, message: ANSWER_FIRST })
    expect(pasted).toEqual([])
  })

  test('once Claude is no longer asking, both paste', async () => {
    status = 'working'
    await call(IPC.sendToAgent, 's_1', 'look at @a.ts')
    expect(await call(IPC.sendPrFeedback, 's_1', 'checks')).toEqual({ ok: true, count: 1 })
    expect(pasted).toHaveLength(2)
    expect(pasted[0]).toBe('look at @a.ts')
  })
})

describe('Claude accounts over IPC', () => {
  const calls: unknown[][] = []
  const accounts = {
    list: vi.fn(async () => [{ id: 'default', account: '/h/.claude', label: 'me@x.com', active: true, sessions: 0, signedIn: true }]),
    onChange: () => () => {},
    beginAdd: vi.fn(async () => ({ addId: 'acct_1', dir: '/secret/path' })),
    finishAdd: vi.fn(async (id: string) => { calls.push(['finish', id]); return { ok: true as const, id } }),
    cancelAdd: vi.fn(async (id: string) => { calls.push(['cancel', id]) }),
    remove: vi.fn(async (id: string) => { calls.push(['remove', id]) }),
    copyFromDefault: vi.fn(async (id: string) => { calls.push(['copy', id]) }),
    endLogin: vi.fn(async (id: string) => { calls.push(['end', id]) })
  }
  beforeEach(() => {
    calls.length = 0
    electron.handlers.clear()
    registerIpc({
      manager: { onSnapshot: () => () => {} }, accounts,
      usage: { current: () => [], onChange: () => () => {} },
      systemStats: { current: () => null, onChange: () => () => {} },
      updates: { state: () => null, checkNow: async () => {}, onChange: () => () => {}, hasFeed: () => false },
      send: () => {}, onViewing: () => {}, env: {}, home: '/home/me', dev: false
    } as unknown as IpcDeps)
  })

  test('the list, and a new account to sign in to: the renderer gets the terminal to show, never the folder', async () => {
    expect(await call(IPC.getAccounts)).toHaveLength(1)
    expect(await call(IPC.beginAddAccount)).toEqual({ addId: 'acct_1', termId: 'login-acct_1' })
  })

  test('each call passes its id on', async () => {
    await call(IPC.finishAddAccount, 'acct_1')
    await call(IPC.cancelAddAccount, 'acct_1')
    await call(IPC.removeAccount, 'acct_1')
    await call(IPC.copyAccountSettings, 'acct_1')
    await call(IPC.endAccountLogin, 'acct_1')
    expect(calls).toEqual([['finish', 'acct_1'], ['cancel', 'acct_1'], ['remove', 'acct_1'], ['copy', 'acct_1'], ['end', 'acct_1']])
  })

  test('an id that is not a string is refused', async () => {
    for (const ch of [IPC.finishAddAccount, IPC.cancelAddAccount, IPC.removeAccount, IPC.copyAccountSettings, IPC.endAccountLogin]) {
      await expect(Promise.resolve().then(() => call(ch, { evil: 1 }))).rejects.toThrow('Invalid account.')
      await expect(Promise.resolve().then(() => call(ch))).rejects.toThrow('Invalid account.')
    }
    expect(calls).toEqual([])
  })
})

describe('switching and moving over IPC', () => {
  const calls: unknown[][] = []
  const mover = {
    request: vi.fn(async (...a: unknown[]) => { calls.push(['request', ...a]) }),
    requestAll: vi.fn(async (...a: unknown[]) => { calls.push(['requestAll', ...a]); return { now: 2, later: 1 } }),
    cancel: vi.fn(async (...a: unknown[]) => { calls.push(['cancel', ...a]) }),
    moveBack: vi.fn(async (...a: unknown[]) => { calls.push(['moveBack', ...a]) }),
    countMovable: vi.fn((...a: unknown[]) => { calls.push(['count', ...a]); return { now: 2, later: 1 } })
  }
  const accounts = { onChange: () => () => {}, setActive: vi.fn(async (...a: unknown[]) => { calls.push(['setActive', ...a]) }) }
  beforeEach(() => {
    calls.length = 0
    electron.handlers.clear()
    registerIpc({
      manager: { onSnapshot: () => () => {} }, store: { state: { sessions: [{ id: 's1' }, { id: 'old', archivedAt: 1 }] } }, accounts, mover,
      usage: { current: () => [], onChange: () => () => {} },
      systemStats: { current: () => null, onChange: () => () => {} },
      updates: { state: () => null, checkNow: async () => {}, onChange: () => () => {}, hasFeed: () => false },
      send: () => {}, onViewing: () => {}, env: {}, home: '/home/me', dev: false
    } as unknown as IpcDeps)
  })

  test('Switch for new sessions only: the active account changes and nothing moves', async () => {
    expect(await call(IPC.setActiveAccount, 'a1', false)).toEqual({ now: 0, later: 0 })
    expect(calls).toEqual([['setActive', 'a1']])
  })

  test('Switch and move: the active account changes first, then every running session is asked to move', async () => {
    expect(await call(IPC.setActiveAccount, 'a1', true)).toEqual({ now: 2, later: 1 })
    expect(calls).toEqual([['setActive', 'a1'], ['requestAll', 'a1']])
  })

  test('one session: move, cancel, move back; and the count for the dialog', async () => {
    await call(IPC.moveSession, 's1', 'a1')
    await call(IPC.cancelMove, 's1')
    await call(IPC.moveBack, 's1')
    expect(await call(IPC.countMovable, 'a1')).toEqual({ now: 2, later: 1 })
    expect(calls).toEqual([['request', 's1', 'a1'], ['cancel', 's1'], ['moveBack', 's1'], ['count', 'a1']])
  })

  test('ids that are not strings, or not a live session, are refused', async () => {
    const refused = (ch: string, ...a: unknown[]) => expect(Promise.resolve().then(() => call(ch, ...a))).rejects.toThrow()
    await refused(IPC.setActiveAccount, 7, true)
    await refused(IPC.moveSession, 's1', null)
    await refused(IPC.moveSession, 'ghost', 'a1')
    await refused(IPC.cancelMove, 'ghost')
    await refused(IPC.moveSession, 'old', 'a1')
    await refused(IPC.moveBack, {})
    await refused(IPC.countMovable)
    expect(calls).toEqual([])
  })
})

