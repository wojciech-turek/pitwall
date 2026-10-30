import { useEffect, useState } from 'react'
import type { ArchiveCheck } from '@shared/types'
import Dialog from './Dialog'
import { useSnapshot } from '../../state/snapshot'
import { useUi } from '../../state/ui'
import { cleanIpcError } from '../../state/errors'
import { useToast } from '../../state/toast'

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

export default function ArchiveDialog({ sessionId }: { sessionId: string }): React.JSX.Element {
  const closeDialog = useUi((s) => s.closeDialog)
  const forgetSession = useUi((s) => s.forgetSession)
  const toast = useToast((s) => s.show)
  const snap = useSnapshot()
  const [check, setCheck] = useState<ArchiveCheck | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ exitCode: number | null; timedOut: boolean; output: string } | null>(null)

  useEffect(() => {
    let live = true
    window.pitwall.checkArchive(sessionId).then((c) => { if (live) setCheck(c) }, (e) => { if (live) setError(cleanIpcError(e)) })
    return () => { live = false }
  }, [sessionId])

  const tearingDown = !!snap?.subProjects.find((p) => p.id === snap.sessions.find((x) => x.id === sessionId)?.subProjectId)?.teardownCommand
  const warn = !!check && (check.uncommittedFiles > 0 || check.unpushedCommits > 0)

  const archive = async (skipTeardown = false): Promise<void> => {
    if (!check) return
    setBusy(true)
    setError(null)
    setFailure(null)
    try {
      // Confirmed only when the user has just seen the warning for exactly this state.
      const r = await window.pitwall.archiveSession(sessionId, warn, skipTeardown)
      if (r.ok) {
        forgetSession(sessionId)
        closeDialog()
        if (r.leftFolder) toast(`Archived. Some files were in use, so ${r.leftFolder} is still there: delete it later.`)
        return
      }
      if ('needsConfirm' in r) setCheck(r.needsConfirm) // state changed since the dialog opened: show the new warning
      else if ('teardownFailed' in r) setFailure(r.teardownFailed)
      else setError(r.error)
    } catch (e) {
      setError(cleanIpcError(e))
    }
    setBusy(false)
  }

  const guard = (): void => { if (!busy) closeDialog() }

  return (
    <Dialog title="Archive session?" testId="archive-dialog" onClose={guard} width={480}>
      {!check && !error && <p className="archive-note">Checking for unsaved work…</p>}
      {check && (
        <ul className="archive-list" data-testid="archive-actions">
          <li>Stop the agent</li>
          {check.willRemoveWorktree && check.worktreePath && <li>Delete worktree <code>{check.worktreePath}</code></li>}
          {check.willDeleteBranch && check.branch && <li>Delete branch <code>{check.branch}</code></li>}
        </ul>
      )}
      {check && warn && (
        <p className="archive-warning" data-testid="archive-warning">
          {plural(check.uncommittedFiles, 'uncommitted file', 'uncommitted files')} and{' '}
          {plural(check.unpushedCommits, 'commit', 'commits')} that {check.unpushedCommits === 1 ? 'was' : 'were'} never pushed will be lost.
        </p>
      )}
      {busy && <p className="archive-note" data-testid="archive-progress">{tearingDown ? 'Running teardown…' : 'Archiving…'}</p>}
      {failure && (
        <div data-testid="teardown-failed">
          <p className="archive-error" role="alert">
            Teardown {failure.timedOut ? 'timed out after 2 minutes' : `failed (exit code ${failure.exitCode ?? 'unknown'})`}. The agent and anything it started are stopped; nothing was deleted.
          </p>
          {failure.output && <pre className="teardown-output" data-testid="teardown-output">{failure.output}</pre>}
        </div>
      )}
      {error && <p className="archive-error" role="alert" data-testid="archive-error">{error}</p>}
      <div className="dialog-actions">
        <button className="btn" data-autofocus disabled={busy} onClick={guard}>Cancel</button>
        {failure && (
          <button className="btn danger" data-testid="archive-anyway" disabled={busy} onClick={() => void archive(true)}>Archive anyway</button>
        )}
        <button className={`btn ${warn ? 'danger' : 'primary'}`} data-testid="archive-confirm" disabled={busy || !check}
          onClick={() => void archive()}>{failure ? 'Retry' : 'Archive'}</button>
      </div>
    </Dialog>
  )
}
