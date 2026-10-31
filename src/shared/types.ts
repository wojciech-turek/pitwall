export interface GitIdentity { sshKeyPath: string; ghAccount: string; gitName: string; gitEmail: string }
export interface EnvVar { key: string; value: string }
export interface Project { id: string; name: string; identity: GitIdentity; extraEnv: EnvVar[]; createdAt: number
  /** No macOS notifications and no Dock badge from this project's sessions. */
  muted?: boolean
}
export type SubProjectKind = 'repo' | 'folder'
export interface SubProject {
  id: string; projectId: string; name: string; path: string; kind: SubProjectKind
  repoRoot?: string; relPath?: string; setupCommand?: string; teardownCommand?: string; createdAt: number
}
export type PrState = 'OPEN' | 'CLOSED' | 'MERGED'
export type ChecksState = 'passing' | 'failing' | 'pending' | 'none'
export interface PrInfo { number: number; url: string; title: string; state: PrState; checks: ChecksState; updatedAt: number }
export interface Session {
  id: string; subProjectId: string; title: string; slug: string; claudeSessionId: string; cwd: string
  worktreePath?: string; branch?: string; branchCreatedByPitwall: boolean; baseBranch?: string; baseCommit?: string
  createdAt: number; lastViewedAt: number; archivedAt?: number; lastMessage?: string; pr?: PrInfo
  /** Set by "Mark as unread"; cleared when the user opens the session. */
  markedUnread?: boolean
  /** Earlier Claude conversation ids (before a /clear), oldest first; searched with the current one. */
  pastClaudeIds?: string[]
  /** Archiving deleted the session's branch: resuming makes a new one rather than use another branch of that name. */
  branchDeleted?: boolean
}
export interface AppSettings {
  monoFont: string; monoFontSize: number
  /** Look for newer releases on GitHub, about once a day. */
  checkForUpdates: boolean
}
export const DEFAULT_SETTINGS: AppSettings = {
  monoFont: '"SF Mono","JetBrains Mono",Menlo,monospace',
  monoFontSize: 13,
  checkForUpdates: true
}
export interface PersistedState {
  version: 1; projects: Project[]; subProjects: SubProject[]; sessions: Session[]; settings: AppSettings
}
export interface HookEvent {
  c: string; t: number; e: string; sid?: string | null; tool?: string | null; nt?: string | null
  src?: string | null; reason?: string | null; msg?: string | null; err?: string | null; code?: number | null; mode?: string | null
  /** pitwall:warning: what the warning is about (one banner per kind). */
  kind?: string | null
}
export type Activity = 'starting' | 'idle' | 'working' | 'needs_input' | 'exited'
export type NeedsInputReason = 'permission' | 'question' | 'other'
export interface SessionRuntime {
  activity: Activity; needsInput?: NeedsInputReason; claudeSessionId?: string
  firstEventSeen: boolean; lastEventAt?: number; lastFinishedAt?: number; lastMessage?: string; lastError?: string; exitCode?: number
  /** What the launcher warned about since Claude last started, by kind (pitwall:warning). */
  warnings?: Record<string, string>
}
export type DisplayStatus = 'starting' | 'working' | 'needs_you' | 'unread' | 'read' | 'exited'
export interface ChangedFile { path: string; status: 'M' | 'A' | 'D' | '?'; additions: number; deletions: number; binary: boolean }
export type TermKind = 'claude' | 'shell'
export interface FileEntry { path: string; status?: 'M' | 'A' | 'D' | '?' }
export type FileContent =
  | { kind: 'text'; content: string; mtimeMs: number }
  | { kind: 'binary' }
  | { kind: 'too_large'; size: number }
export interface SessionView extends Session {
  status: DisplayStatus; needsInput?: NeedsInputReason; lastError?: string
  diffStat?: { additions: number; deletions: number }; liveBranch?: string; startWarning?: string
  lastActivityAt?: number
  /** The launcher's warnings for this run of Claude (a terminal repaint can wipe its printed lines). */
  launchWarnings?: string[]
}
export interface AppSnapshot {
  projects: Project[]; subProjects: SubProject[]; sessions: SessionView[]; archived: Session[]; settings: AppSettings
}
export interface GhAccount { login: string; active: boolean; ok: boolean }
/** One Claude subscription limit window, from Claude Code's status line. */
export interface UsageWindow { usedPercentage: number; /** ms */ resetsAt: number }
export interface ClaudeUsage { fiveHour?: UsageWindow; sevenDay?: UsageWindow; /** When Claude reported it (ms). */ updatedAt: number }
export interface RepoIdentity { sshCommand?: string; name?: string; email?: string }
/** A published release. `notes` is untrusted Markdown from GitHub: never render it as HTML. */
export interface ReleaseInfo { version: string; name: string; notes: string; url: string; publishedAt: number }
export interface UpdateState { current: string; checkedAt: number | null; newer: ReleaseInfo[] /* newest first, strictly newer than current */ }

export type StartStep = 'identity' | 'worktree' | 'files' | 'tmux' | 'claude'
export interface StartProgress { requestId: string; step: StartStep; state: 'running' | 'done' | 'failed' | 'warning'; message?: string }
export interface NewSessionInput {
  requestId: string; subProjectId: string; title: string; branchMode: 'new' | 'existing'; branch: string; baseBranch?: string
}
export type StartResult = { ok: true; sessionId: string } | { ok: false; step: StartStep; error: string }
export interface NewSessionDefaults {
  kind: SubProjectKind; hasCommits: boolean
  /** Suggested base for a new branch: the repo's main branch. */
  baseBranch: string | null
  /** The repo's main branch; never offered as an existing branch, so it stays free to check out elsewhere. */
  defaultBranch: string | null
  branches: { name: string; checkedOutAt?: string }[]
}

/** A session whose title or Claude conversation matches a search. */
export interface HistoryHit {
  sessionId: string; title: string; archived: boolean; projectName: string; subProjectName: string
  matchedIn: 'title' | 'conversation'
  /** About 60 characters either side of the first match in the conversation ('' if none). */
  snippet: string
  /** Latest event of a running session, or when it was archived (ms). */
  updatedAt: number
}

export interface ArchiveCheck {
  uncommittedFiles: number; unpushedCommits: number; hasRemote: boolean; branch?: string
  willDeleteBranch: boolean; willRemoveWorktree: boolean; worktreePath?: string
}
export type ArchiveResult =
  /** leftFolder: archived, but files in use kept the worktree's folder from being deleted (Windows); delete it later. */
  | { ok: true; leftFolder?: string }
  | { ok: false; needsConfirm: ArchiveCheck }
  | { ok: false; teardownFailed: { exitCode: number | null; timedOut: boolean; output: string } }
  | { ok: false; error: string }
