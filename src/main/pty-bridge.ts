import type { TermKind } from '@shared/types'
import type { Attachment, SessionBackend } from './backend'
import { claudeTmuxName, shellTmuxName } from './tmux'

/** Characters typed into a terminal that is still attaching, kept for it (the excess is dropped). */
export const MAX_TYPED = 1024 * 1024

interface Deps {
  backend: SessionBackend
  ensureTarget: (id: string, kind: TermKind) => Promise<void>
  onData: (id: string, kind: TermKind, data: string) => void
  onExit: (id: string, kind: TermKind, code: number) => void
  onUserInput: (id: string, kind: TermKind, data: string) => void
}

/**
 * An open terminal; `a` is missing while the backend is still attaching. Meanwhile `typed` and `size` keep what the
 * renderer sent (as a `tmux attach` pty would), for when it arrives.
 */
interface Term { a?: Attachment; typed?: string; overflowed?: boolean; size?: { cols: number; rows: number } }

const keyOf = (id: string, kind: TermKind): string => `${id}:${kind}`

/** Embedded terminals: each is the backend's attachment to the session's target (with tmux, a node-pty running `tmux attach`). */
export class PtyBridge {
  private terms = new Map<string, Term>()
  private opening = new Map<string, number>()
  private disposed = false

  constructor(private readonly deps: Deps) {}

  async open(id: string, kind: TermKind, cols: number, rows: number): Promise<void> {
    if (this.disposed) return
    const key = keyOf(id, kind)
    // Latest open() wins if several race through ensureTarget.
    const ticket = (this.opening.get(key) ?? 0) + 1
    this.opening.set(key, ticket)
    await this.deps.ensureTarget(id, kind)
    // The app may have started quitting while we waited. A pty spawned now can hang the quit for good: its
    // spawn-helper blocks on a terminal nobody will open, and node-pty's exit handler waits on it forever.
    // (TmuxBackend spawns as soon as attach() is called, so this check still holds at the spawn.)
    if (this.disposed || this.opening.get(key) !== ticket) return
    this.kill(key)
    const name = kind === 'claude' ? claudeTmuxName(id) : shellTmuxName(id)
    // Registered before attaching, so closing it meanwhile (or replacing it) is seen once attach() returns.
    const term: Term = {}
    this.terms.set(key, term)
    const live = (): boolean => this.terms.get(key) === term
    let a: Attachment
    try {
      a = await this.deps.backend.attach(name, cols, rows, {
        onData: (d) => { if (live()) this.deps.onData(id, kind, d) },
        onExit: (code) => {
          // A terminal we replaced or closed ourselves is no longer registered: stay silent.
          if (!live()) return
          this.terms.delete(key)
          this.deps.onExit(id, kind, code)
        }
      })
    } catch (e) {
      if (live()) this.terms.delete(key)
      throw e
    }
    if (!live()) {
      a.close() // closed, replaced or ended while attaching
      return
    }
    term.a = a
    if (term.size) this.applySize(a, term.size.cols, term.size.rows)
    if (term.typed) a.write(term.typed)
    delete term.size
    delete term.typed
  }

  write(id: string, kind: TermKind, data: string): void {
    const t = this.terms.get(keyOf(id, kind))
    if (t?.a) t.a.write(data)
    else if (t) {
      // Kept until the attachment arrives (a host can take seconds to start), up to MAX_TYPED: a paste beyond that
      // is dropped (and logged) rather than held without bound.
      const typed = (t.typed ?? '') + data
      if (typed.length > MAX_TYPED && !t.overflowed) {
        t.overflowed = true // once per attach, not per keystroke
        console.warn(`[pitwall] input typed into ${keyOf(id, kind)} while it was attaching passed ${MAX_TYPED} characters: the rest is dropped`)
      }
      let end = Math.min(typed.length, MAX_TYPED)
      const last = typed.charCodeAt(end - 1)
      if (end < typed.length && last >= 0xd800 && last <= 0xdbff) end-- // don't cut a surrogate pair in two
      t.typed = typed.slice(0, end)
    }
    this.deps.onUserInput(id, kind, data)
  }

  resize(id: string, kind: TermKind, cols: number, rows: number): void {
    const t = this.terms.get(keyOf(id, kind))
    if (t?.a) this.applySize(t.a, cols, rows)
    else if (t) t.size = { cols, rows }
  }

  close(id: string, kind: TermKind): void {
    const key = keyOf(id, kind)
    this.opening.set(key, (this.opening.get(key) ?? 0) + 1) // cancel an open still waiting on ensureTarget
    this.kill(key)
  }

  /**
   * Closes the terminal and tells the renderer it ended, so it offers "press any key to reattach" (which opens it
   * again, relaunching the tmux session if it's gone). For when we closed it and the session carries on.
   */
  detach(id: string, kind: TermKind): void {
    this.close(id, kind)
    this.deps.onExit(id, kind, 0)
  }

  closeAll(): void {
    for (const key of this.opening.keys()) this.opening.set(key, (this.opening.get(key) ?? 0) + 1)
    for (const key of [...this.terms.keys()]) this.kill(key)
  }

  /** On quit: close every terminal and never open another (see open). */
  dispose(): void {
    this.disposed = true
    this.closeAll()
  }

  private applySize(a: Attachment, cols: number, rows: number): void {
    try { a.resize(Math.max(1, cols), Math.max(1, rows)) } catch { /* pty already gone */ }
  }

  private kill(key: string): void {
    const t = this.terms.get(key)
    if (!t) return
    this.terms.delete(key)
    t.a?.close()
  }
}
