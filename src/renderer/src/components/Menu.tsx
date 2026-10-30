import { useEffect, useRef, useState } from 'react'
import { DotsIcon } from './Icons'

export interface MenuItem { label: string; onClick: () => void; danger?: boolean; testId?: string }

export default function Menu({ items, testId, label = 'More actions' }: { items: MenuItem[]; testId?: string; label?: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
    }
  }, [open])
  return (
    <span className={`menu${open ? ' open' : ''}`} ref={ref}>
      <button className="icon-btn" data-testid={testId} title={label} aria-label={label} aria-haspopup="menu" aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}>
        <DotsIcon />
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {items.map((it) => (
            <button key={it.label} role="menuitem" data-testid={it.testId} className={it.danger ? 'danger' : undefined}
              onClick={(e) => { e.stopPropagation(); setOpen(false); it.onClick() }}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
