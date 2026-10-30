import type { SessionView } from '@shared/types'
import { countStatuses } from '@shared/runtime'
import { useAppInfo } from '../state/appInfo'
import { useUi } from '../state/ui'
import { useUpdates } from '../state/updates'

export default function TitleBar({ sessions }: { sessions: SessionView[] }): React.JSX.Element {
  const c = countStatuses(sessions)
  const info = useAppInfo()
  const latest = useUpdates()?.newer[0]
  const openDialog = useUi((s) => s.openDialog)
  const items: { key: string; n: number; label: string; color: string }[] = [
    { key: 'needs', n: c.needsYou, label: 'needs you', color: 'var(--st-needs)' },
    { key: 'unread', n: c.unread, label: 'unread', color: 'var(--st-unread)' },
    { key: 'working', n: c.working, label: 'working', color: 'var(--st-working)' }
  ]
  return (
    <div className="titlebar">
      <span className="titlebar-name" data-testid="titlebar-name">{info?.dev ? 'Pitwall Dev' : 'Pitwall'}</span>
      <div className="titlebar-right">
        <div className="titlebar-counts" data-testid="titlebar-counts"
          data-needs={c.needsYou} data-unread={c.unread} data-working={c.working}>
          {items.map((i) => (
            <span key={i.key} className={`count${i.n === 0 ? ' zero' : ''}`} data-count={i.key}>
              <span className="count-dot" style={{ background: i.color }} />
              {i.n} {i.label}
            </span>
          ))}
        </div>
        {latest && (
          <button type="button" className="update-pill" data-testid="update-pill" title="See what's new"
            onClick={() => openDialog({ type: 'update' })}>
            Update available · {latest.version}
          </button>
        )}
      </div>
    </div>
  )
}
