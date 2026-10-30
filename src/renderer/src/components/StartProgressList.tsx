import type { StartStep } from '@shared/types'
import { isMac } from '../platform'

/** The step that starts the session's terminal is "tmux" inside; only macOS runs tmux. */
export function stepLabel(step: StartStep, mac: boolean = isMac()): string {
  const labels: Record<StartStep, string> = {
    identity: 'Check identity', worktree: 'Create worktree', files: 'Write session files',
    tmux: mac ? 'Start tmux' : 'Start the terminal', claude: 'Start Claude'
  }
  return labels[step]
}
export const STEPS: StartStep[] = ['identity', 'worktree', 'files', 'tmux', 'claude']

export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'warning'
export interface StepInfo { state: StepState; message?: string }

const ICON: Record<StepState, string> = { pending: '○', running: '◌', done: '✓', failed: '✕', warning: '!' }

export default function StartProgressList({ steps, folder }: { steps: Partial<Record<StartStep, StepInfo>>; folder?: boolean }): React.JSX.Element {
  return (
    <ul className="progress-list" data-testid="start-progress">
      {STEPS.filter((s) => !(folder && s === 'worktree' && !steps[s])).map((s) => {
        const info = steps[s] ?? { state: 'pending' as const }
        return (
          <li key={s} className={`progress-step ${info.state}`} data-step={s} data-state={info.state}>
            <span className={`progress-icon${info.state === 'running' ? ' spin' : ''}`} aria-hidden>{ICON[info.state]}</span>
            <span className="progress-label">{stepLabel(s)}</span>
            {info.message && <div className="progress-msg">{info.message}</div>}
          </li>
        )
      })}
    </ul>
  )
}
