import { useEffect, useState } from 'react'
import type { AppSnapshot, HistoryHit, Session } from '@shared/types'
import { useUi } from '../state/ui'

const SEARCH_DELAY_MS = 150

export default function ArchivedList({ snap }: { snap: AppSnapshot }): React.JSX.Element | null {
  const open = useUi((s) => s.archivedOpen)
  const setOpen = useUi((s) => s.setArchivedOpen)
  const [query, setQuery] = useState('')
  // The latest search results (titles and Claude conversations); null until the first answer.
  const [hits, setHits] = useState<HistoryHit[] | null>(null)
  const openDialog = useUi((s) => s.openDialog)
  const q = query.trim()
  const archivedCount = snap.archived.length

  // Opening the list starts reading transcripts in the background, so the first search is quick.
  useEffect(() => {
    if (open) void window.pitwall.searchSessions('').catch(() => {})
  }, [open])

  useEffect(() => {
    if (!q) {
      setHits(null)
      return
    }
    let live = true
    const timer = setTimeout(() => {
      window.pitwall.searchSessions(q)
        .then((h) => { if (live) setHits(h) })
        .catch(() => { if (live) setHits([]) })
    }, SEARCH_DELAY_MS)
    return () => { live = false; clearTimeout(timer) }
  }, [q, archivedCount])

  if (archivedCount === 0) return null
  const byId = new Map(snap.archived.map((s) => [s.id, s]))
  let rows: { s: Session; snippet?: string }[]
  if (!q) {
    rows = [...snap.archived].sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)).map((s) => ({ s }))
  } else if (hits) {
    rows = hits.flatMap((h) => {
      const s = h.archived ? byId.get(h.sessionId) : undefined
      return s ? [{ s, snippet: h.matchedIn === 'conversation' ? h.snippet : undefined }] : []
    })
  } else {
    // Until the first answer arrives: titles only.
    const terms = q.toLowerCase().split(/\s+/)
    rows = snap.archived.filter((s) => terms.every((t) => s.title.toLowerCase().includes(t))).map((s) => ({ s }))
  }

  return (
    <div className="archived" data-testid="archived-list">
      <button className="archived-toggle" data-testid="archived-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} Archived ({archivedCount})
      </button>
      {open && (
        <>
          <input data-testid="archived-search" placeholder="Search titles and conversations" value={query}
            onChange={(e) => setQuery(e.target.value)} />
          <div className="archived-rows">
            {rows.map(({ s, snippet }) => (
              <div key={s.id} className="archived-row" data-testid="archived-row" data-session-id={s.id} title={s.title}>
                <div className="archived-head">
                  <div className="archived-title">{s.title}</div>
                  <button className="btn small archived-resume" data-testid="resume-session"
                    title="Bring it back and continue the conversation"
                    onClick={() => openDialog({ type: 'resume', sessionId: s.id })}>Resume</button>
                </div>
                {snippet && <div className="archived-snippet" data-testid="archived-snippet">{snippet}</div>}
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
