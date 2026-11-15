import { readFile } from 'node:fs/promises'
import type { LauncherSpec } from '../host/protocol'

export type { LauncherSpec }

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
 * Where agents' terminals live, so they outlive the app: tmux on a private socket (TmuxBackend), or the Pitwall host,
 * a background process that owns them (HostBackend).
 * Names are exact: `pw-a` never matches `pw-a-sh`.
 */
export interface SessionBackend {
  /** Names of the running sessions; [] when there are none (or no server yet). */
  listSessions(): Promise<string[]>
  hasSession(name: string): Promise<boolean>
  /**
   * Starts `argv` (no shell) in `cwd`, with `env` added to the backend's environment. With `launcher` (the host only),
   * the host's launcher runs the session instead (see src/host/launcher.ts).
   */
  newSession(o: NewSessionOptions): Promise<void>
  /** A missing session is ignored. */
  killSession(name: string): Promise<void>
  /** The session's current screen as text. */
  capture(name: string): Promise<string>
  /** `keys` are key names (`Enter`) or text; with `literal`, all of them are text. */
  sendKeys(name: string, keys: string[], literal?: boolean): Promise<void>
  /** Pastes as one paste (bracketed if the program asked for it), never pressing Enter. */
  pasteText(name: string, text: string): Promise<void>
  /**
   * Process ids to snapshot before killing (leftover cleanup); [] where not supported. The host also says when it
   * started each pane (`paneStarts`, ms), so a pane pid reused since can be told apart (Windows).
   */
  processRoots(name: string): Promise<{ serverPid: number | null; panePids: number[]; paneStarts?: number[] }>
  /**
   * Every live pane's first process, by session name, and the server's pid, for resource sampling in one call. Absent
   * where not supported (the host); `serverPid` is null when there is no server.
   */
  listPaneRoots?(): Promise<{ serverPid: number | null; panes: Map<string, number[]> }>
  /** A missing session gives an attachment that exits at once (or a rejection). */
  attach(name: string, cols: number, rows: number, h: AttachHandlers): Promise<Attachment>
  /** Ends every session and the backend's server. Never called on quit: agents must outlive the app. */
  shutdown(): Promise<void>
}

export interface NewSessionOptions {
  name: string
  cwd: string
  argv: string[]
  env?: Record<string, string>
  launcher?: LauncherSpec
}

export type BackendKind = 'tmux' | 'host'

/** tmux unless PITWALL_SESSION_BACKEND=host picks the Pitwall host (src/host). Windows has no tmux: always the host. */
export function sessionBackendKind(
  env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform
): BackendKind {
  if (platform === 'win32') return 'host'
  return env.PITWALL_SESSION_BACKEND === 'host' ? 'host' : 'tmux'
}

/**
 * What starts a session's Claude: resources/bin/pitwall-launch (`script`), or the host's own launcher (`host`,
 * src/host/launcher.ts). Windows has no sh: always the host's. Elsewhere PITWALL_LAUNCHER=host picks it too, with
 * the host backend (to run on macOS what Windows runs).
 */
export type LauncherChoice = 'script' | 'host'

export function launcherChoice(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): LauncherChoice {
  if (platform === 'win32') return 'host'
  return env.PITWALL_LAUNCHER === 'host' && sessionBackendKind(env, platform) === 'host' ? 'host' : 'script'
}

/**
 * Which backend this run uses. Windows: the host. An env override: that. Sessions already running keep the backend
 * recorded for them (never switch a running set between tmux and the host). Otherwise tmux if it is installed, else
 * the host. `record` says to write the choice to backend.json. A recorded tmux with no tmux found still gives tmux:
 * its sessions then fail one by one with tmux's own error instead of being orphaned.
 */
export function chooseBackend(o: {
  env: Record<string, string | undefined>; platform: NodeJS.Platform; tmuxPath: string | null
  recorded: BackendKind | null; liveSessions: number
}): { kind: BackendKind; record: boolean } {
  if (o.platform === 'win32') return { kind: 'host', record: false }
  if (o.env.PITWALL_SESSION_BACKEND === 'host') return { kind: 'host', record: false }
  if (o.env.PITWALL_SESSION_BACKEND === 'tmux') return { kind: 'tmux', record: false }
  if (o.recorded && o.liveSessions > 0) return { kind: o.recorded, record: false }
  if (o.tmuxPath) return { kind: 'tmux', record: true }
  return { kind: 'host', record: true }
}

/** backend.json's `kind`; null when the file is missing, unreadable or says anything else. */
export async function readRecordedBackend(file: string): Promise<BackendKind | null> {
  try {
    const kind = (JSON.parse(await readFile(file, 'utf8')) as { kind?: unknown } | null)?.kind
    return kind === 'tmux' || kind === 'host' ? kind : null
  } catch {
    return null
  }
}
