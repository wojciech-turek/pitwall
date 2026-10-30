import type { AppSnapshot } from '@shared/types'
import { useUi } from '../state/ui'
import ChangesTab from './ChangesTab'
import FilesTab from './FilesTab'
import UsageMeter from './UsageMeter'

export default function RightPanel({ snap, sessionId }: { snap: AppSnapshot; sessionId: string | null }): React.JSX.Element {
  const rightTab = useUi((s) => s.rightTab)
  const setRightTab = useUi((s) => s.setRightTab)
  const session = snap.sessions.find((s) => s.id === sessionId)
  const kind = snap.subProjects.find((p) => p.id === session?.subProjectId)?.kind
  const showChanges = kind === 'repo'
  const tab = rightTab === 'changes' && !showChanges ? 'files' : rightTab
  return (
    <aside className="right-panel" data-testid="right-panel">
      {session && (
        <>
          <div className="panel-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'files'} className={tab === 'files' ? 'on' : ''}
              data-testid="right-tab-files" onClick={() => setRightTab('files')}>Files</button>
            {showChanges && (
              <button role="tab" aria-selected={tab === 'changes'} className={tab === 'changes' ? 'on' : ''}
                data-testid="right-tab-changes" onClick={() => setRightTab('changes')}>Changes</button>
            )}
          </div>
          <div className="panel-body">
            {tab === 'files'
              ? <FilesTab snap={snap} sessionId={session.id} />
              : <ChangesTab snap={snap} sessionId={session.id} />}
          </div>
        </>
      )}
      <UsageMeter />
    </aside>
  )
}
