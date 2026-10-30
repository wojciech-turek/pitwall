import type { AppSnapshot, Project, SubProject } from '@shared/types'
import ArchivedList from './ArchivedList'
import SessionRow from './SessionRow'
import Menu from './Menu'
import { FolderPlusIcon, MutedBellIcon, PlusIcon } from './Icons'
import { useUi } from '../state/ui'
import { useToast } from '../state/toast'
import { cleanIpcError } from '../state/errors'

export default function Sidebar({ snap, onSelect }: { snap: AppSnapshot; onSelect: (id: string) => void }): React.JSX.Element {
  const openDialog = useUi((s) => s.openDialog)
  const toast = useToast((s) => s.show)
  const projects = [...snap.projects].sort((a, b) => a.createdAt - b.createdAt)

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
        <span className="row-title">{sp.name}</span>
        {sp.kind === 'folder' && <span className="tag">no git</span>}
        <span className="row-actions">
          <button className="icon-btn" data-testid="new-session" title="New session" aria-label="New session"
            onClick={() => openDialog({ type: 'new-session', subProjectId: sp.id })}>
            <PlusIcon />
          </button>
          <Menu testId="subproject-menu" items={[
            { label: 'Setup command…', testId: 'subproject-setup', onClick: () => openDialog({ type: 'subproject-settings', subProjectId: sp.id }) },
            { label: 'Remove from pitwall', danger: true, onClick: () => void run(window.pitwall.removeSubProject(sp.id)) }
          ]} />
        </span>
      </div>
      {snap.sessions.filter((s) => s.subProjectId === sp.id).sort((a, b) => a.createdAt - b.createdAt)
        .map((s) => <SessionRow key={s.id} session={s} onSelect={onSelect} projectName={projectName} subProjectName={sp.name} />)}
    </div>
  )

  return (
    <aside className="sidebar">
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
    </aside>
  )
}
