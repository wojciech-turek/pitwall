import { useCallback, useEffect, useRef, useState } from 'react'
import type { StartResult, StartStep } from '@shared/types'
import Dialog from './Dialog'
import StartProgressList, { type StepInfo } from '../StartProgressList'
import { useUi } from '../../state/ui'
import { refreshSnapshot, useSnapshot } from '../../state/snapshot'
import { cleanIpcError } from '../../state/errors'
import { requestFocus } from '../../terminal/termCache'

/** Resumes an archived session as soon as it opens, with the same progress as starting one. */
export default function ResumeDialog({ sessionId }: { sessionId: string }): React.JSX.Element {
  const close = useUi((s) => s.closeDialog)
  const snap = useSnapshot()
  const session = snap?.archived.find((s) => s.id === sessionId) ?? snap?.sessions.find((s) => s.id === sessionId)
  const sub = snap?.subProjects.find((s) => s.id === session?.subProjectId)
  const [failed, setFailed] = useState(false)
  const [steps, setSteps] = useState<Partial<Record<StartStep, StepInfo>>>({})
  const requestId = useRef('')
  const started = useRef(false)

  useEffect(() => window.pitwall.onStartProgress((p) => {
    if (p.requestId !== requestId.current) return
    setSteps((cur) => ({ ...cur, [p.step]: { state: p.state, message: p.message } }))
  }), [])

  const resume = useCallback(async (): Promise<void> => {
    requestId.current = crypto.randomUUID()
    setSteps({})
    setFailed(false)
    let res: StartResult
    try {
      res = await window.pitwall.resumeSession(sessionId, requestId.current)
    } catch (e) {
      res = { ok: false, step: 'identity', error: cleanIpcError(e) }
    }
    if (!res.ok) {
      setSteps((cur) => ({ ...cur, [res.step]: { state: 'failed', message: res.error } }))
      setFailed(true)
      return
    }
    // The reply can beat the debounced snapshot push; make sure the session is active before selecting it.
    await refreshSnapshot().catch(() => {})
    requestFocus(res.sessionId, 'claude')
    const ui = useUi.getState()
    ui.select(res.sessionId)
    ui.setActiveTab(res.sessionId, 'claude')
    ui.closeDialog()
  }, [sessionId])

  useEffect(() => {
    if (started.current) return
    started.current = true
    void resume()
  }, [resume])

  return (
    <Dialog title="Resume session" testId="resume-dialog" onClose={() => { if (failed) close() }} width={480}>
      <div className="form">
        <p className="muted-text">{[session?.title, sub?.name].filter(Boolean).join(' · ')}</p>
        <StartProgressList steps={steps} folder={sub?.kind === 'folder'} />
        {failed && (
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={close}>Close</button>
            <button type="button" className="btn primary" data-testid="retry-resume" onClick={() => void resume()}>Retry</button>
          </div>
        )}
      </div>
    </Dialog>
  )
}
