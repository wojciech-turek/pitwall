import * as pty from 'node-pty'
import type { Attachment, AttachHandlers, SessionBackend } from './backend'
import type { Tmux } from './tmux'

/** Sessions in tmux on Pitwall's private socket; an attached terminal is a node-pty running `tmux attach`. */
export class TmuxBackend implements SessionBackend {
  /** `env` is the attach client's environment; its HOME is the client's cwd. */
  constructor(private readonly tmux: Tmux, private readonly env: Record<string, string>) {}

  listSessions(): Promise<string[]> {
    return this.tmux.listSessions()
  }

  hasSession(name: string): Promise<boolean> {
    return this.tmux.hasSession(name)
  }

  newSession(o: { name: string; cwd: string; argv: string[]; env?: Record<string, string> }): Promise<void> {
    return this.tmux.newSession(o)
  }

  killSession(name: string): Promise<void> {
    return this.tmux.killSession(name)
  }

  capture(name: string): Promise<string> {
    return this.tmux.capturePane(name)
  }

  sendKeys(name: string, keys: string[], literal = false): Promise<void> {
    return this.tmux.sendKeys(name, keys, literal)
  }

  pasteText(name: string, text: string): Promise<void> {
    return this.tmux.pasteText(name, text)
  }

  processRoots(name: string): Promise<{ serverPid: number | null; panePids: number[] }> {
    return this.tmux.listPanePids(name)
  }

  /** Spawns before returning (no await first), so a caller's last check before calling still holds at the spawn. */
  async attach(name: string, cols: number, rows: number, h: AttachHandlers): Promise<Attachment> {
    const cmd = this.tmux.attachCommand(name)
    const p = pty.spawn(cmd.file, cmd.args, { name: 'xterm-256color', cols, rows, cwd: this.env.HOME, env: this.env })
    let closed = false
    p.onData((d) => { if (!closed) h.onData(d) })
    p.onExit(({ exitCode }) => { if (!closed) h.onExit(exitCode) })
    return {
      write: (data) => p.write(data),
      resize: (c, r) => p.resize(c, r),
      close: () => {
        if (closed) return
        closed = true
        try { p.kill() } catch { /* already exited */ }
      }
    }
  }

  async shutdown(): Promise<void> {
    await this.tmux.killServer()
  }
}
