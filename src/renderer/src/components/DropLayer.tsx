import { useState } from 'react'
import type { Zone } from '../state/layout'
import { useUi } from '../state/ui'
import { SESSION_MIME, dropPreview, isSessionDrag, paneDropZone } from '../state/dropZone'

/**
 * Covers a pane (or the empty middle, when paneId is null) while a session is dragged from the sidebar,
 * and lights up where it would land.
 */
export default function DropLayer({ paneId, paneSessionId }: {
  paneId: string | null; paneSessionId?: string
}): React.JSX.Element {
  const [zone, setZone] = useState<Zone | null>(null)
  const dragging = useUi((s) => s.draggingSessionId)

  const zoneOf = (e: React.DragEvent<HTMLDivElement>, sessionId: string): Zone => {
    if (paneId === null) return 'center'
    const r = e.currentTarget.getBoundingClientRect()
    return paneDropZone(useUi.getState().layout, sessionId, paneId, e.clientX - r.left, e.clientY - r.top, r.width, r.height)
  }

  const onDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    const id = useUi.getState().draggingSessionId
    if (!id || !isSessionDrag(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setZone(zoneOf(e, id))
  }
  const onDragLeave = (e: React.DragEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setZone(null)
  }
  const onDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    if (!isSessionDrag(e.dataTransfer)) return
    e.preventDefault()
    const ui = useUi.getState()
    const id = e.dataTransfer.getData(SESSION_MIME) || ui.draggingSessionId
    setZone(null)
    ui.setDraggingSession(null)
    if (id) ui.dropSession(id, paneId, zoneOf(e, id))
  }

  const preview = zone && dropPreview(zone, paneId === null ? 'empty' : 'pane', zone === 'center' && paneSessionId === dragging)
  return (
    <div className="drop-layer" data-testid="drop-layer" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      {zone && preview && (
        <div className="drop-preview" data-testid="drop-preview" data-zone={zone} style={preview.inset}>
          <span className="drop-label">{preview.label}</span>
        </div>
      )}
    </div>
  )
}
