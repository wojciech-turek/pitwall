import type { SessionView, SubProject } from '@shared/types'
import { STATUS_LABEL } from '@shared/runtime'
import { useUi } from '../state/ui'
import { useToast } from '../state/toast'
import { cleanIpcError } from '../state/errors'
import PrBadge from './PrBadge'
import StatusDot from './StatusDot'

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

export default function SessionHeader({ session, subProject, multi = false, onClose }: {
  session: SessionView; subProject?: SubProject; multi?: boolean; onClose?: () => void
}): React.JSX.Element {
  const name = subProject?.name ?? ''
  const branch = session.liveBranch ?? session.branch
  const openDialog = useUi((u) => u.openDialog)
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
        <span className="header-status" data-testid="session-status">
          <span className="header-dot"><StatusDot status={session.status} /></span>
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
      {session.startWarning && <div className="banner warn" role="status" data-testid="start-warning">{session.startWarning}</div>}
      {session.launchWarnings?.map((w) => <div key={w} className="banner warn" role="status" data-testid="launch-warning">{w}</div>)}
      {session.lastError && <div className="banner error" role="alert" data-testid="last-error">{session.lastError}</div>}
    </div>
  )
}
