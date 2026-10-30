import type { DisplayStatus } from '@shared/types'
import { STATUS_LABEL } from '@shared/runtime'

export default function StatusDot({ status }: { status: DisplayStatus }): React.JSX.Element {
  return <span className={`status-dot st-${status}`} title={STATUS_LABEL[status]} aria-label={STATUS_LABEL[status]} />
}
