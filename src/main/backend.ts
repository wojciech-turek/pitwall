/** Callbacks for one attached terminal. Neither is called after the attachment is closed. */
export interface AttachHandlers {
  onData(data: string): void
  onExit(code: number): void
}

/** A live view of a session's terminal. Closing it detaches only: the session keeps running. */
export interface Attachment {
  write(data: string): void
  resize(cols: number, rows: number): void
  /** Idempotent; never throws. */
  close(): void
}

/**
 * Where agents' terminals live, so they outlive the app: tmux on a private socket today (TmuxBackend).
 * Names are exact: `pw-a` never matches `pw-a-sh`.
 */
export interface SessionBackend {
  /** Names of the running sessions; [] when there are none (or no server yet). */
  listSessions(): Promise<string[]>
  hasSession(name: string): Promise<boolean>
  /** Starts `argv` (no shell) in `cwd`, with `env` added to the backend's environment. */
  newSession(o: { name: string; cwd: string; argv: string[]; env?: Record<string, string> }): Promise<void>
  /** A missing session is ignored. */
  killSession(name: string): Promise<void>
  /** The session's current screen as text. */
  capture(name: string): Promise<string>
  /** `keys` are key names (`Enter`) or text; with `literal`, all of them are text. */
  sendKeys(name: string, keys: string[], literal?: boolean): Promise<void>
  /** Pastes as one paste (bracketed if the program asked for it), never pressing Enter. */
  pasteText(name: string, text: string): Promise<void>
  /** Process ids to snapshot before killing (leftover cleanup); [] where not supported. */
  processRoots(name: string): Promise<{ serverPid: number | null; panePids: number[] }>
  /** A missing session gives an attachment that exits at once (or a rejection). */
  attach(name: string, cols: number, rows: number, h: AttachHandlers): Promise<Attachment>
  /** Ends every session and the backend's server. Never called on quit: agents must outlive the app. */
  shutdown(): Promise<void>
}
