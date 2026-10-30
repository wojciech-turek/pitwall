import { Component, type ErrorInfo, type ReactNode } from 'react'

/** Last line of defence: a render error shows what broke and a way back, instead of a blank window. */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[pitwall] render error:', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash" role="alert" data-testid="error-boundary">
        <h1>Something went wrong</h1>
        <p>Your agents are still running in tmux. Reloading the window reattaches them.</p>
        <pre>{error.stack ?? error.message}</pre>
        <button className="btn primary" data-testid="error-reload" onClick={() => location.reload()}>Reload</button>
      </div>
    )
  }
}
