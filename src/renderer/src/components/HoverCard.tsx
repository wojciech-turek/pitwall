import { useEffect, useRef, useState } from 'react'
import { relativeTime } from '../state/time'
import { createPortal } from 'react-dom'
import { STATUS_LABEL } from '@shared/runtime'
import type { SessionView } from '@shared/types'
import { LineCounts } from './ChangesTab'
import StatusIcon from './StatusIcon'
import { useSessionUsageText } from '../state/system'

export const HOVER_DELAY_MS = 300
const CARD_WIDTH = 300

export { relativeTime }

/**
 * Hover state for a row: after a 300 ms delay `rect` is set; it clears on leave or any scroll.
 * Spread `bind` onto the row element.
 */
export function useHoverCard(disabled: boolean): {
  rect: DOMRect | null
  bind: { onMouseEnter(e: React.MouseEvent<HTMLElement>): void; onMouseLeave(): void }
} {
  const [rect, setRect] = useState<DOMRect | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hide = (): void => { clearTimeout(timer.current); setRect(null) }
  useEffect(() => {
    if (!rect) return
    window.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => { window.removeEventListener('scroll', hide, true); window.removeEventListener('blur', hide) }
  }, [rect])
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => { if (disabled) hide() }, [disabled])
  return {
    rect,
    bind: {
      onMouseEnter: (e) => {
        if (disabled) return
        const el = e.currentTarget
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setRect(el.getBoundingClientRect()), HOVER_DELAY_MS)
      },
      onMouseLeave: hide
    }
  }
}

export default function HoverCard({ session, rect, projectName, subProjectName, startedBy }: {
  session: SessionView; rect: DOMRect; projectName?: string; subProjectName?: string; startedBy?: string
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(rect.top)
  useEffect(() => {
    const h = ref.current?.offsetHeight ?? 0
    setTop(Math.max(8, Math.min(rect.top, window.innerHeight - h - 8)))
  }, [rect])
  const left = Math.min(rect.right + 8, window.innerWidth - CARD_WIDTH - 8)
  const usage = useSessionUsageText(session.id)
  const branch = session.liveBranch ?? session.branch
  return createPortal(
    <div ref={ref} className="hover-card" data-testid="hover-card" role="tooltip" style={{ left, top, width: CARD_WIDTH }}>
      <div className="hc-title">{session.title}</div>
      <div className="hc-meta">
        <StatusIcon status={session.status} exitCode={session.exitCode} />
        <span className="hc-status">{STATUS_LABEL[session.status]}</span>
        <span className="hc-sep">·</span>
        <span className="hc-time">{relativeTime(session.lastActivityAt ?? session.createdAt)}</span>
      </div>
      <div className="hc-line">{[projectName, subProjectName].filter(Boolean).join(' · ')}</div>
      {startedBy && <div className="hc-line" data-testid="hc-started-by">Started by {startedBy}</div>}
      {branch && <div className="hc-line hc-branch">{branch}</div>}
      {usage && <div className="hc-line hc-usage" data-testid="hc-usage">{usage}</div>}
      {session.lastMessage && <div className="hc-message">{session.lastMessage}</div>}
      {(session.diffStat || session.pr) && (
        <div className="hc-foot">
          {session.diffStat && <LineCounts additions={session.diffStat.additions} deletions={session.diffStat.deletions} />}
          {session.pr && <span className="hc-pr">#{session.pr.number}</span>}
        </div>
      )}
    </div>,
    document.body
  )
}
