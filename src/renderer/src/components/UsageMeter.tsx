import { useEffect, useState } from 'react'
import type { UsageWindow } from '@shared/types'
import { usageRow, useUsage } from '../state/usage'
import { relativeTime } from './HoverCard'

function Row({ label, name, testId, window: w, now }: {
  label: string; name: string; testId: string; window: UsageWindow | undefined; now: number
}): React.JSX.Element {
  const r = usageRow(w, now)
  return (
    <div className="usage-row" data-testid={testId} data-level={r.level}>
      <span className="usage-label">{label}</span>
      <span className="usage-bar" role="meter" aria-label={`${name} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={r.percent}>
        <span className="usage-fill" style={{ width: `${r.percent}%` }} />
      </span>
      <span className="usage-pct">{r.pct}</span>
      <span className="usage-reset">{r.reset}</span>
    </div>
  )
}

/** Claude subscription usage (5-hour and weekly windows), from the status line of Pitwall's sessions. */
export default function UsageMeter(): React.JSX.Element {
  const usage = useUsage()
  // Re-render each minute: reset times pass and "updated … ago" ages without new data.
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])
  if (!usage) {
    return <div className="usage-meter empty" data-testid="usage-meter">Usage shows after Claude's next reply</div>
  }
  const now = Date.now()
  return (
    <div className="usage-meter" data-testid="usage-meter" title={`Claude usage · updated ${relativeTime(usage.updatedAt, now)}`}>
      <Row label="5h" name="5-hour" testId="usage-5h" window={usage.fiveHour} now={now} />
      <Row label="Week" name="Weekly" testId="usage-week" window={usage.sevenDay} now={now} />
    </div>
  )
}
