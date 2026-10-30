import { useState } from 'react'
import Dialog from './Dialog'
import { useSnapshot } from '../../state/snapshot'
import { useUi } from '../../state/ui'
import { useToast } from '../../state/toast'
import { cleanIpcError } from '../../state/errors'
import { useAppInfo } from '../../state/appInfo'

export default function SettingsDialog(): React.JSX.Element | null {
  const snap = useSnapshot()
  const closeDialog = useUi((s) => s.closeDialog)
  const toast = useToast((s) => s.show)
  const info = useAppInfo()
  const [font, setFont] = useState(snap?.settings.monoFont ?? '')
  const [size, setSize] = useState(String(snap?.settings.monoFontSize ?? 13))
  if (!snap) return null
  const save = async (): Promise<void> => {
    const n = Number(size)
    try {
      await window.pitwall.setSettings({ monoFont: font.trim() || snap.settings.monoFont, monoFontSize: Number.isFinite(n) && n > 0 ? n : snap.settings.monoFontSize })
      closeDialog()
    } catch (e) {
      toast(cleanIpcError(e))
    }
  }
  return (
    <Dialog title="Settings" testId="settings-dialog" onClose={closeDialog}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void save() }}>
        <div className="form-row">
          <label>
            Terminal and editor font
            <input data-autofocus data-testid="setting-font" value={font} spellCheck={false} onChange={(e) => setFont(e.target.value)} />
          </label>
          <label style={{ flex: '0 0 80px' }}>
            Size
            <input data-testid="setting-size" type="number" min={8} max={32} value={size} onChange={(e) => setSize(e.target.value)} />
          </label>
        </div>
        <p className="muted-text help">Applies to terminals, the file editor and diffs.</p>
        {info && (
          <p className="muted-text help" data-testid="settings-version" style={{ marginTop: 12 }}>
            Pitwall {info.version}{info.dev ? ' (dev build)' : ''}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={closeDialog}>Cancel</button>
          <button type="submit" className="btn primary" data-testid="settings-save">Save</button>
        </div>
      </form>
    </Dialog>
  )
}
