import type { StartStep } from '@shared/types'

export const STEP_LABEL: Record<StartStep, string> = {
  identity: 'Check identity', worktree: 'Create worktree', files: 'Write session files', tmux: 'Start tmux', claude: 'Start Claude'
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
            <span className="progress-label">{STEP_LABEL[s]}</span>
            {info.message && <div className="progress-msg">{info.message}</div>}
          </li>
        )
      })}
    </ul>
  )
}
