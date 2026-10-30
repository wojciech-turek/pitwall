import { useEffect, useRef, useState } from 'react'
import type { NewSessionDefaults, StartResult, StartStep } from '@shared/types'
import { defaultBranchName, slugify } from '@shared/slug'
import Dialog from './dialogs/Dialog'
import StartProgressList, { type StepInfo } from './StartProgressList'
import { useUi } from '../state/ui'
import { refreshSnapshot, useSnapshot } from '../state/snapshot'
import { cleanIpcError } from '../state/errors'
import { requestFocus } from '../terminal/termCache'

type Phase = 'form' | 'starting' | 'failed'

export default function NewSessionDialog({ subProjectId }: { subProjectId: string }): React.JSX.Element {
  const close = useUi((s) => s.closeDialog)
  const snap = useSnapshot()
  const sub = snap?.subProjects.find((s) => s.id === subProjectId)

  const [defaults, setDefaults] = useState<NewSessionDefaults | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [branch, setBranch] = useState('')
  const [branchEdited, setBranchEdited] = useState(false)
  const [base, setBase] = useState('')
  const [existing, setExisting] = useState('')
  const [phase, setPhase] = useState<Phase>('form')
  const [steps, setSteps] = useState<Partial<Record<StartStep, StepInfo>>>({})
  const requestId = useRef('')

  useEffect(() => {
    let live = true
    window.pitwall.prepareNewSession(subProjectId)
      .then((d) => {
        if (!live) return
        setDefaults(d)
        setBase(d.baseBranch ?? '')
        setExisting(d.branches.find((b) => !b.checkedOutAt && b.name !== d.defaultBranch)?.name ?? '')
      })
      .catch((e) => { if (live) setLoadError(cleanIpcError(e)) })
    return () => { live = false }
  }, [subProjectId])

  useEffect(() => window.pitwall.onStartProgress((p) => {
    if (p.requestId !== requestId.current) return
    setSteps((cur) => ({ ...cur, [p.step]: { state: p.state, message: p.message } }))
  }), [])

  const isRepo = defaults?.kind === 'repo'
  const noCommits = isRepo && !defaults.hasCommits
  const effectiveBranch = mode === 'existing' ? existing : branch
  const canStart = !!defaults && !noCommits && title.trim() !== '' &&
    (!isRepo || effectiveBranch.trim() !== '')

  const onTitle = (v: string): void => {
    setTitle(v)
    if (!branchEdited) setBranch(defaultBranchName(slugify(v)))
  }

  const start = async (): Promise<void> => {
    if (!canStart) return
    requestId.current = crypto.randomUUID()
    setSteps({})
    setPhase('starting')
    let res: StartResult
    try {
      res = await window.pitwall.startSession({
        requestId: requestId.current, subProjectId, title: title.trim(),
        branchMode: mode, branch: isRepo ? effectiveBranch.trim() : '',
        baseBranch: isRepo && mode === 'new' ? base || undefined : undefined
      })
    } catch (e) {
      res = { ok: false, step: 'identity', error: cleanIpcError(e) }
    }
    if (!res.ok) {
      setSteps((cur) => ({ ...cur, [res.step]: { state: 'failed', message: res.error } }))
      setPhase('failed')
      return
    }
    // The reply can beat the debounced snapshot push; make sure the session exists before selecting it.
    await refreshSnapshot().catch(() => {})
    requestFocus(res.sessionId, 'claude')
    const ui = useUi.getState()
    ui.select(res.sessionId)
    ui.setActiveTab(res.sessionId, 'claude')
    ui.closeDialog()
  }

  const cancel = (): void => { if (phase !== 'starting') close() }
  const baseOptions = defaults
    ? [...new Set([...(defaults.baseBranch ? [defaults.baseBranch] : []), ...defaults.branches.map((b) => b.name)])]
    : []

  return (
    <Dialog title="New session" testId="new-session-dialog" onClose={cancel} width={480}>
      {phase === 'form' ? (
        <form className="form" onSubmit={(e) => { e.preventDefault(); void start() }}>
          {sub && <p className="muted-text">{sub.name}</p>}
          <label>Title
            <input data-testid="session-title-input" data-autofocus value={title} placeholder="What should Claude work on?"
              onChange={(e) => onTitle(e.target.value)} />
          </label>
          {isRepo && !noCommits && (
            <>
              <div className="seg" role="radiogroup" aria-label="Branch mode">
                <button type="button" role="radio" aria-checked={mode === 'new'} className={mode === 'new' ? 'on' : ''}
                  data-testid="mode-new" onClick={() => setMode('new')}>New branch</button>
                <button type="button" role="radio" aria-checked={mode === 'existing'} className={mode === 'existing' ? 'on' : ''}
                  data-testid="mode-existing" onClick={() => setMode('existing')}>Use existing branch</button>
              </div>
              {mode === 'new' ? (
                <div className="form-row">
                  <label>Branch name
                    <input data-testid="branch-input" value={branch}
                      onChange={(e) => { setBranch(e.target.value); setBranchEdited(true) }} />
                  </label>
                  <label>Base branch
                    <select data-testid="base-branch-select" value={base} onChange={(e) => setBase(e.target.value)}>
                      {defaults.baseBranch === null && <option value="">Current commit</option>}
                      {baseOptions.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </label>
                </div>
              ) : (
                <label>Branch
                  <select data-testid="existing-branch-select" value={existing} onChange={(e) => setExisting(e.target.value)}>
                    {defaults.branches.map((b) => {
                      const isMain = b.name === defaults.defaultBranch
                      return (
                        <option key={b.name} value={b.name} disabled={!!b.checkedOutAt || isMain}>
                          {b.name}{isMain ? ' (main branch: use New branch to start from it)' : b.checkedOutAt ? ` (checked out in ${b.checkedOutAt})` : ''}
                        </option>
                      )
                    })}
                  </select>
                </label>
              )}
            </>
          )}
          {noCommits && <div className="form-error" role="alert" data-testid="no-commits">This repo has no commits yet. Make a first commit, then start a session.</div>}
          {loadError && <div className="form-error" role="alert">{loadError}</div>}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={close}>Cancel</button>
            <button type="submit" className="btn primary" data-testid="start-session" disabled={!canStart}>Start</button>
          </div>
        </form>
      ) : (
        <div className="form">
          <StartProgressList steps={steps} folder={defaults?.kind === 'folder'} />
          {phase === 'failed' && (
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={close}>Cancel</button>
              <button type="button" className="btn primary" data-testid="retry-start" onClick={() => void start()}>Retry</button>
            </div>
          )}
        </div>
      )}
    </Dialog>
  )
}
