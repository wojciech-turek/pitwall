import { useEffect, useState } from 'react'
import type { DisplayStatus, SessionView, SubagentRun } from '@shared/types'
import StatusIcon from './StatusIcon'
import { useSubagentsOpen } from '../state/subagentsOpen'

/** Reuses the session icons: the hand, the spinner and the check. */
function runStatus(r: SubagentRun): DisplayStatus {
  return r.needsYou ? 'needs_you' : r.state === 'running' ? 'working' : 'read'
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

function tooltip(r: SubagentRun): string | undefined {
  return r.state === 'running' ? r.lastTool : r.lastMessage?.slice(0, 300)
}

/** The session's subagent runs, one row each, under its row. */
export default function SubagentRows({ session, onSelect }: {
  session: SessionView; onSelect: (id: string) => void
}): React.JSX.Element | null {
  const open = useSubagentsOpen(session.id)
  const runs = session.subagents ?? []
  const anyRunning = runs.some((r) => r.state === 'running')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!anyRunning) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [anyRunning])

  if (!open || runs.length === 0) return null
  return (
    <>
      {runs.map((r) => (
        <div key={r.id} className="row subagent-row" data-testid="subagent-row" data-state={r.state}
          title={tooltip(r)} onClick={() => onSelect(session.id)}>
          <StatusIcon status={runStatus(r)} />
          <span className="row-title">{r.description ? `${r.type} · ${r.description}` : r.type}</span>
          {r.state === 'running' && <span className="subagent-elapsed" data-testid="subagent-elapsed">{elapsed(now - r.startedAt)}</span>}
        </div>
      ))}
    </>
  )
}
