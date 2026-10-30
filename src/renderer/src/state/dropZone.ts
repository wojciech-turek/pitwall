// Dragging a session from the sidebar onto the panes: what a drop there would do, and how the preview looks.
import { effectiveZone, zoneAt, type Layout, type Zone } from './layout'

/** dataTransfer type of a session dragged from the sidebar; its data is the session id. */
export const SESSION_MIME = 'application/x-pitwall-session'

export function isSessionDrag(dt: { readonly types: ArrayLike<string> } | null): boolean {
  return !!dt && Array.from(dt.types).includes(SESSION_MIME)
}

/** Where a session dropped at (x, y) inside a pane of size w×h lands. */
export function paneDropZone(l: Layout, sessionId: string, paneId: string, x: number, y: number, w: number, h: number): Zone {
  return effectiveZone(l, sessionId, paneId, zoneAt(x, y, w, h))
}

export interface DropPreview {
  label: string
  /** Position inside the pane (CSS top/right/bottom/left). */
  inset: { top: string; right: string; bottom: string; left: string }
}

const LABEL: Record<Zone, string> = {
  left: 'Split left', right: 'Split right', top: 'Split up', bottom: 'Split down', center: 'Replace'
}

/** Edges light up the half the session will take; center lights up the whole pane (or the empty middle). */
export function dropPreview(zone: Zone, target: 'pane' | 'empty', alreadyHere: boolean): DropPreview {
  const inset = {
    top: zone === 'bottom' ? '50%' : '0',
    right: zone === 'left' ? '50%' : '0',
    bottom: zone === 'top' ? '50%' : '0',
    left: zone === 'right' ? '50%' : '0'
  }
  const label = target === 'empty' ? 'Open here' : alreadyHere ? 'Already here' : LABEL[zone]
  return { label, inset }
}
