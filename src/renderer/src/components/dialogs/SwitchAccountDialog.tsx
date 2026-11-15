import { useState } from 'react'
import Dialog from './Dialog'
import { switchPrompt } from '../../state/accounts'
import { cleanIpcError } from '../../state/errors'
import { useToast } from '../../state/toast'
import { useUi } from '../../state/ui'

/** After Switch, when sessions are running on another account: move them too, or only start new sessions on this one. */
export default function SwitchAccountDialog({ accountId, label, now, later }: {
  accountId: string; label: string; now: number; later: number
}): React.JSX.Element {
  const closeDialog = useUi((s) => s.closeDialog)
  const [busy, setBusy] = useState(false)
  const p = switchPrompt(label, { now, later })
  const go = (moveRunning: boolean): void => {
    setBusy(true)
    void window.pitwall.setActiveAccount(accountId, moveRunning)
      .then(closeDialog, (e) => { useToast.getState().show(cleanIpcError(e)); setBusy(false) })
  }
  return (
    <Dialog title={p.title} testId="switch-account-dialog" onClose={closeDialog}>
      <p className="dialog-note">{p.body} {p.warning}</p>
      <div className="dialog-actions">
        <button className="btn" data-testid="switch-new-only" disabled={busy} onClick={() => go(false)}>New sessions only</button>
        <button className="btn primary" data-testid="switch-move" data-autofocus disabled={busy} onClick={() => go(true)}>Move sessions</button>
      </div>
    </Dialog>
  )
}
