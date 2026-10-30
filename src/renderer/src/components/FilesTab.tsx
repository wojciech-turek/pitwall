import { useEffect, useState } from 'react'
import type { AppSnapshot, FileEntry } from '@shared/types'
import { useUi } from '../state/ui'
import { cleanIpcError } from '../state/errors'
import { useDiskRefresh } from '../state/refresh'
import FileTree from './FileTree'

export default function FilesTab({ snap, sessionId }: { snap: AppSnapshot; sessionId: string }): React.JSX.Element {
  const tick = useDiskRefresh(snap, sessionId)
  const [data, setData] = useState<{ files: FileEntry[]; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Expansion toggles remembered per session while the panel is mounted.
  const [toggles, setToggles] = useState<Record<string, Record<string, boolean>>>({})
  const openTab = useUi((s) => s.openTab)
  const activeId = useUi((s) => s.activeTab[sessionId])

  useEffect(() => { setData(null); setError(null) }, [sessionId])
  useEffect(() => {
    let live = true
    window.pitwall.listFiles(sessionId).then(
      (r) => { if (live) { setData(r); setError(null) } },
      (e) => { if (live) setError(cleanIpcError(e)) }
    )
    return () => { live = false }
  }, [sessionId, tick])

  const mine = toggles[sessionId] ?? {}
  if (error) return <div className="panel-hint" role="alert">{error}</div>
  if (!data) return <div className="panel-hint">Loading…</div>
  return (
    <div className="files-tab" data-testid="files-tab">
      {data.truncated && <div className="panel-note">Showing the first 20,000 files.</div>}
      <FileTree files={data.files} toggles={mine}
        activePath={activeId?.startsWith('file:') ? activeId.slice(5) : undefined}
        onToggle={(p, open) => setToggles((t) => ({ ...t, [sessionId]: { ...t[sessionId], [p]: open } }))}
        onOpen={(path) => openTab(sessionId, { id: `file:${path}`, kind: 'file', path })} />
    </div>
  )
}
