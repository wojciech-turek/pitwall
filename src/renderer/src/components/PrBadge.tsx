import type { PrInfo } from '@shared/types'

const STATE_LABEL = { OPEN: 'Open', CLOSED: 'Closed', MERGED: 'Merged' } as const

export function prTooltip(pr: PrInfo): string {
  const checks = pr.state === 'OPEN' && pr.checks !== 'none' ? ` · checks ${pr.checks}` : ''
  return `PR #${pr.number} · ${STATE_LABEL[pr.state]}${checks}`
}

export function prColor(pr: PrInfo): string {
  if (pr.state === 'MERGED') return '#a371f7'
  if (pr.state === 'CLOSED') return 'var(--text-faint)'
  if (pr.checks === 'failing') return 'var(--st-exited)'
  if (pr.checks === 'pending') return 'var(--st-needs)'
  return 'var(--text-muted)'
}

export default function PrBadge({ pr }: { pr: PrInfo }): React.JSX.Element {
  return (
    <button className="pr-badge" data-testid="pr-badge" data-state={pr.state} data-checks={pr.checks}
      style={{ color: prColor(pr) }} title={prTooltip(pr)}
      onClick={(e) => { e.stopPropagation(); void window.pitwall.openExternal(pr.url) }}
      onDoubleClick={(e) => e.stopPropagation()}>
      #{pr.number}
    </button>
  )
}
