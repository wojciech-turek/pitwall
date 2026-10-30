import { useEffect, useState } from 'react'
import type { AppSnapshot, ChangedFile } from '@shared/types'
import { useUi } from '../state/ui'
import { cleanIpcError } from '../state/errors'
import { useDiskRefresh } from '../state/refresh'

const STATUS_COLOR: Record<ChangedFile['status'], string> = {
  M: 'var(--st-needs)', A: 'var(--st-unread)', '?': 'var(--st-unread)', D: 'var(--st-exited)'
}

export function LineCounts({ additions, deletions }: { additions: number; deletions: number }): React.JSX.Element | null {
  if (!additions && !deletions) return null
  return (
    <span className="line-counts">
      {additions > 0 && <span className="lc-add">+{additions}</span>}
      {deletions > 0 && <span className="lc-del">{'−'}{deletions}</span>}
    </span>
  )
}

export default function ChangesTab({ snap, sessionId }: { snap: AppSnapshot; sessionId: string }): React.JSX.Element {
  const tick = useDiskRefresh(snap, sessionId)
  const [data, setData] = useState<{ baseLabel: string; files: ChangedFile[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const openTab = useUi((s) => s.openTab)
  const activeId = useUi((s) => s.activeTab[sessionId])

  useEffect(() => { setData(null); setError(null) }, [sessionId])
  useEffect(() => {
    let live = true
    window.pitwall.listChanges(sessionId).then(
      (r) => { if (live) { setData(r); setError(null) } },
      (e) => { if (live) setError(cleanIpcError(e)) }
    )
    return () => { live = false }
  }, [sessionId, tick])

  if (error) return <div className="panel-hint" role="alert">{error}</div>
  if (!data) return <div className="panel-hint">Loading…</div>
  return (
    <div className="changes-tab" data-testid="changes-tab">
      <div className="panel-note" data-testid="changes-base">vs {data.baseLabel}</div>
      {data.files.length === 0 && <div className="panel-hint">No changes yet.</div>}
      {data.files.map((f) => {
        const i = f.path.lastIndexOf('/')
        const dir = i >= 0 ? f.path.slice(0, i + 1) : ''
        return (
          <div key={f.path} className={`ft-row change-row${activeId === `diff:${f.path}` ? ' active' : ''}`}
            data-testid={`change-${f.path}`} title={f.path}
            onClick={() => openTab(sessionId, { id: `diff:${f.path}`, kind: 'diff', path: f.path })}>
            <span className="ft-status" style={{ color: STATUS_COLOR[f.status] }}>{f.status}</span>
            <span className="ft-name"><span className="change-dir">{dir}</span>{f.path.slice(i + 1)}</span>
            <LineCounts additions={f.additions} deletions={f.deletions} />
          </div>
        )
      })}
    </div>
  )
}
