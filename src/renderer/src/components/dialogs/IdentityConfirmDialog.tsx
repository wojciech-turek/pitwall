import { useState } from 'react'
import type { AddFolderResult } from '@shared/api'
import Dialog from './Dialog'
import { useUi } from '../../state/ui'
import { cleanIpcError } from '../../state/errors'

type Needs = Extract<AddFolderResult, { status: 'needs_identity_confirm' }>

export default function IdentityConfirmDialog({ projectId, result }: { projectId: string; result: Needs }): React.JSX.Element {
  const close = useUi((s) => s.closeDialog)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { current, proposed } = result

  const choose = async (overwrite: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const r = await window.pitwall.confirmAddFolder(projectId, result.path, overwrite)
      if (r.status === 'error') { setError(r.message); setBusy(false); return }
      if (r.status === 'needs_identity_confirm') { setError('The repo identity is still different.'); setBusy(false); return }
      close()
    } catch (e) {
      setError(cleanIpcError(e))
      setBusy(false)
    }
  }

  // A project without an SSH key leaves the repo's ssh command as it is.
  const rows: [string, string | undefined, React.ReactNode][] = [
    ['SSH command', current.sshCommand, proposed.sshCommand ?? <em>(unchanged)</em>],
    ['Commit name', current.name, proposed.name],
    ['Commit email', current.email, proposed.email]
  ]
  return (
    <Dialog title="This repo already has a git identity" testId="identity-confirm-dialog" onClose={close} width={560}>
      <p className="muted-text">{result.path}</p>
      <table className="identity-table">
        <thead><tr><th /><th>Current</th><th>Project</th></tr></thead>
        <tbody>
          {rows.map(([label, cur, prop]) => (
            <tr key={label}><th>{label}</th><td>{cur || <em>not set</em>}</td><td>{prop || <em>not set</em>}</td></tr>
          ))}
        </tbody>
      </table>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="dialog-actions">
        <button className="btn" onClick={close} disabled={busy}>Cancel</button>
        <button className="btn" data-testid="identity-keep" onClick={() => void choose(false)} disabled={busy}>Keep existing</button>
        <button className="btn primary" data-testid="identity-replace" data-autofocus onClick={() => void choose(true)} disabled={busy}>
          Replace with project identity
        </button>
      </div>
    </Dialog>
  )
}
