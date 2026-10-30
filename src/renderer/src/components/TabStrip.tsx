import { useUi, type MainTab } from '../state/ui'
import { requestFocus } from '../terminal/termCache'

const basename = (p: string): string => p.split('/').filter(Boolean).pop() ?? p

export default function TabStrip({ sessionId, tabs, active }: {
  sessionId: string; tabs: MainTab[]; active: string
}): React.JSX.Element {
  const setActive = useUi((s) => s.setActiveTab)
  const closeTab = useUi((s) => s.closeTab)
  const dirty = useUi((s) => s.dirty)
  const openDialog = useUi((s) => s.openDialog)
  return (
    <div className="tabstrip" role="tablist">
      {tabs.map((t) => {
        const isTerm = t.id === 'claude' || t.id === 'shell'
        const label = t.id === 'claude' ? 'Claude' : t.id === 'shell' ? 'Shell' : `${'kind' in t && t.kind === 'diff' ? 'Diff · ' : ''}${basename((t as { path: string }).path)}`
        return (
          <div key={t.id} role="tab" aria-selected={t.id === active} data-testid={`tab-${isTerm ? t.id : t.id}`}
            className={`tab${t.id === active ? ' active' : ''}`}
            onClick={() => { if (isTerm) requestFocus(sessionId, t.id as 'claude' | 'shell'); setActive(sessionId, t.id) }}>
            <span className="tab-label">{label}</span>
            {dirty[`${sessionId}:${t.id}`] && <span className="tab-dirty" aria-label="Unsaved changes" />}
            {!isTerm && (
              <button className="tab-close" aria-label={`Close ${label}`}
                onClick={(e) => {
                  e.stopPropagation()
                  if (dirty[`${sessionId}:${t.id}`]) openDialog({ type: 'discard-file', sessionId, tabId: t.id, name: label })
                  else closeTab(sessionId, t.id)
                }}>✕</button>
            )}
          </div>
        )
      })}
    </div>
  )
}
