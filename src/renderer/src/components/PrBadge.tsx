import type { PrInfo } from '@shared/types'
import { prChecksMark, prGlyph, prTooltip, type PrGlyph } from '../state/badges'
import { CheckMarkIcon, CrossMarkIcon, PendingMarkIcon, PrClosedIcon, PrDraftIcon, PrMergedIcon, PrOpenIcon } from './Icons'

const GLYPH: Record<PrGlyph, () => React.JSX.Element> = { open: PrOpenIcon, draft: PrDraftIcon, merged: PrMergedIcon, closed: PrClosedIcon }
const MARK = { pass: CheckMarkIcon, fail: CrossMarkIcon, pending: PendingMarkIcon }

/** The PR chip: its state's icon, the number, and an open PR's checks. Opens the PR on GitHub. */
export default function PrBadge({ pr }: { pr: PrInfo }): React.JSX.Element {
  const glyph = prGlyph(pr)
  const mark = prChecksMark(pr)
  const Glyph = GLYPH[glyph]
  const Mark = mark ? MARK[mark] : null
  return (
    <button className="pr-badge" data-testid="pr-badge" data-state={pr.state} data-glyph={glyph} data-checks={pr.checks}
      title={prTooltip(pr)} aria-label={prTooltip(pr)}
      onClick={(e) => { e.stopPropagation(); void window.pitwall.openExternal(pr.url) }}
      onDoubleClick={(e) => e.stopPropagation()}>
      <span className={`pr-glyph prg-${glyph}`}><Glyph /></span>
      #{pr.number}
      {Mark && <span className={`pr-mark mark-${mark}`}><Mark /></span>}
    </button>
  )
}
