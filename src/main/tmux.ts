import type { Exec } from './exec'

export const claudeTmuxName = (sessionId: string): string => `pw-${sessionId}`
export const shellTmuxName = (sessionId: string): string => `pw-${sessionId}-sh`

// Exact-match session target that is also valid where tmux wants a pane.
const pane = (name: string): string => `=${name}:`

export class Tmux {
  private readonly bin: string
  constructor(private readonly o: { socket: string; confPath: string; env: Record<string, string>; exec: Exec; tmuxBin?: string }) {
    this.bin = o.tmuxBin ?? 'tmux'
  }

  private baseArgs(): string[] {
    return ['-L', this.o.socket, '-f', this.o.confPath]
  }

  private run(args: string[], input?: string) {
    return this.o.exec(this.bin, [...this.baseArgs(), ...args], { env: this.o.env, input })
  }

  private async mustRun(args: string[], input?: string) {
    const r = await this.run(args, input)
    if (r.code !== 0) throw new Error(`tmux ${args[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`)
    return r
  }

  async listSessions(): Promise<string[]> {
    const r = await this.run(['list-sessions', '-F', '#{session_name}'])
    if (r.code !== 0) return [] // no server running
    return r.stdout.split('\n').filter(Boolean)
  }

  async hasSession(name: string): Promise<boolean> {
    return (await this.run(['has-session', '-t', `=${name}`])).code === 0
  }

  async newSession(o: { name: string; cwd: string; argv: string[] }): Promise<void> {
    await this.mustRun(['new-session', '-d', '-s', o.name, '-c', o.cwd, '-x', '200', '-y', '50', '--', ...o.argv])
  }

  async killSession(name: string): Promise<void> {
    await this.run(['kill-session', '-t', `=${name}`])
  }

  async capturePane(name: string): Promise<string> {
    return (await this.mustRun(['capture-pane', '-p', '-t', pane(name)])).stdout
  }

  async sendKeys(name: string, keys: string[], literal = false): Promise<void> {
    await this.mustRun(['send-keys', '-t', pane(name), ...(literal ? ['-l'] : []), '--', ...keys])
  }

  async pasteText(name: string, text: string): Promise<void> {
    const buf = `pitwall-${process.pid}-${Date.now()}`
    await this.mustRun(['load-buffer', '-b', buf, '-'], text)
    await this.mustRun(['paste-buffer', '-p', '-d', '-b', buf, '-t', pane(name)])
  }

  /** `-u`: the client always writes UTF-8, whatever LANG/LC_* say (a Finder-launched app has none). */
  attachCommand(name: string): { file: string; args: string[] } {
    return { file: this.bin, args: ['-u', ...this.baseArgs(), 'attach-session', '-t', `=${name}`] }
  }

  async killServer(): Promise<void> {
    await this.run(['kill-server'])
  }
}
