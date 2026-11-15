import { useState } from 'react'
import type { SessionView, SubProject } from '@shared/types'
import { STATUS_LABEL } from '@shared/runtime'
import { resetTimeFor } from '@shared/reset-time'
import { useUi } from '../state/ui'
import { useToast } from '../state/toast'
import { cleanIpcError } from '../state/errors'
import { requestFocus } from '../terminal/termCache'
import { useUsage } from '../state/usage'
import { bestOther, moveNotice, moveTargets, switchAccount, useAccounts } from '../state/accounts'
import Menu from './Menu'
import PrBadge from './PrBadge'
import StatusIcon from './StatusIcon'

/** Opens the session's folder in Cursor; says why in a toast when it can't. */
export async function openInCursor(sessionId: string): Promise<void> {
  const toast = useToast.getState().show
  try {
    const r = await window.pitwall.openInCursor(sessionId)
    if (!r.ok) toast(r.message ?? "Cursor isn't installed.")
  } catch (e) {
    toast(cleanIpcError(e))
  }
}

/** Pastes the PR's failing checks or review comments into the agent's prompt, then shows it. */
async function sendPrFeedback(sessionId: string, what: 'checks' | 'reviews'): Promise<void> {
  const toast = useToast.getState().show
  try {
    const r = await window.pitwall.sendPrFeedback(sessionId, what)
    if (!r.ok) { toast(r.message); return }
    useUi.getState().setActiveTab(sessionId, 'claude')
    requestFocus(sessionId, 'claude')
  } catch (e) {
    toast(cleanIpcError(e))
  }
}

function PrFeedbackBanner({ testId, text, sessionId, what }: {
  testId: string; text: string; sessionId: string; what: 'checks' | 'reviews'
}): React.JSX.Element {
  const [sending, setSending] = useState(false)
  return (
    <div className="banner warn" role="status" data-testid={`${testId}-banner`}>
      <span>{text}</span>
      <button className="btn" data-testid={`${testId}-send`} disabled={sending}
        onClick={() => { setSending(true); void sendPrFeedback(sessionId, what).finally(() => setSending(false)) }}>Send to agent</button>
    </div>
  )
}

const shortTime = (at: number): string => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** A session Claude stopped at a usage limit: offers to type "continue" when the limit resets. */
function LimitBanner({ session }: { session: SessionView }): React.JSX.Element {
  const usage = useUsage()
  const accounts = useAccounts()
  const openDialog = useUi((u) => u.openDialog)
  // Another account to carry on with: the one with the most room. Not for a session whose project sets its own.
  const elsewhere = session.accountPinned || session.moveTo !== undefined ? undefined : bestOther(accounts, session.accountId, Date.now())
  const [busy, setBusy] = useState(false)
  const run = (fn: () => Promise<unknown>): void => {
    setBusy(true)
    void fn().catch((e) => useToast.getState().show(cleanIpcError(e))).finally(() => setBusy(false))
  }
  return (
    <div className="banner warn" role="status" data-testid="limit-banner">
      {session.continueAt !== undefined ? (
        <>
          <span>Will type "continue" at {shortTime(session.continueAt)}.</span>
          <button className="btn" data-testid="continue-cancel" disabled={busy}
            onClick={() => run(() => window.pitwall.cancelContinue(session.id))}>Cancel</button>
        </>
      ) : (
        <>
          <span>Claude stopped at a limit.</span>
          <button className="btn" data-testid="continue-at" disabled={busy}
            onClick={() => run(() => window.pitwall.scheduleContinue(session.id))}>
            Continue at {shortTime(resetTimeFor(usage.find((a) => a.account === session.account)?.usage, Date.now()))}
          </button>
          {elsewhere?.id !== undefined && (
            <button className="btn" data-testid="limit-switch" disabled={busy}
              onClick={() => run(() => switchAccount(window.pitwall, { id: elsewhere.id!, label: elsewhere.label }, openDialog))}>
              Switch to {elsewhere.label}
            </button>
          )}
        </>
      )}
    </div>
  )
}

/** A move to another account that is waiting to happen, or was made and hasn't started there yet. */
function MoveBanner({ session }: { session: SessionView }): React.JSX.Element | null {
  const accounts = useAccounts()
  const [busy, setBusy] = useState(false)
  const notice = moveNotice(session, accounts)
  if (!notice) return null
  const run = (fn: () => Promise<unknown>): void => {
    setBusy(true)
    void fn().catch((e) => useToast.getState().show(cleanIpcError(e))).finally(() => setBusy(false))
  }
  return (
    <div className="banner warn" role="status" data-testid={notice.kind === 'waiting' ? 'move-waiting' : 'move-pending'}>
      <span>{notice.text}</span>
      {notice.kind === 'waiting'
        ? <button className="btn" data-testid="move-back" disabled={busy} onClick={() => run(() => window.pitwall.moveBack(session.id))}>Move back</button>
        : <button className="btn" data-testid="move-cancel" disabled={busy} onClick={() => run(() => window.pitwall.cancelMove(session.id))}>Cancel</button>}
    </div>
  )
}

export default function SessionHeader({ session, subProject, multi = false, onClose }: {
  session: SessionView; subProject?: SubProject; multi?: boolean; onClose?: () => void
}): React.JSX.Element {
  const name = subProject?.name ?? ''
  const branch = session.liveBranch ?? session.branch
  const openDialog = useUi((u) => u.openDialog)
  const targets = moveTargets(useAccounts(), session)
  return (
    <div className="session-header">
      <div className="session-header-row">
        {multi && <span className="header-title" data-testid="pane-title" title={session.title}>{session.title}</span>}
        <span className="header-path" data-testid="session-header-path">
          {name}{' · '}
          {branch
            ? <>{branch}{session.baseBranch && <> <span className="header-sep">›</span> <span className="header-base">{session.baseBranch}</span></>}</>
            : <span className="header-base">no git</span>}
        </span>
        {session.pr && <PrBadge pr={session.pr} />}
        <button className="btn small header-open" data-testid="open-in-cursor" onClick={() => void openInCursor(session.id)}>Open in Cursor</button>
        {targets.length > 0 && (
          <Menu testId="move-menu" label="Move to another Claude account" items={targets.map((a) => ({
            label: `Move to ${a.label}`, testId: `move-to-${a.id}`,
            onClick: () => { void window.pitwall.moveSession(session.id, a.id!).catch((e) => useToast.getState().show(cleanIpcError(e))) }
          }))} />
        )}
        <span className="header-status" data-testid="session-status">
          <StatusIcon status={session.status} exitCode={session.exitCode} />
          <span className="header-status-label">{STATUS_LABEL[session.status]}</span>
        </span>
        {multi && (
          <button className="icon-btn pane-close" aria-label="Close pane" title="Close pane" data-testid="close-pane"
            onClick={onClose}>×</button>
        )}
      </div>
      {session.pr?.state === 'MERGED' && (
        <div className="banner pr-merged" role="status" data-testid="pr-merged-banner">
          <span>PR #{session.pr.number} was merged. Archive this session?</span>
          <button className="btn" data-testid="pr-archive" onClick={() => openDialog({ type: 'archive', sessionId: session.id })}>Archive…</button>
        </div>
      )}
      {session.pr?.state === 'OPEN' && session.pr.checks === 'failing' && !!session.pr.failing?.length && (
        <PrFeedbackBanner testId="pr-checks" sessionId={session.id} what="checks"
          text={`Checks failing on PR #${session.pr.number}: ${session.pr.failing.map((f) => f.name).join(', ')}`} />
      )}
      {session.pr?.state === 'OPEN' && (session.pr.openThreads ?? 0) > 0 && (
        <PrFeedbackBanner testId="pr-reviews" sessionId={session.id} what="reviews"
          text={`${session.pr.openThreads} unresolved review comment${session.pr.openThreads === 1 ? '' : 's'} on PR #${session.pr.number}`} />
      )}
      {session.limitHit && <LimitBanner session={session} />}
      <MoveBanner session={session} />
      {session.startWarning && <div className="banner warn" role="status" data-testid="start-warning">{session.startWarning}</div>}
      {session.launchWarnings?.map((w) => <div key={w} className="banner warn" role="status" data-testid="launch-warning">{w}</div>)}
      {session.lastError && <div className="banner error" role="alert" data-testid="last-error">{session.lastError}</div>}
    </div>
  )
}
