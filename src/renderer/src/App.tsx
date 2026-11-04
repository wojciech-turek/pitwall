import { useEffect } from 'react'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import EmptyState from './components/EmptyState'
import ProjectDialog from './components/dialogs/ProjectDialog'
import IdentityConfirmDialog from './components/dialogs/IdentityConfirmDialog'
import { useUi } from './state/ui'
import { useSnapshot } from './state/snapshot'
import { useToast } from './state/toast'
import { playCue } from './state/soundPlayer'
import DiscardFileDialog from './components/dialogs/DiscardFileDialog'
import ArchiveDialog from './components/dialogs/ArchiveDialog'
import ResumeDialog from './components/dialogs/ResumeDialog'
import ConversationsDialog from './components/dialogs/ConversationsDialog'
import NewSessionDialog from './components/NewSessionDialog'
import RightPanel from './components/RightPanel'
import SubProjectSettingsDialog from './components/dialogs/SubProjectSettingsDialog'
import SettingsDialog from './components/dialogs/SettingsDialog'
import UpdateDialog from './components/dialogs/UpdateDialog'
import { useMenuCommands } from './state/menuCommands'
import { usePruneTerminals } from './components/MainArea'
import PaneLayout from './components/PaneLayout'
import DropLayer from './components/DropLayer'
import CommandPalette from './components/CommandPalette'

function DialogHost(): React.JSX.Element | null {
  const dialog = useUi((s) => s.dialog)
  if (!dialog) return null
  switch (dialog.type) {
    case 'project': return <ProjectDialog key={dialog.projectId ?? 'new'} projectId={dialog.projectId} />
    case 'identity-confirm': return <IdentityConfirmDialog projectId={dialog.projectId} result={dialog.result} />
    case 'new-session': return <NewSessionDialog key={dialog.subProjectId} subProjectId={dialog.subProjectId} />
    case 'discard-file': return <DiscardFileDialog sessionId={dialog.sessionId} tabId={dialog.tabId} name={dialog.name} />
    case 'archive': return <ArchiveDialog key={dialog.sessionId} sessionId={dialog.sessionId} />
    case 'resume': return <ResumeDialog key={dialog.sessionId} sessionId={dialog.sessionId} />
    case 'conversations': return <ConversationsDialog key={dialog.subProjectId} subProjectId={dialog.subProjectId} />
    case 'subproject-settings': return <SubProjectSettingsDialog key={dialog.subProjectId} subProjectId={dialog.subProjectId} />
    case 'settings': return <SettingsDialog />
    case 'update': return <UpdateDialog />
  }
}

export default function App(): React.JSX.Element {
  const snap = useSnapshot()
  const selected = useUi((s) => s.selectedSessionId)
  const hasPanes = useUi((s) => s.layout.root !== null)
  const visible = useUi((s) => s.visibleSessionIds)
  const select = useUi((s) => s.select)
  const pruneSessions = useUi((s) => s.pruneSessions)
  const dragging = useUi((s) => s.draggingSessionId !== null)
  const palette = useUi((s) => s.palette)
  const toast = useToast()

  usePruneTerminals(snap)
  useMenuCommands(snap)
  useEffect(() => window.pitwall.onFocusSession((id) => select(id)), [select])
  useEffect(() => window.pitwall.onPlaySound(playCue), [])
  useEffect(() => { window.pitwall.setViewing(visible) }, [visible])
  // Close the panes of sessions that disappeared (archived/removed).
  useEffect(() => {
    if (snap) pruneSessions(new Set(snap.sessions.map((s) => s.id)))
  }, [snap, visible, pruneSessions])
  // A row removed mid-drag never gets dragend; the next mouse press ends the drag so the drop layers go away.
  useEffect(() => {
    if (!dragging) return
    const end = (): void => useUi.getState().setDraggingSession(null)
    window.addEventListener('pointerdown', end, true)
    return () => window.removeEventListener('pointerdown', end, true)
  }, [dragging])

  return (
    <div className="app">
      <TitleBar sessions={snap?.sessions ?? []} />
      <div className="body">
        {snap && <Sidebar snap={snap} onSelect={select} />}
        <main className="main">
          {snap && snap.projects.length === 0 && <EmptyState />}
          {snap && snap.projects.length > 0 && !hasPanes && <div className="main-hint">Select a session, or start one with +</div>}
          {snap && hasPanes && <PaneLayout snap={snap} />}
          {snap && !hasPanes && dragging && <DropLayer paneId={null} />}
        </main>
        {snap && <RightPanel snap={snap} sessionId={selected} />}
      </div>
      <DialogHost />
      {snap && palette && <CommandPalette snap={snap} mode={palette} />}
      {toast.message && <div className="toast" role="status" onClick={toast.clear}>{toast.message}</div>}
    </div>
  )
}
