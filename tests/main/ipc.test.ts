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
    continueConversation: vi.fn(async () => ok)
  }
  history = { search: vi.fn(async () => []), forgetFiles: vi.fn() }
  registerIpc({
    manager, history,
    usage: { current: () => null, onChange: () => () => {} },
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
})
