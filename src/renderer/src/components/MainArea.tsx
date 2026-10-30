import { useEffect } from 'react'
import type { AppSnapshot } from '@shared/types'
import { useUi } from '../state/ui'
import SessionHeader from './SessionHeader'
import TabStrip from './TabStrip'
import DiffView from './DiffView'
import FileEditor from './FileEditor'
import TerminalView from './TerminalView'
import { pruneTerminals } from '../terminal/termCache'

export default function MainArea({ snap, sessionId, paneId, multi }: {
  snap: AppSnapshot; sessionId: string; paneId: string; multi: boolean
}): React.JSX.Element | null {
  const closePane = useUi((s) => s.closePane)
  const tabs = useUi((s) => s.tabs[sessionId])
  const active = useUi((s) => s.activeTab[sessionId] ?? 'claude')
  const session = snap.sessions.find((s) => s.id === sessionId)
  if (!session || !tabs) return null
  const activeTab = tabs.find((t) => t.id === active) ?? tabs[0]
  const sub = snap.subProjects.find((s) => s.id === session.subProjectId)
  return (
    <div className="main-area">
      <SessionHeader session={session} subProject={sub} multi={multi} onClose={() => closePane(paneId)} />
      <TabStrip sessionId={sessionId} tabs={tabs} active={activeTab.id} />
      <div className="tab-body">
        {(activeTab.id === 'claude' || activeTab.id === 'shell') && (
          <TerminalView key={`${sessionId}:${activeTab.id}`} sessionId={sessionId} kind={activeTab.id}
            fontFamily={snap.settings.monoFont} fontSize={snap.settings.monoFontSize} />
        )}
        {/* Editors stay mounted (hidden) so unsaved edits survive tab switches. */}
        {tabs.map((t) => 'kind' in t && t.kind === 'file' && (
          <FileEditor key={t.id} snap={snap} sessionId={sessionId} path={t.path} active={t.id === activeTab.id} />
        ))}
        {tabs.map((t) => 'kind' in t && t.kind === 'diff' && (
          <DiffView key={t.id} snap={snap} sessionId={sessionId} path={t.path} active={t.id === activeTab.id} />
        ))}
      </div>
    </div>
  )
}

/** Dispose cached terminals for sessions that left the snapshot. */
export function usePruneTerminals(snap: AppSnapshot | null): void {
  useEffect(() => {
    if (snap) pruneTerminals(new Set(snap.sessions.map((s) => s.id)))
  }, [snap])
}
