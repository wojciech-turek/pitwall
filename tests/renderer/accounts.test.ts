import { describe, expect, test } from 'vitest'
import {
  __accountsStore, __pushAccounts, panelMode, panelRows, staleNote, switchAccount, switchPrompt
} from '../../src/renderer/src/state/accounts'
import type { AccountView } from '../../src/shared/types'

const acct = (o: Partial<AccountView> = {}): AccountView =>
  ({ id: 'default', account: '/h/.claude', label: 'me@x.com', active: true, sessions: 0, signedIn: true, ...o })

describe('the account list in the renderer', () => {
  test('a pushed list replaces the stored one', () => {
    __pushAccounts([acct()])
    expect(__accountsStore.getState().accounts).toEqual([acct()])
    __pushAccounts([acct(), acct({ id: 'a1', account: '/d/a1', label: 'b@x.com', active: false })])
    expect(__accountsStore.getState().accounts.map((a) => a.id)).toEqual(['default', 'a1'])
  })
})

const MIN = 60_000
const now = Date.UTC(2026, 10, 15, 12, 0)
const usage = (pct: number, updatedAt = now) => ({ fiveHour: { usedPercentage: pct, resetsAt: now + 60 * MIN }, updatedAt })
const other = (o: Partial<AccountView> = {}): AccountView => acct({ id: 'a1', account: '/d/a1', label: 'b@x.com', active: false, ...o })

describe('how old an account\'s numbers are', () => {
  test('nothing under 10 minutes; then "updated … ago"', () => {
    expect(staleNote(now - 9 * MIN, now)).toBe('')
    expect(staleNote(now - 10 * MIN, now)).toBe('updated 10m ago')
    expect(staleNote(now - 180 * MIN, now)).toBe('updated 3h ago')
  })
})

describe('the panel beside the meters', () => {
  test('only the default account: as before (no label, no Switch), plain when it has no usage yet', () => {
    expect(panelMode([acct()])).toBe('empty')
    expect(panelMode([acct({ usage: usage(40) })])).toBe('single')
    expect(panelMode([acct({ usage: usage(40) }), other()])).toBe('multi')
    expect(panelMode([])).toBe('empty')
  })

  test('two accounts: the active one first and marked, Switch only on the other', () => {
    const rows = panelRows([acct({ usage: usage(96) }), other({ usage: usage(8) })], undefined, now)
    expect(rows.map((r) => [r.label, r.active, r.canSwitch])).toEqual([['me@x.com', true, false], ['b@x.com', false, true]])
  })

  test('an account with no usage yet says so; one with old numbers says how old', () => {
    const rows = panelRows([acct({ usage: usage(96, now - 180 * MIN) }), other()], undefined, now)
    expect(rows[0].stale).toBe('updated 3h ago')
    expect(rows[0].usage).toBeDefined()
    expect(rows[1].usage).toBeUndefined()
    expect(rows[1].stale).toBe('')
  })

  test("a folder a project set for itself can't be switched to and has no menu", () => {
    const pinned = acct({ id: undefined, account: '/p/pinned', label: 'c@x.com', active: false, usage: usage(5) })
    const row = panelRows([acct(), pinned], undefined, now)[1]
    expect(row.canSwitch).toBe(false)
    expect(row.menu).toBe(false)
  })

  test('the default account has no menu; an added one has, with Remove only when no session uses it', () => {
    const rows = panelRows([acct(), other({ sessions: 2 }), other({ id: 'a2', account: '/d/a2', label: 'c@x.com' })], undefined, now)
    expect(rows.map((r) => [r.menu, r.canRemove])).toEqual([[false, false], [true, false], [true, true]])
    expect(rows[1].removeWhy).toBe('Move or archive the 2 sessions using this account first.')
    expect(panelRows([acct(), other({ sessions: 1 })], undefined, now)[1].removeWhy).toBe('Move or archive the session using this account first.')
  })

  test("the selected session's account, when it isn't the active one, is marked; a pinned session says why", () => {
    const list = [acct(), other(), acct({ id: undefined, account: '/p/pinned', label: 'c@x.com', active: false })]
    expect(panelRows(list, { accountId: 'a1', account: '/d/a1' }, now).map((r) => r.note)).toEqual([undefined, 'This session', undefined])
    expect(panelRows(list, { accountId: 'default', account: '/h/.claude' }, now).map((r) => r.note)).toEqual([undefined, undefined, undefined])
    expect(panelRows(list, { accountPinned: true, account: '/p/pinned' }, now).map((r) => r.note))
      .toEqual([undefined, undefined, "Set by this session's project"])
  })
})

describe('Switch', () => {
  test('what the dialog asks', () => {
    expect(switchPrompt('b@x.com', { now: 3, later: 1 })).toEqual({
      title: 'Move 4 running sessions to b@x.com too?',
      body: '3 move now. 1 moves when it finishes.',
      warning: 'Moving restarts Claude in each session. Anything it was running in the background stops.'
    })
    expect(switchPrompt('b@x.com', { now: 1, later: 0 })).toMatchObject({ title: 'Move 1 running session to b@x.com too?', body: 'It moves now.' })
    expect(switchPrompt('b@x.com', { now: 0, later: 2 })).toMatchObject({ body: 'They move when they finish.' })
    expect(switchPrompt('b@x.com', { now: 2, later: 0 })).toMatchObject({ body: 'They move now.' })
    expect(switchPrompt('b@x.com', { now: 0, later: 1 })).toMatchObject({ body: 'It moves when it finishes.' })
  })

  const stub = (count: { now: number; later: number }) => {
    const calls: unknown[][] = []
    return {
      calls,
      api: {
        countMovable: async (id: string) => { calls.push(['count', id]); return count },
        setActiveAccount: async (id: string, move: boolean) => { calls.push(['setActive', id, move]); return { now: 0, later: 0 } }
      }
    }
  }

  test('with nothing to move, the account becomes active at once and no dialog opens', async () => {
    const { api, calls } = stub({ now: 0, later: 0 })
    const dialogs: unknown[] = []
    await switchAccount(api, { id: 'a1', label: 'b@x.com' }, (d) => dialogs.push(d))
    expect(calls).toEqual([['count', 'a1'], ['setActive', 'a1', false]])
    expect(dialogs).toEqual([])
  })

  test('with running sessions elsewhere, the dialog asks first and nothing changes yet', async () => {
    const { api, calls } = stub({ now: 3, later: 1 })
    const dialogs: unknown[] = []
    await switchAccount(api, { id: 'a1', label: 'b@x.com' }, (d) => dialogs.push(d))
    expect(calls).toEqual([['count', 'a1']])
    expect(dialogs).toEqual([{ type: 'switch-account', accountId: 'a1', label: 'b@x.com', now: 3, later: 1 }])
  })
})
