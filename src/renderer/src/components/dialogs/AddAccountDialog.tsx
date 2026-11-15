import { useEffect, useRef, useState } from 'react'
import Dialog from './Dialog'
import TerminalView from '../TerminalView'
import { cleanIpcError } from '../../state/errors'
import { useSnapStore } from '../../state/snapshot'
import { useUi } from '../../state/ui'
import { disposeTerminal } from '../../terminal/termCache'

/**
 * Signing in to a Claude account, in a terminal running `claude auth login` in that account's own folder. For a new
 * account (`addId`), the account is listed once someone has signed in; closing the dialog before that discards it.
 * For an account already added (`accountId`), this signs in to it again.
 */
export default function AddAccountDialog({ termId, addId, accountId, label }: {
  termId: string; addId?: string; accountId?: string; label?: string
}): React.JSX.Element {
  const closeDialog = useUi((s) => s.closeDialog)
  const settings = useSnapStore((s) => s.snap?.settings)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const done = useRef(false)

  const close = (): void => {
    disposeTerminal(termId, 'claude')
    closeDialog()
  }
  /** The sign-in ended (or the user says it has): keep the account if someone is signed in. */
  const finish = (): void => {
    if (done.current) return
    if (!addId) { done.current = true; void window.pitwall.endAccountLogin(accountId ?? '').finally(close); return }
    setBusy(true)
    void window.pitwall.finishAddAccount(addId).then((r) => {
      if (r.ok) { done.current = true; close() } else { done.current = true; setError(r.message) }
    }, (e) => setError(cleanIpcError(e))).finally(() => setBusy(false))
  }
  const cancel = (): void => {
    if (!done.current) {
      done.current = true
      void (addId ? window.pitwall.cancelAddAccount(addId) : window.pitwall.endAccountLogin(accountId ?? ''))
    }
    close()
  }

  useEffect(() => window.pitwall.onTermExit((id, kind) => { if (id === termId && kind === 'claude') finish() }), [termId])

  return (
    <Dialog title={addId ? 'Add a Claude account' : `Sign in to ${label ?? 'this account'}`} testId="add-account-dialog" onClose={cancel} width={720}>
      <p className="dialog-note">
        Claude opens your browser to sign in. {addId ? 'Signing in here never signs your other accounts out.' : ''} Pitwall
        doesn't see or store the login: Claude Code keeps it.
      </p>
      {error
        ? <div className="banner error" role="alert" data-testid="add-account-error">{error}</div>
        : (
          <div className="account-login-term">
            <TerminalView sessionId={termId} kind="claude" fontFamily={settings?.monoFont ?? 'monospace'} fontSize={settings?.monoFontSize ?? 13} />
          </div>
        )}
      <div className="dialog-actions">
        <button className="btn" data-testid="add-account-cancel" onClick={cancel}>{error ? 'Close' : 'Cancel'}</button>
        {!error && <button className="btn primary" data-testid="add-account-done" disabled={busy} onClick={finish}>Done</button>}
      </div>
    </Dialog>
  )
}
