import { useEffect, useRef, useState } from 'react'
import type { SessionView } from '@shared/types'
import { LineCounts } from './ChangesTab'
import PrBadge from './PrBadge'
import StatusIcon from './StatusIcon'
import Menu from './Menu'
import HoverCard, { useHoverCard } from './HoverCard'
import { useUi } from '../state/ui'
import { SESSION_MIME } from '../state/dropZone'
import { rowFaded, rowLineCounts } from '../state/badges'

/** The chip under the cursor while a row is dragged (drawn behind the app; the drag image is taken from it). */
function setGhost(e: React.DragEvent<HTMLElement>, session: SessionView): void {
  const r = e.currentTarget.getBoundingClientRect()
  const ghost = document.createElement('div')
  ghost.className = 'drag-ghost'
  ghost.style.left = `${r.left}px`
  ghost.style.top = `${r.top}px`
  const icon = e.currentTarget.querySelector('.status-icon')?.cloneNode(true)
  const title = document.createElement('span')
  title.className = 'drag-ghost-title'
  title.textContent = session.title
  if (icon) ghost.append(icon)
  ghost.append(title)
  document.body.appendChild(ghost)
  const x = Math.min(Math.max(e.clientX - r.left, 0), ghost.offsetWidth)
  e.dataTransfer.setDragImage(ghost, x, Math.max(e.clientY - r.top, 0))
  setTimeout(() => ghost.remove(), 0)
}

export default function SessionRow({ session, onSelect, projectName, subProjectName }: {
  session: SessionView; onSelect: (id: string) => void; projectName?: string; subProjectName?: string
}): React.JSX.Element {
  const selected = useUi((s) => s.selectedSessionId === session.id)
  const visible = useUi((s) => s.visibleSessionIds.includes(session.id))
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.title)
  const input = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  const openDialog = useUi((s) => s.openDialog)
  const dragging = useUi((s) => s.draggingSessionId === session.id)
  const setDraggingSession = useUi((s) => s.setDraggingSession)
  const paletteOpen = useUi((s) => s.palette !== null)
  const hover = useHoverCard(editing || dragging || paletteOpen)

  useEffect(() => {
    if (editing) { done.current = false; input.current?.select() }
  }, [editing])

  const commit = (): void => {
    if (done.current) return
    done.current = true
    setEditing(false)
    const t = draft.trim()
    if (t && t !== session.title) void window.pitwall.renameSession(session.id, t)
  }
  const cancel = (): void => {
    done.current = true
    setEditing(false)
  }

  const counts = rowLineCounts(session)
  return (
    <div className={`row session-row${selected ? ' selected' : visible ? ' visible' : ''}${dragging ? ' dragging' : ''}${rowFaded(session) ? ' faded' : ''}`}
      data-testid="session-row" data-status={session.status} data-session-id={session.id} {...hover.bind}
      draggable={!editing}
      onDragStart={(e) => {
        e.dataTransfer.setData(SESSION_MIME, session.id)
        e.dataTransfer.effectAllowed = 'move'
        setGhost(e, session)
        setDraggingSession(session.id)
      }}
      onDragEnd={() => setDraggingSession(null)}
      onClick={() => onSelect(session.id)}
      onDoubleClick={() => { setDraft(session.title); setEditing(true) }}>
      <StatusIcon status={session.status} exitCode={session.exitCode} />
      {editing ? (
        <input ref={input} className="rename-input" data-testid="rename-input" value={draft} autoFocus
          onChange={(e) => setDraft(e.target.value)} onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            else if (e.key === 'Escape') { e.stopPropagation(); cancel() }
          }}
          onBlur={commit} />
      ) : (
        <span className="row-title">{session.title}</span>
      )}
      {!editing && session.pr && <PrBadge pr={session.pr} />}
      {!editing && counts && <LineCounts additions={counts.additions} deletions={counts.deletions} />}
      {!editing && (
        <span className="row-actions">
          <Menu testId="session-menu" items={[
            ...(session.status === 'read'
              ? [{ label: 'Mark as unread', testId: 'session-mark-unread', onClick: () => void window.pitwall.markSessionUnread(session.id) }]
              : []),
            { label: 'Archive…', testId: 'session-archive', onClick: () => openDialog({ type: 'archive', sessionId: session.id }) }
          ]} />
        </span>
      )}
      {hover.rect && <HoverCard session={session} rect={hover.rect} projectName={projectName} subProjectName={subProjectName} />}
    </div>
  )
}
