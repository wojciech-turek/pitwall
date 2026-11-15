import { describe, expect, test } from 'vitest'
import { __accountsStore, __pushAccounts } from '../../src/renderer/src/state/accounts'
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
