import { useEffect, useRef, useState } from 'react'
import { useUi } from '../state/ui'
import { formatBytes } from '../state/strays'
import { formatProc, pillLabel, pillLevel, topSessions, useSystemHistory } from '../state/system'
import type { SessionView } from '@shared/types'

/** Shown only while memory pressure is high or the disk is nearly full; the popover says which sessions are biggest. */
export default function SystemPill({ sessions }: { sessions: SessionView[] }): React.JSX.Element | null {
  const history = useSystemHistory()
  const level = pillLevel(history)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const select = useUi((s) => s.select)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent): void => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key) }
  }, [open])
  const last = history[history.length - 1]
  if (!level || !last) return null
  const title = (id: string): string => sessions.find((s) => s.id === id)?.title ?? 'Session'
  return (
    <span className="system-pill-wrap" ref={ref}>
      <button type="button" className={`system-pill ${level}`} data-testid="system-pill" aria-expanded={open}
        onClick={() => setOpen((o) => !o)}>
        {pillLabel(last, level)}
      </button>
      {open && (
        <div className="system-pop" data-testid="system-pop">
          <div className="sp-head">Biggest sessions</div>
          {topSessions(last, 5).map(({ id, stats }) => (
            <button key={id} type="button" className="sp-row" data-testid="system-pop-session"
              onClick={() => { select(id); setOpen(false) }}>
              <span className="sp-title">{title(id)}</span>
              <span className="sp-usage">{formatProc(stats)}</span>
            </button>
          ))}
          <div className="sp-head">Pitwall itself</div>
          <div className="sp-line">{formatProc(last.pitwall)}</div>
          <div className="sp-line">Swap used {formatBytes(last.swapUsedBytes)}</div>
          <div className="sp-line">Disk free {formatBytes(last.diskFreeBytes)}</div>
        </div>
      )}
    </span>
  )
}
