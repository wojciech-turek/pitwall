import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { AppSnapshot } from '@shared/types'
import { panes, type LayoutNode, type PaneNode, type SplitNode } from '../state/layout'
import { useUi } from '../state/ui'
import { requestFocus } from '../terminal/termCache'
import DropLayer from './DropLayer'
import { focusActiveFile } from './FileEditor'
import MainArea from './MainArea'

const DIVIDER = 5 // px

/** The middle area: a tree of splits whose leaves are panes, each showing one session. */
export default function PaneLayout({ snap }: { snap: AppSnapshot }): React.JSX.Element | null {
  const layout = useUi((s) => s.layout)
  useFocusActivePane()
  if (!layout.root) return null
  const multi = layout.root.type === 'split'
  return (
    <div className={`pane-layout${multi ? ' multi' : ''}`} data-testid="pane-layout">
      <Node node={layout.root} snap={snap} activePaneId={layout.activePaneId} multi={multi} style={{ flex: '1 1 0' }} />
    </div>
  )
}

/**
 * Keyboard focus follows the active pane when it changes without a click inside it (⌘1–9, ⌘J, a notification,
 * a drop, a dialog closing), so typing never goes to another pane. Never while a dialog is open.
 */
function useFocusActivePane(): void {
  const paneId = useUi((s) => s.layout.activePaneId)
  const sessionId = useUi((s) => s.selectedSessionId)
  const dialogOpen = useUi((s) => s.dialog !== null) // re-run when a dialog closes (e.g. after archiving)
  // Adding or removing a pane remounts the panes that move in the tree, which drops their focus.
  const paneIds = useUi((s) => panes(s.layout).map((p) => p.id).join(' '))
  useEffect(() => {
    if (!paneId || !sessionId || dialogOpen) return
    // after the browser's own mousedown focus, so a click inside the pane keeps its target
    const timer = setTimeout(() => {
      const ui = useUi.getState()
      if (ui.dialog || ui.layout.activePaneId !== paneId) return
      const el = document.querySelector(`.pane[data-pane-id="${CSS.escape(paneId)}"]`)
      if (!el || el.contains(document.activeElement)) return
      const tab = ui.activeTab[sessionId] ?? 'claude'
      if (tab === 'claude' || tab === 'shell') requestFocus(sessionId, tab)
      else if (!focusActiveFile(sessionId) && document.activeElement instanceof HTMLElement) document.activeElement.blur()
    }, 0)
    return () => clearTimeout(timer)
  }, [paneId, sessionId, dialogOpen, paneIds])
}

interface NodeProps { snap: AppSnapshot; activePaneId: string | null; multi: boolean; style: CSSProperties }

function Node({ node, ...rest }: NodeProps & { node: LayoutNode }): React.JSX.Element {
  return node.type === 'pane' ? <Pane key={node.id} pane={node} {...rest} /> : <Split node={node} {...rest} />
}

function Pane({ pane, snap, activePaneId, multi, style }: NodeProps & { pane: PaneNode }): React.JSX.Element {
  const focusPane = useUi((s) => s.focusPane)
  const dragging = useUi((s) => s.draggingSessionId !== null)
  const active = pane.id === activePaneId
  return (
    <div className={`pane${active ? ' active' : ''}`} style={style} data-testid="pane" data-pane-id={pane.id}
      data-session-id={pane.sessionId} data-active={String(active)} onMouseDownCapture={(e) => {
        // closing an inactive pane must not make it active first (the keyboard would jump to its sibling)
        if (!(e.target as Element).closest('[data-testid="close-pane"]')) focusPane(pane.id)
      }}>
      <MainArea key={pane.sessionId} snap={snap} sessionId={pane.sessionId} paneId={pane.id} multi={multi} />
      {dragging && <DropLayer paneId={pane.id} paneSessionId={pane.sessionId} />}
    </div>
  )
}

function Split({ node, style, ...rest }: NodeProps & { node: SplitNode }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const setRatio = useUi((s) => s.setRatio)
  const persistLayout = useUi((s) => s.persistLayout)
  return (
    <div ref={ref} className={`split split-${node.dir}`} style={style} data-split-id={node.id}>
      <Node node={node.a} {...rest} style={{ flex: `${node.ratio} 1 0px` }} />
      <Divider dir={node.dir} container={ref} onRatio={(r) => setRatio(node.id, r, false)} onEnd={persistLayout} />
      <Node node={node.b} {...rest} style={{ flex: `${1 - node.ratio} 1 0px` }} />
    </div>
  )
}

function Divider({ dir, container, onRatio, onEnd }: {
  dir: SplitNode['dir']; container: RefObject<HTMLDivElement | null>; onRatio: (ratio: number) => void; onEnd: () => void
}): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const bodyClass = `pane-resizing-${dir}`

  const stop = (): void => {
    if (dragging) onEnd()
    setDragging(false)
    document.body.classList.remove(bodyClass)
  }
  useEffect(() => () => document.body.classList.remove(bodyClass), [bodyClass])
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
    document.body.classList.add(bodyClass)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging || !container.current) return
    const r = container.current.getBoundingClientRect()
    // ratio of the space left after the divider, measured to the divider's centre
    const ratio = dir === 'row'
      ? (e.clientX - r.left - DIVIDER / 2) / (r.width - DIVIDER)
      : (e.clientY - r.top - DIVIDER / 2) / (r.height - DIVIDER)
    if (Number.isFinite(ratio)) onRatio(ratio)
  }

  return (
    <div className={`divider divider-${dir}${dragging ? ' dragging' : ''}`} role="separator" data-testid="pane-divider"
      aria-orientation={dir === 'row' ? 'vertical' : 'horizontal'}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={stop} onPointerCancel={stop}
      onLostPointerCapture={stop} />
  )
}
