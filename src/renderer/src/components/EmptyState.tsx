import { useUi } from '../state/ui'

export default function EmptyState(): React.JSX.Element {
  const openDialog = useUi((s) => s.openDialog)
  return (
    <div className="empty-state">
      <h1>No projects yet</h1>
      <p>A project groups the folders and repos that share one git identity.</p>
      <button className="btn primary" data-testid="create-first-project" onClick={() => openDialog({ type: 'project' })}>
        Create your first project
      </button>
    </div>
  )
}
