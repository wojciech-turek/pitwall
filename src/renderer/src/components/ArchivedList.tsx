import { useState } from 'react'
import type { AppSnapshot } from '@shared/types'

export default function ArchivedList({ snap }: { snap: AppSnapshot }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  if (snap.archived.length === 0) return null
  const q = query.trim().toLowerCase()
  const rows = snap.archived
    .filter((s) => !q || s.title.toLowerCase().includes(q))
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
  return (
    <div className="archived" data-testid="archived-list">
      <button className="archived-toggle" data-testid="archived-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} Archived ({snap.archived.length})
      </button>
      {open && (
        <>
          <input data-testid="archived-search" placeholder="Search archived" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="archived-rows">
            {rows.map((s) => (
              <div key={s.id} className="archived-row" data-testid="archived-row" title={s.title}>
                <div className="archived-title">{s.title}</div>
                <div className="archived-meta">
                  <span>{snap.subProjects.find((p) => p.id === s.subProjectId)?.name ?? ''}</span>
                  <span>{s.archivedAt ? new Date(s.archivedAt).toLocaleDateString() : ''}</span>
                  {s.pr && (
                    <button className="pr-badge" data-testid="archived-pr" title={`PR #${s.pr.number}`}
                      onClick={() => void window.pitwall.openExternal(s.pr!.url)}>#{s.pr.number}</button>
                  )}
                </div>
              </div>
            ))}
            {rows.length === 0 && <div className="archived-row">No matches</div>}
          </div>
        </>
      )}
    </div>
  )
}
