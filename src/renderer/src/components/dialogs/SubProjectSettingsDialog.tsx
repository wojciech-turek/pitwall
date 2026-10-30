import { useState } from 'react'
import Dialog from './Dialog'
import { useSnapshot } from '../../state/snapshot'
import { useUi } from '../../state/ui'
import { useToast } from '../../state/toast'
import { cleanIpcError } from '../../state/errors'

export default function SubProjectSettingsDialog({ subProjectId }: { subProjectId: string }): React.JSX.Element | null {
  const snap = useSnapshot()
  const closeDialog = useUi((s) => s.closeDialog)
  const toast = useToast((s) => s.show)
  const sp = snap?.subProjects.find((x) => x.id === subProjectId)
  const [command, setCommand] = useState(sp?.setupCommand ?? '')
  const [teardown, setTeardown] = useState(sp?.teardownCommand ?? '')
  if (!sp) return null
  const save = async (): Promise<void> => {
    try {
      await window.pitwall.updateSubProject(sp.id, { setupCommand: command.trim(), teardownCommand: teardown.trim() })
      closeDialog()
    } catch (e) {
      toast(cleanIpcError(e))
    }
  }
  return (
    <Dialog title={`Setup and teardown · ${sp.name}`} testId="subproject-settings-dialog" onClose={closeDialog}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void save() }}>
        <label>
          Setup command
          <input data-autofocus data-testid="setup-command" value={command} spellCheck={false}
            placeholder="pnpm install" onChange={(e) => setCommand(e.target.value)} />
        </label>
        <p className="muted-text help">Runs once in each new worktree before Claude starts. $PITWALL_ROOT_PATH is the main folder.</p>
        <label>
          Teardown command
          <input data-testid="teardown-command" value={teardown} spellCheck={false}
            placeholder="docker compose down" onChange={(e) => setTeardown(e.target.value)} />
        </label>
        <p className="muted-text help">Runs when you archive a session, before its folder is deleted. Stops anything the session started, e.g. <code>docker compose down</code>.</p>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={closeDialog}>Cancel</button>
          <button type="submit" className="btn primary" data-testid="setup-command-save">Save</button>
        </div>
      </form>
    </Dialog>
  )
}
