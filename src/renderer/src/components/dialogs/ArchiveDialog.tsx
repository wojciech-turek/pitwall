import { useEffect, useState } from 'react'
import type { ArchiveCheck } from '@shared/types'
import Dialog from './Dialog'
import { useUi } from '../../state/ui'
import { cleanIpcError } from '../../state/errors'

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

export default function ArchiveDialog({ sessionId }: { sessionId: string }): React.JSX.Element {
  const closeDialog = useUi((s) => s.closeDialog)
  const forgetSession = useUi((s) => s.forgetSession)
  const [check, setCheck] = useState<ArchiveCheck | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    window.pitwall.checkArchive(sessionId).then((c) => { if (live) setCheck(c) }, (e) => { if (live) setError(cleanIpcError(e)) })
    return () => { live = false }
  }, [sessionId])

  const warn = !!check && (check.uncommittedFiles > 0 || check.unpushedCommits > 0)

  const archive = async (): Promise<void> => {
    if (!check) return
    setBusy(true)
    setError(null)
    try {
      // Confirmed only when the user has just seen the warning for exactly this state.
      const r = await window.pitwall.archiveSession(sessionId, warn)
      if (r.ok) {
        forgetSession(sessionId)
        closeDialog()
        return
      }
      if ('needsConfirm' in r) setCheck(r.needsConfirm) // state changed since the dialog opened: show the new warning
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
      {busy && <p className="archive-note" data-testid="archive-progress">Archiving…</p>}
      {error && <p className="archive-error" role="alert" data-testid="archive-error">{error}</p>}
      <div className="dialog-actions">
        <button className="btn" data-autofocus disabled={busy} onClick={guard}>Cancel</button>
        <button className={`btn ${warn ? 'danger' : 'primary'}`} data-testid="archive-confirm" disabled={busy || !check}
          onClick={() => void archive()}>Archive</button>
      </div>
    </Dialog>
  )
}
