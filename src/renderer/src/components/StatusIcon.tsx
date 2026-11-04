import type { DisplayStatus } from '@shared/types'
import { statusLook, type StatusGlyph } from '../state/badges'
import { CheckCircleIcon, HandIcon, SpinnerIcon, StartingIcon, StoppedIcon, WarningIcon } from './Icons'

const GLYPH: Record<StatusGlyph, () => React.JSX.Element> = {
  hand: HandIcon, spinner: SpinnerIcon, check: CheckCircleIcon, warning: WarningIcon, stopped: StoppedIcon, starting: StartingIcon
}

export default function StatusIcon({ status, exitCode }: { status: DisplayStatus; exitCode?: number }): React.JSX.Element {
  const look = statusLook(status, exitCode)
  const Glyph = GLYPH[look.glyph]
  return (
    <span className={`status-icon tone-${look.tone}`} data-testid="status-icon" data-glyph={look.glyph}
      title={look.label} aria-label={look.label} role="img">
      <Glyph />
    </span>
  )
}
