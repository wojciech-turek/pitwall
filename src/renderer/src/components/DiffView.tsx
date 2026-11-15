import { useEffect, useRef, useState } from 'react'
import { MergeView, unifiedMergeView } from '@codemirror/merge'
import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import type { AppSnapshot, ChangedFile } from '@shared/types'
import { loadLanguage, viewExtensions } from '../editor/codemirror'
import { cleanIpcError } from '../state/errors'
import { useDiskRefresh } from '../state/refresh'
import { useUi } from '../state/ui'
import { LineCounts } from './ChangesTab'

interface Sides { original: string; modified: string; binary: boolean; tooLarge: boolean }

const collapseUnchanged = { margin: 3, minSize: 4 }
const readOnly = [EditorState.readOnly.of(true), EditorView.editable.of(false)]

export default function DiffView({ snap, sessionId, path, active }: {
  snap: AppSnapshot; sessionId: string; path: string; active: boolean
}): React.JSX.Element {
  const tick = useDiskRefresh(snap, sessionId)
  const mode = useUi((s) => s.diffMode)
  const setMode = useUi((s) => s.setDiffMode)
  const [sides, setSides] = useState<Sides | null>(null)
  const [stat, setStat] = useState<ChangedFile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const host = useRef<HTMLDivElement>(null)
  /** The new side's view (mv.b, or the unified view): what a comment's lines are read from. */
  const newSide = useRef<EditorView | null>(null)
  const [hasSel, setHasSel] = useState(false)
  const { monoFont, monoFontSize } = snap.settings

  useEffect(() => {
    let live = true
    Promise.all([window.pitwall.readDiff(sessionId, path), window.pitwall.listChanges(sessionId)]).then(
      ([d, l]) => {
        if (!live) return
        setSides((cur) => (cur && cur.original === d.original && cur.modified === d.modified && cur.binary === d.binary && cur.tooLarge === d.tooLarge ? cur : d))
        setStat(l.files.find((f) => f.path === path) ?? null)
        setError(null)
      },
      (e) => { if (live) setError(cleanIpcError(e)) }
    )
    return () => { live = false }
  }, [sessionId, path, tick])

  useEffect(() => {
    const el = host.current
    if (!el || !sides || sides.binary || sides.tooLarge) return
    let destroyed = false
    let destroy = (): void => undefined
    void loadLanguage(path).then((lang) => {
      if (destroyed) return
      const ext = [...viewExtensions(monoFont, monoFontSize), ...readOnly, ...(lang ? [lang] : [])]
      const watch = EditorView.updateListener.of((u) => {
        if (u.selectionSet || u.docChanged) setHasSel(!u.state.selection.main.empty)
      })
      if (mode === 'split') {
        const mv = new MergeView({
          parent: el,
          a: { doc: sides.original, extensions: ext },
          b: { doc: sides.modified, extensions: [...ext, watch] },
          highlightChanges: true, gutter: true, collapseUnchanged
        })
        newSide.current = mv.b
        destroy = () => mv.destroy()
      } else {
        const v = new EditorView({
          parent: el,
          doc: sides.modified,
          extensions: [
            ...ext, watch, lineNumbers(),
            unifiedMergeView({ original: sides.original, mergeControls: false, collapseUnchanged })
          ]
        })
        newSide.current = v
        destroy = () => v.destroy()
      }
    })
    return () => { destroyed = true; destroy(); newSide.current = null; setHasSel(false); el.replaceChildren() }
  }, [sides, mode, path, monoFont, monoFontSize])

  function comment(): void {
    const view = newSide.current
    if (!view) return
    const { doc, selection } = view.state
    const { from, to } = selection.main
    if (from === to) return
    const first = doc.lineAt(from)
    let last = doc.lineAt(to)
    // A selection that ends at the start of a line doesn't include that line.
    if (last.number > first.number && to === last.from) last = doc.line(last.number - 1)
    const quote: string[] = []
    for (let n = first.number; n <= Math.min(last.number, first.number + 2); n++) quote.push(doc.line(n).text.slice(0, 160))
    useUi.getState().openDialog({
      type: 'review-comment', sessionId, path, fromLine: first.number, toLine: last.number, quote: quote.join('\n')
    })
  }

  return (
    <div className="file-editor diff-view" style={{ display: active ? 'flex' : 'none' }} data-testid={`diff-${path}`}>
      <div className="editor-head">
        <span className="editor-path" title={path}>
          {path}{' '}{stat && <LineCounts additions={stat.additions} deletions={stat.deletions} />}
        </span>
        <button className="btn" data-testid="diff-comment" disabled={!hasSel} onClick={comment}
          title="Comment on the selected lines of the new side">Comment</button>
        <div className="seg" role="group" aria-label="Diff layout">
          <button className={mode === 'split' ? 'on' : ''} data-testid="diff-split" onClick={() => setMode('split')}>Split</button>
          <button className={mode === 'unified' ? 'on' : ''} data-testid="diff-unified" onClick={() => setMode('unified')}>Unified</button>
        </div>
      </div>
      {error && <div className="main-hint editor-msg" role="alert">{error}</div>}
      {!error && !sides && <div className="main-hint editor-msg">Loading…</div>}
      {sides?.binary && <div className="main-hint editor-msg">Binary file — no preview.</div>}
      {sides?.tooLarge && <div className="main-hint editor-msg">File too large to diff.</div>}
      <div className="editor-host diff-host" ref={host} />
    </div>
  )
}
