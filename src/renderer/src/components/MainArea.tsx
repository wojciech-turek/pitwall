import { useEffect } from 'react'
import type { AppSnapshot } from '@shared/types'
import { effectiveTab, showsServerTab, useUi, withServerTab } from '../state/ui'
import SessionHeader from './SessionHeader'
import TabStrip from './TabStrip'
import DiffView from './DiffView'
import FileEditor from './FileEditor'
import ServerBar from './ServerBar'
import TerminalView from './TerminalView'
import { pruneTerminals } from '../terminal/termCache'

export default function MainArea({ snap, sessionId, paneId, multi }: {
  snap: AppSnapshot; sessionId: string; paneId: string; multi: boolean
}): React.JSX.Element | null {
  const closePane = useUi((s) => s.closePane)
  const stored = useUi((s) => s.tabs[sessionId])
  const active = useUi((s) => s.activeTab[sessionId] ?? 'claude')
  const session = snap.sessions.find((s) => s.id === sessionId)
  if (!session || !stored) return null
  const sub = snap.subProjects.find((s) => s.id === session.subProjectId)
  const tabs = withServerTab(stored, showsServerTab(sub?.devCommand))
  // An active Server tab that isn't shown (no dev command) reads as Claude; nothing is written to the store.
  const activeTab = tabs.find((t) => t.id === effectiveTab(active, tabs))!
  return (
    <div className="main-area">
      <SessionHeader session={session} subProject={sub} multi={multi} onClose={() => closePane(paneId)} />
      <TabStrip sessionId={sessionId} tabs={tabs} active={activeTab.id} serverRunning={!!session.server?.running} />
      <div className="tab-body">
        {activeTab.id === 'server' ? (
          <div className="server-pane">
            <ServerBar ports={session.server?.ports ?? []} />
            <TerminalView key={`${sessionId}:server`} sessionId={sessionId} kind="server"
              fontFamily={snap.settings.monoFont} fontSize={snap.settings.monoFontSize} />
          </div>
        ) : (activeTab.id === 'claude' || activeTab.id === 'shell') && (
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
