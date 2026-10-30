import * as pty from 'node-pty'
import type { TermKind } from '@shared/types'
import { claudeTmuxName, shellTmuxName, type Tmux } from './tmux'

interface Deps {
  tmux: Tmux
  env: Record<string, string>
  ensureTarget: (id: string, kind: TermKind) => Promise<void>
  onData: (id: string, kind: TermKind, data: string) => void
  onExit: (id: string, kind: TermKind, code: number) => void
  onUserInput: (id: string, kind: TermKind, data: string) => void
}

const keyOf = (id: string, kind: TermKind): string => `${id}:${kind}`

/** Embedded terminals: each is a node-pty running `tmux attach` for the session's tmux target. */
export class PtyBridge {
  private ptys = new Map<string, pty.IPty>()
  private opening = new Map<string, number>()

  constructor(private readonly deps: Deps) {}

  async open(id: string, kind: TermKind, cols: number, rows: number): Promise<void> {
    const key = keyOf(id, kind)
    // Latest open() wins if several race through ensureTarget.
    const ticket = (this.opening.get(key) ?? 0) + 1
    this.opening.set(key, ticket)
    await this.deps.ensureTarget(id, kind)
    if (this.opening.get(key) !== ticket) return
    this.kill(key)
    const name = kind === 'claude' ? claudeTmuxName(id) : shellTmuxName(id)
    const attach = this.deps.tmux.attachCommand(name)
    const p = pty.spawn(attach.file, attach.args, {
      name: 'xterm-256color', cols, rows, cwd: this.deps.env.HOME, env: this.deps.env
    })
    this.ptys.set(key, p)
    p.onData((d) => { if (this.ptys.get(key) === p) this.deps.onData(id, kind, d) })
    p.onExit(({ exitCode }) => {
      // A pty we replaced or closed ourselves is no longer registered: stay silent.
      if (this.ptys.get(key) !== p) return
      this.ptys.delete(key)
      this.deps.onExit(id, kind, exitCode)
    })
  }

  write(id: string, kind: TermKind, data: string): void {
    this.ptys.get(keyOf(id, kind))?.write(data)
    this.deps.onUserInput(id, kind, data)
  }

  resize(id: string, kind: TermKind, cols: number, rows: number): void {
    try { this.ptys.get(keyOf(id, kind))?.resize(Math.max(1, cols), Math.max(1, rows)) } catch { /* pty already gone */ }
  }

  close(id: string, kind: TermKind): void {
    const key = keyOf(id, kind)
    this.opening.set(key, (this.opening.get(key) ?? 0) + 1) // cancel an open still waiting on ensureTarget
    this.kill(key)
  }

  closeAll(): void {
    for (const key of [...this.ptys.keys()]) this.kill(key)
  }

  private kill(key: string): void {
    const p = this.ptys.get(key)
    if (!p) return
    this.ptys.delete(key)
    try { p.kill() } catch { /* already exited */ }
  }
}
