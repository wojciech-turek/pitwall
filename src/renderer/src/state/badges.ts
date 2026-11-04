import type { DisplayStatus, PrInfo, SessionView } from '@shared/types'
import { STATUS_LABEL } from '@shared/runtime'

/** The icon a session's status is drawn with: each one has its own shape, so it reads without knowing the colours. */
export type StatusGlyph = 'hand' | 'spinner' | 'check' | 'warning' | 'stopped' | 'starting'
/** Its colour (the --st-* tokens). */
export type StatusTone = 'needs' | 'working' | 'unread' | 'read' | 'exited'
export interface StatusLook { glyph: StatusGlyph; tone: StatusTone; label: string }

export function statusLook(status: DisplayStatus, exitCode?: number): StatusLook {
  const label = STATUS_LABEL[status]
  switch (status) {
    case 'needs_you': return { glyph: 'hand', tone: 'needs', label }
    case 'working': return { glyph: 'spinner', tone: 'working', label }
    case 'unread': return { glyph: 'check', tone: 'unread', label }
    case 'read': return { glyph: 'check', tone: 'read', label }
    case 'starting': return { glyph: 'starting', tone: 'read', label }
    case 'exited':
      // 0: the user quit Claude, nothing went wrong.
      if (exitCode === 0) return { glyph: 'stopped', tone: 'read', label }
      return { glyph: 'warning', tone: 'exited', label: exitCode === undefined ? label : `${label} (code ${exitCode})` }
  }
}

export type PrGlyph = 'open' | 'draft' | 'merged' | 'closed'

export function prGlyph(pr: PrInfo): PrGlyph {
  if (pr.state === 'MERGED') return 'merged'
  if (pr.state === 'CLOSED') return 'closed'
  return pr.draft ? 'draft' : 'open'
}

/** ✓ / ✗ / ○ next to the number: only an open PR's checks matter. */
export function prChecksMark(pr: PrInfo): 'pass' | 'fail' | 'pending' | null {
  if (pr.state !== 'OPEN') return null
  switch (pr.checks) {
    case 'passing': return 'pass'
    case 'failing': return 'fail'
    case 'pending': return 'pending'
    case 'none': return null
  }
}

const PR_LABEL: Record<PrGlyph, string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' }

export function prTooltip(pr: PrInfo): string {
  const checks = prChecksMark(pr) ? ` · checks ${pr.checks}` : ''
  return `PR #${pr.number} · ${PR_LABEL[prGlyph(pr)]}${checks}`
}

/** The row's +/− counts: shown until a PR exists, then the PR chip takes their place. */
export function rowLineCounts(s: Pick<SessionView, 'diffStat' | 'pr'>): SessionView['diffStat'] | null {
  return s.diffStat && !s.pr ? s.diffStat : null
}

/** A merged session is usually finished with: its title fades, unless something in it still wants the user. */
export function rowFaded(s: Pick<SessionView, 'pr' | 'status'>): boolean {
  return s.pr?.state === 'MERGED' && (s.status === 'read' || s.status === 'exited')
}
