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
  const [devCommand, setDevCommand] = useState(sp?.devCommand ?? '')
  const [teardown, setTeardown] = useState(sp?.teardownCommand ?? '')
  if (!sp) return null
  const save = async (): Promise<void> => {
    try {
      await window.pitwall.updateSubProject(sp.id, { setupCommand: command.trim(), devCommand: devCommand.trim(), teardownCommand: teardown.trim() })
      closeDialog()
    } catch (e) {
      toast(cleanIpcError(e))
    }
  }
  return (
    <Dialog title={`Setup, dev server and teardown · ${sp.name}`} testId="subproject-settings-dialog" onClose={closeDialog}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void save() }}>
        <label>
          Setup command
          <input data-autofocus data-testid="setup-command" value={command} spellCheck={false}
            placeholder="pnpm install" onChange={(e) => setCommand(e.target.value)} />
        </label>
        <p className="muted-text help">Runs once in each new worktree before Claude starts. $PITWALL_ROOT_PATH is the main folder.</p>
        <label>
          Dev server command
          <input data-testid="dev-command" value={devCommand} spellCheck={false}
            placeholder="pnpm dev --port $PORT" onChange={(e) => setDevCommand(e.target.value)} />
        </label>
        <p className="muted-text help">Runs in the Server tab. $PORT (and $PITWALL_PORT) is this session's own port; the 9 after it are free for it too.</p>
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
