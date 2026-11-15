import { useEffect, useState } from 'react'
import type { UsageWindow } from '@shared/types'
import Menu, { type MenuItem } from './Menu'
import { panelMode, panelRows, switchAccount, useAccounts, type AccountRow } from '../state/accounts'
import { cleanIpcError } from '../state/errors'
import { useSnapStore } from '../state/snapshot'
import { useToast } from '../state/toast'
import { useUi } from '../state/ui'
import { relativeTime } from '../state/time'
import { usageRow } from '../state/usage'

function Row({ label, name, testId, window: w, now }: {
  label: string; name: string; testId: string; window: UsageWindow | undefined; now: number
}): React.JSX.Element {
  const r = usageRow(w, now)
  return (
    <div className="usage-row" data-testid={testId} data-level={r.level}>
      <span className="usage-label">{label}</span>
      <span className="usage-bar" role="meter" aria-label={`${name} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={r.percent}>
        <span className="usage-fill" style={{ width: `${r.percent}%` }} />
      </span>
      <span className="usage-pct">{r.pct}</span>
      <span className="usage-reset">{r.reset}</span>
    </div>
  )
}

const report = (e: unknown): void => useToast.getState().show(cleanIpcError(e))

/** Starts adding an account: a folder for it, then the dialog whose terminal signs in there. */
function addAccount(): void {
  void window.pitwall.beginAddAccount()
    .then(({ addId, termId }) => useUi.getState().openDialog({ type: 'account-login', termId, addId }), report)
}

function menuFor(row: AccountRow, i: number): MenuItem[] {
  const id = row.id!
  const items: MenuItem[] = [
    { label: 'Sign in again', testId: `account-signin-${i}`, onClick: () => useUi.getState().openDialog({ type: 'account-login', termId: `login-${id}`, accountId: id, label: row.label }) },
    { label: 'Copy settings from Default', testId: `account-copy-${i}`, onClick: () => { void window.pitwall.copyAccountSettings(id).then(() => useToast.getState().show(`Copied to ${row.label}.`), report) } }
  ]
  // Remove is always listed; while sessions use the account it says why it can't, rather than doing it.
  items.push({
    label: 'Remove', danger: true, testId: `account-remove-${i}`,
    onClick: () => {
      if (!row.canRemove) { useToast.getState().show(row.removeWhy ?? ''); return }
      void window.pitwall.removeAccount(id).catch(report)
    }
  })
  return items
}

/**
 * Claude accounts and their subscription usage (5-hour and weekly windows, from the status line of Pitwall's
 * sessions), at the bottom of the right panel. The active account (the one new sessions start on) comes first;
 * Switch on another makes it the active one and offers to move the running sessions too.
 */
export default function AccountsPanel(): React.JSX.Element {
  const accounts = useAccounts()
  // Re-render each minute: reset times pass and "updated … ago" ages without new data.
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])
  const selectedId = useUi((s) => s.selectedSessionId)
  const selected = useSnapStore((s) => s.snap?.sessions.find((x) => x.id === selectedId))
  const openDialog = useUi((s) => s.openDialog)
  const [busy, setBusy] = useState(false)
  const now = Date.now()
  const mode = panelMode(accounts)
  const reported = accounts.flatMap((a) => (a.usage ? [a.usage.updatedAt] : []))
  const title = reported.length ? `Claude usage · updated ${relativeTime(Math.max(...reported), now)}` : 'Claude usage'
  const add = (
    <button className="account-add" data-testid="account-add" onClick={addAccount}>+ Add account…</button>
  )

  if (mode !== 'multi') {
    const u = accounts[0]?.usage
    return (
      <div className="usage-meter" data-testid="usage-meter" title={title}>
        {u ? (
          <>
            <Row label="5h" name="5-hour" testId="usage-5h" window={u.fiveHour} now={now} />
            <Row label="Week" name="Weekly" testId="usage-week" window={u.sevenDay} now={now} />
          </>
        ) : <div className="usage-empty">Usage shows after Claude's next reply</div>}
        {add}
      </div>
    )
  }

  const doSwitch = (row: AccountRow): void => {
    setBusy(true)
    void switchAccount(window.pitwall, { id: row.id!, label: row.label }, openDialog).catch(report).finally(() => setBusy(false))
  }
  return (
    <div className="usage-meter" data-testid="usage-meter" title={title}>
      {panelRows(accounts, selected, now).map((row, i) => (
        <div key={row.account} className={row.active ? 'usage-account' : 'usage-account other'} data-active={row.active}>
          <div className="usage-account-head">
            <span className={row.active ? 'account-dot on' : 'account-dot'} aria-hidden="true" />
            <span className="usage-account-label" data-testid="usage-account" title={row.active ? `${row.label} · new sessions start here` : row.label}>{row.label}</span>
            {row.note && <span className="account-note" data-testid={`account-note-${i}`}>{row.note}</span>}
            {row.canSwitch && (
              <button className="btn small" data-testid={`account-switch-${i}`} disabled={busy} onClick={() => doSwitch(row)}>Switch</button>
            )}
            {row.menu && <Menu items={menuFor(row, i)} testId={`account-menu-${i}`} label={`${row.label}: more actions`} />}
          </div>
          {row.usage ? (
            <>
              <Row label="5h" name="5-hour" testId={i === 0 ? 'usage-5h' : `usage-5h-${i}`} window={row.usage.fiveHour} now={now} />
              <Row label="Week" name="Weekly" testId={i === 0 ? 'usage-week' : `usage-week-${i}`} window={row.usage.sevenDay} now={now} />
              {row.stale && <div className="account-stale">{row.stale}</div>}
            </>
          ) : <div className="usage-empty" data-testid={`account-nousage-${i}`}>No usage yet</div>}
        </div>
      ))}
      {add}
    </div>
  )
}
