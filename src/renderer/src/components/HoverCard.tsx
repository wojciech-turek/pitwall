import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { STATUS_LABEL } from '@shared/runtime'
import type { SessionView } from '@shared/types'
import { LineCounts } from './ChangesTab'
import StatusDot from './StatusDot'

export const HOVER_DELAY_MS = 300
const CARD_WIDTH = 300

export function relativeTime(then: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - then) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

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

export default function HoverCard({ session, rect, projectName, subProjectName }: {
  session: SessionView; rect: DOMRect; projectName?: string; subProjectName?: string
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(rect.top)
  useEffect(() => {
    const h = ref.current?.offsetHeight ?? 0
    setTop(Math.max(8, Math.min(rect.top, window.innerHeight - h - 8)))
  }, [rect])
  const left = Math.min(rect.right + 8, window.innerWidth - CARD_WIDTH - 8)
  const branch = session.liveBranch ?? session.branch
  return createPortal(
    <div ref={ref} className="hover-card" data-testid="hover-card" role="tooltip" style={{ left, top, width: CARD_WIDTH }}>
      <div className="hc-title">{session.title}</div>
      <div className="hc-meta">
        <span className="header-dot"><StatusDot status={session.status} /></span>
        <span className="hc-status">{STATUS_LABEL[session.status]}</span>
        <span className="hc-sep">·</span>
        <span className="hc-time">{relativeTime(session.lastActivityAt ?? session.createdAt)}</span>
      </div>
      <div className="hc-line">{[projectName, subProjectName].filter(Boolean).join(' · ')}</div>
      {branch && <div className="hc-line hc-branch">{branch}</div>}
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
