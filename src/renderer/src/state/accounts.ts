import { useEffect } from 'react'
import { create } from 'zustand'
import type { PitwallApi } from '@shared/api'
import type { AccountView, ClaudeUsage, SessionView } from '@shared/types'
import { relativeTime } from './time'
import type { DialogState } from './ui'

const useAccountsStore = create<{ accounts: AccountView[] }>()(() => ({ accounts: [] }))
let started = false
let pushed = false // a push is newer than the initial fetch
const api = (): PitwallApi => (globalThis as unknown as { pitwall: PitwallApi }).pitwall

export function __pushAccounts(accounts: AccountView[]): void {
  pushed = true
  useAccountsStore.setState({ accounts })
}
export const __accountsStore = useAccountsStore

function start(): void {
  if (started) return
  started = true
  api().onAccounts(__pushAccounts)
  void api().getAccounts().then((accounts) => {
    if (!pushed) useAccountsStore.setState({ accounts })
  })
}

/** Every Claude account (the active one first); one IPC subscription for the whole renderer. */
export function useAccounts(): AccountView[] {
  useEffect(start, [])
  return useAccountsStore((s) => s.accounts)
}

// ---- the panel beside the usage meters ---------------------------------------------------

const STALE_AFTER = 10 * 60_000

/** An account reports only while a session runs on it: numbers older than 10 minutes say how old they are. */
export function staleNote(updatedAt: number, now: number): string {
  return now - updatedAt < STALE_AFTER ? '' : `updated ${relativeTime(updatedAt, now)}`
}

/**
 * 'empty': one account that has reported nothing yet. 'single': one account, shown as two bare rows (as before
 * accounts could be added). 'multi': a block per account, with the switch.
 */
export function panelMode(accounts: AccountView[]): 'empty' | 'single' | 'multi' {
  if (accounts.length > 1) return 'multi'
  return accounts[0]?.usage ? 'single' : 'empty'
}

export interface AccountRow {
  account: string; id?: string; label: string; active: boolean; usage?: ClaudeUsage
  /** "updated 3h ago", or '' when the numbers are fresh (or there are none). */
  stale: string
  /** Another account that can be made the active one. */
  canSwitch: boolean
  /** Has the ⋯ menu: an account added in Pitwall (never the default one, never a folder a project set). */
  menu: boolean
  canRemove: boolean
  /** Why Remove is off. */
  removeWhy?: string
  /** How the selected session relates to this row, when that isn't simply "it runs on the active account". */
  note?: string
}

/** One row per account, in the order given (the active one first). `selected` is the session shown, if any. */
export function panelRows(
  accounts: AccountView[], selected: Pick<SessionView, 'account' | 'accountId' | 'accountPinned'> | undefined, now: number
): AccountRow[] {
  return accounts.map((a) => {
    const added = a.id !== undefined && a.id !== 'default'
    const row: AccountRow = {
      account: a.account, label: a.label, active: a.active, stale: a.usage ? staleNote(a.usage.updatedAt, now) : '',
      canSwitch: a.id !== undefined && !a.active, menu: added, canRemove: added && a.sessions === 0
    }
    if (a.id !== undefined) row.id = a.id
    if (a.usage) row.usage = a.usage
    if (added && a.sessions > 0) {
      row.removeWhy = `Move or archive the ${a.sessions === 1 ? 'session' : `${a.sessions} sessions`} using this account first.`
    }
    if (selected?.accountPinned && selected.account === a.account) row.note = "Set by this session's project"
    else if (selected?.accountId !== undefined && selected.accountId === a.id && !a.active) row.note = 'This session'
    return row
  })
}

/** What the dialog after Switch asks, when sessions are running on another account. */
export function switchPrompt(label: string, n: { now: number; later: number }): { title: string; body: string; warning: string } {
  const total = n.now + n.later
  const one = total === 1
  let body: string
  if (n.later === 0) body = one ? 'It moves now.' : 'They move now.'
  else if (n.now === 0) body = one ? 'It moves when it finishes.' : 'They move when they finish.'
  else body = `${n.now} ${n.now === 1 ? 'moves' : 'move'} now. ${n.later} ${n.later === 1 ? 'moves when it finishes' : 'move when they finish'}.`
  return {
    title: `Move ${total} running ${one ? 'session' : 'sessions'} to ${label} too?`,
    body,
    warning: 'Moving restarts Claude in each session. Anything it was running in the background stops.'
  }
}

/**
 * Switch on an account's row (and in the limit banner): with no running session elsewhere, it becomes the active
 * account at once; otherwise the dialog asks whether to move them too, and nothing changes until it is answered.
 */
export async function switchAccount(
  pitwall: Pick<PitwallApi, 'countMovable' | 'setActiveAccount'>, to: { id: string; label: string }, openDialog: (d: DialogState) => void
): Promise<void> {
  const n = await pitwall.countMovable(to.id)
  if (n.now + n.later === 0) {
    await pitwall.setActiveAccount(to.id, false)
    return
  }
  openDialog({ type: 'switch-account', accountId: to.id, label: to.label, now: n.now, later: n.later })
}
