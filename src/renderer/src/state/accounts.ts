import { useEffect } from 'react'
import { create } from 'zustand'
import type { PitwallApi } from '@shared/api'
import type { AccountView } from '@shared/types'

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
