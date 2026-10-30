import { useEffect } from 'react'
import Dialog from './Dialog'
import Markdown from '../Markdown'
import { isMac } from '../../platform'
import { useUi } from '../../state/ui'
import { useUpdates } from '../../state/updates'

const openLink = (url: string): void => { void window.pitwall.openExternal(url) }
const formatDate = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

/**
 * How to update by hand. Download opens the release page, which lists every platform's file. On Windows the agents'
 * host runs from the installed Pitwall.exe, so updating stops them (they resume their conversations).
 */
export function updateHowTo(mac: boolean = isMac()): string {
  return mac
    ? 'To update, download the DMG, quit Pitwall and drag the new app into Applications. Your agents keep running and ' +
      'reconnect when you reopen it.'
    : 'To update, download the setup .exe for your PC (x64, or arm64 for Windows on ARM), quit Pitwall and run it. ' +
      'Updating stops running agents; they resume their conversations when you reopen Pitwall.'
}

/** What's new in every release newer than this one, newest first, and how to update by hand. */
export default function UpdateDialog(): React.JSX.Element | null {
  const st = useUpdates()
  const closeDialog = useUi((s) => s.closeDialog)
  const latest = st?.newer[0]
  // Nothing newer (any more): nothing to show.
  useEffect(() => { if (st && !latest) closeDialog() }, [st, latest, closeDialog])
  if (!st || !latest) return null
  const download = (): void => {
    openLink(latest.url)
    closeDialog()
  }
  return (
    <Dialog title={`Pitwall ${latest.version} is available`} testId="update-dialog" onClose={closeDialog} width={580}>
      <p className="update-current" data-testid="update-current">You have {st.current}.</p>
      <div className="update-releases">
        {st.newer.map((r) => (
          <section key={r.version} className="update-release" data-testid="update-release" data-version={r.version}>
            <div className="update-release-head">
              <span className="update-release-version">{r.version}</span>
              {r.publishedAt > 0 && <span className="update-release-date">{formatDate(r.publishedAt)}</span>}
            </div>
            {r.notes.trim()
              ? <Markdown text={r.notes} onOpenLink={openLink} />
              : <p className="update-release-empty">No notes for this release.</p>}
          </section>
        ))}
      </div>
      <p className="update-howto">{updateHowTo()}</p>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={closeDialog}>Later</button>
        <button type="button" className="btn primary" data-testid="update-download" data-autofocus onClick={download}>Download</button>
      </div>
    </Dialog>
  )
}
