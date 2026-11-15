import { useState } from 'react'
import Dialog from './Dialog'
import { useReview } from '../../state/review'
import { useUi } from '../../state/ui'

export default function ReviewCommentDialog({ sessionId, path, fromLine, toLine, quote }: {
  sessionId: string; path: string; fromLine: number; toLine: number; quote: string
}): React.JSX.Element {
  const closeDialog = useUi((s) => s.closeDialog)
  const [note, setNote] = useState('')
  const where = fromLine === toLine ? `line ${fromLine}` : `lines ${fromLine}-${toLine}`
  const save = (): void => {
    if (!note.trim()) return
    useReview.getState().add(sessionId, { path, fromLine, toLine, quote, note: note.trim() })
    closeDialog()
  }
  return (
    <Dialog title={`Comment on ${path} (${where})`} testId="review-comment-dialog" onClose={closeDialog} width={480}>
      <pre className="review-quote">{quote}</pre>
      <textarea className="review-input" data-testid="review-note" data-autofocus rows={4} value={note}
        placeholder="What should the agent change?" onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save() } }} />
      <div className="dialog-actions">
        <button className="btn" onClick={closeDialog}>Cancel</button>
        <button className="btn primary" data-testid="review-save" disabled={!note.trim()} onClick={save}>Save</button>
      </div>
    </Dialog>
  )
}
