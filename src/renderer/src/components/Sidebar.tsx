import { Fragment } from 'react'
import type { AppSnapshot, Project, SessionView, SubProject } from '@shared/types'
import { orderSessions, sessionDepth } from '@shared/runtime'
import ArchivedList from './ArchivedList'
import SessionRow from './SessionRow'
import SubagentRows from './SubagentRows'
import Menu from './Menu'
import { FolderIcon, FolderPlusIcon, HistoryIcon, MutedBellIcon, PlusIcon } from './Icons'
import { useUi } from '../state/ui'
import { useToast } from '../state/toast'
import { cleanIpcError } from '../state/errors'
import { useSidebarWidth } from '../state/sidebarWidth'

/** The sidebar's right edge: drag to resize (saved when the drag ends), double-click for the default width. */
function Resizer(): React.JSX.Element {
  const { setWidth, save, reset } = useSidebarWidth.getState()
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget
    const startX = e.clientX
    const startWidth = useSidebarWidth.getState().width
    el.setPointerCapture(e.pointerId)
    document.documentElement.classList.add('resizing-sidebar')
    const move = (ev: PointerEvent): void => setWidth(startWidth + ev.clientX - startX)
    const end = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', end)
      el.removeEventListener('pointercancel', end)
      document.documentElement.classList.remove('resizing-sidebar')
      save()
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
  }
  return (
    <div className="sidebar-resizer" data-testid="sidebar-resizer" role="separator" aria-orientation="vertical"
      aria-label="Resize sidebar" title="Drag to resize · double-click to reset" onPointerDown={onPointerDown} onDoubleClick={reset} />
  )
}

/** A folder's sessions in sidebar order, each with how deep it hangs and who started it. */
function orderedSessions(all: SessionView[], folder: SessionView[]): { s: SessionView; depth: number; parentTitle?: string }[] {
  const live = new Set(folder.map((x) => x.id))
  const byId = new Map(all.map((x) => [x.id, x]))
  return orderSessions(folder).map((s) => ({
    s, depth: sessionDepth(s, live, byId), parentTitle: s.createdBy ? byId.get(s.createdBy)?.title : undefined
  }))
}

export default function Sidebar({ snap, onSelect }: { snap: AppSnapshot; onSelect: (id: string) => void }): React.JSX.Element {
  const openDialog = useUi((s) => s.openDialog)
  const toast = useToast((s) => s.show)
  const projects = [...snap.projects].sort((a, b) => a.createdAt - b.createdAt)
  const width = useSidebarWidth((s) => s.width)

  const run = async (p: Promise<{ ok: boolean; message?: string }>): Promise<void> => {
    try {
      const r = await p
      if (!r.ok) toast(r.message ?? 'Could not remove')
    } catch (e) {
      toast(cleanIpcError(e))
    }
  }

  const addFolder = async (project: Project): Promise<void> => {
    try {
      const r = await window.pitwall.addFolder(project.id)
      if (r.status === 'needs_identity_confirm') openDialog({ type: 'identity-confirm', projectId: project.id, result: r })
      else if (r.status === 'error') toast(r.message)
    } catch (e) {
      toast(cleanIpcError(e))
    }
  }

  const subRow = (sp: SubProject, projectName: string): React.JSX.Element => (
    <div key={sp.id} className="sub-group">
      <div className="row sub-row" data-testid="subproject-row" data-name={sp.name} title={sp.path}>
        <FolderIcon />
        <span className="row-title">{sp.name}</span>
        {sp.kind === 'folder' && <span className="tag">no git</span>}
        <span className="row-actions">
          <button className="icon-btn" data-testid="continue-conversation" title="Continue a conversation"
            aria-label="Continue a conversation" onClick={() => openDialog({ type: 'conversations', subProjectId: sp.id })}>
            <HistoryIcon />
          </button>
          <button className="icon-btn" data-testid="new-session" title="New session" aria-label="New session"
            onClick={() => openDialog({ type: 'new-session', subProjectId: sp.id })}>
            <PlusIcon />
          </button>
          <Menu testId="subproject-menu" items={[
            { label: 'Setup, dev server and teardown…', testId: 'subproject-setup', onClick: () => openDialog({ type: 'subproject-settings', subProjectId: sp.id }) },
            ...(sp.kind === 'repo' ? [{
              label: 'Clean up worktrees…', testId: 'subproject-cleanup',
              onClick: () => openDialog({ type: 'stray-worktrees', subProjectId: sp.id })
            }] : []),
            { label: 'Remove from pitwall', danger: true, onClick: () => void run(window.pitwall.removeSubProject(sp.id)) }
          ]} />
        </span>
      </div>
      {orderedSessions(snap.sessions, snap.sessions.filter((s) => s.subProjectId === sp.id)).map(({ s, depth, parentTitle }) => (
          <Fragment key={s.id}>
            <SessionRow session={s} depth={depth} startedBy={parentTitle} onSelect={onSelect} projectName={projectName} subProjectName={sp.name} />
            <SubagentRows session={s} depth={depth} onSelect={onSelect} />
          </Fragment>
        ))}
    </div>
  )

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-head">
        <span>Projects</span>
        <button className="icon-btn always" data-testid="new-project" title="New project" aria-label="New project"
          onClick={() => openDialog({ type: 'project' })}>
          <PlusIcon />
        </button>
      </div>
      <div className="sidebar-scroll">
        {projects.map((p) => (
          <div key={p.id} className="project-group">
            <div className="row project-row" data-testid="project-row" data-name={p.name}>
              <span className="row-title project-name">{p.name}</span>
              {p.muted && <span className="project-muted" data-testid="project-muted" title="Notifications muted"><MutedBellIcon /></span>}
              {p.identity.ghAccount && <span className="row-muted">{p.identity.ghAccount}</span>}
              <span className="row-actions">
                <button className="icon-btn" data-testid="add-folder" title="Add folder…" aria-label="Add folder"
                  onClick={() => void addFolder(p)}>
                  <FolderPlusIcon />
                </button>
                <Menu testId="project-menu" items={[
                  { label: 'Edit project', onClick: () => openDialog({ type: 'project', projectId: p.id }) },
                  { label: 'Add folder…', onClick: () => void addFolder(p) },
                  {
                    label: p.muted ? 'Unmute notifications' : 'Mute notifications', testId: 'project-mute',
                    onClick: () => void window.pitwall.setProjectMuted(p.id, !p.muted)
                  },
                  { label: 'Remove project', danger: true, onClick: () => void run(window.pitwall.removeProject(p.id)) }
                ]} />
              </span>
            </div>
            {snap.subProjects.filter((sp) => sp.projectId === p.id)
              .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())).map((sp) => subRow(sp, p.name))}
          </div>
        ))}
      </div>
      <ArchivedList snap={snap} />
      <Resizer />
    </aside>
  )
}
