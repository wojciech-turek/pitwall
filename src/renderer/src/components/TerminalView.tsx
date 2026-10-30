import { useEffect, useRef } from 'react'
import '@xterm/xterm/css/xterm.css'
import type { TermKind } from '@shared/types'
import { attachTerminal, getTerminal, openPty, setTerminalFont, takePendingFocus } from '../terminal/termCache'
import { dropText } from '../terminal/paths'
import { isSessionDrag } from '../state/dropZone'
import { useUi } from '../state/ui'

export default function TerminalView({ sessionId, kind, fontFamily, fontSize }: {
  sessionId: string; kind: TermKind; fontFamily: string; fontSize: number
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    setTerminalFont(fontFamily, fontSize)
    const entry = attachTerminal(sessionId, kind, el)
    let timer: ReturnType<typeof setTimeout> | undefined
    let first = true

    const fitNow = (): void => {
      if (el.clientWidth === 0 || el.clientHeight === 0) return // hidden: never send 0 cols
      try { entry.fit.fit() } catch { return }
      if (!entry.opened && !entry.reopenOnKey) void openPty(sessionId, kind, entry)
      if (first) {
        first = false
        if (takePendingFocus(sessionId, kind)) requestAnimationFrame(() => entry.term.focus())
      }
    }
    const ro = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(fitNow, first ? 0 : 50)
    })
    ro.observe(el)
    fitNow()
    return () => { ro.disconnect(); clearTimeout(timer) }
  }, [sessionId, kind, fontFamily, fontSize])

  // Dropped files: paste their escaped paths at the prompt (never Enter), like Terminal.app.
  // A session dragged from the sidebar is the pane's drop layer's business, never pasted.
  const onDrop = (e: React.DragEvent): void => {
    if (isSessionDrag(e.dataTransfer)) return
    e.preventDefault()
    const dt = e.dataTransfer
    const text = dropText({
      filePaths: [...dt.files].map((f) => window.pitwall.pathForFile(f)),
      uriList: dt.getData('text/uri-list'),
      text: dt.getData('text/plain')
    })
    if (!text) return
    const { term } = getTerminal(sessionId, kind)
    term.paste(text)
    useUi.getState().select(sessionId) // its pane becomes the active one
    term.focus()
  }
  const onDragOver = (e: React.DragEvent): void => {
    if (isSessionDrag(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  return (
    <div className="terminal-host" ref={host} data-testid={`terminal-${kind}`} onDragOver={onDragOver} onDrop={onDrop} />
  )
}
