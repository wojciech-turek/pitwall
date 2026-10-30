import Dialog from './Dialog'
import { useUi } from '../../state/ui'

export default function DiscardFileDialog({ sessionId, tabId, name }: { sessionId: string; tabId: string; name: string }): React.JSX.Element {
  const closeDialog = useUi((s) => s.closeDialog)
  const closeTab = useUi((s) => s.closeTab)
  return (
    <Dialog title={`Discard unsaved changes to ${name}?`} testId="discard-file-dialog" onClose={closeDialog} width={420}>
      <div className="dialog-actions">
        <button className="btn" data-autofocus onClick={closeDialog}>Cancel</button>
        <button className="btn primary" data-testid="discard-confirm"
          onClick={() => { closeTab(sessionId, tabId); closeDialog() }}>Discard</button>
      </div>
    </Dialog>
  )
}
