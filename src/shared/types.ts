export interface GitIdentity { sshKeyPath: string; ghAccount: string; gitName: string; gitEmail: string }
export interface EnvVar { key: string; value: string }
export interface Project { id: string; name: string; identity: GitIdentity; extraEnv: EnvVar[]; createdAt: number
  /** No macOS notifications and no Dock badge from this project's sessions. */
  muted?: boolean
}
export type SubProjectKind = 'repo' | 'folder'
export interface SubProject {
  id: string; projectId: string; name: string; path: string; kind: SubProjectKind
  repoRoot?: string; relPath?: string; setupCommand?: string; teardownCommand?: string
  /** Starts the folder's dev server in a session's Server tab. */
  devCommand?: string; createdAt: number
}
export type PrState = 'OPEN' | 'CLOSED' | 'MERGED'
export type ChecksState = 'passing' | 'failing' | 'pending' | 'none'
export interface PrInfo {
  number: number; url: string; title: string; state: PrState; checks: ChecksState; updatedAt: number
  /** Opened as a draft and not yet marked ready for review. */
  draft?: boolean
  /** Checks that failed, by name (at most 10), with a link to each when GitHub gave one. */
  failing?: { name: string; url?: string }[]
  /** Review threads still open on the current diff; set only while the PR is open. */
  openThreads?: number
}
/** An unresolved, current review thread on a PR (each body cut to 2000 characters). */
export interface ReviewThread { path: string; line: number | null; comments: { author: string; body: string }[] }
export interface Session {
  id: string; subProjectId: string; title: string; slug: string; claudeSessionId: string; cwd: string
  worktreePath?: string; branch?: string; branchCreatedByPitwall: boolean; baseBranch?: string; baseCommit?: string
  createdAt: number; lastViewedAt: number; archivedAt?: number; lastMessage?: string; pr?: PrInfo
  /** Set by "Mark as unread"; cleared when the user opens the session. */
  markedUnread?: boolean
  /** Pinned by the user: listed first in its folder. */
  pinned?: boolean
  /** Earlier Claude conversation ids (before a /clear), oldest first; searched with the current one. */
  pastClaudeIds?: string[]
  /** Archiving deleted the session's branch: resuming makes a new one rather than use another branch of that name. */
  branchDeleted?: boolean
  /**
   * The folder its Claude conversation began in, when that was run outside Pitwall and continued here. Every launch
   * then has Claude rebuild its system prompt for this session's folder, with a note (continue-note.txt).
   */
  continuedFrom?: string
  /** The first of the session's block of 10 ports, exported as $PITWALL_PORT. */
  portBase?: number
  /** When Pitwall will type "continue" (ms): the limit Claude stopped at resets then. */
  continueAt?: number
  /** The id of the session that started this one with the `pitwall` command. */
  createdBy?: string
  /** The Claude account (a ClaudeAccount id) this session runs on; absent means the default one. */
  account?: string
  /** The account this session moves to once it is idle. */
  moveTo?: string
  /** Just moved from this account and restarted, not yet seen to start on the new one (moved-from is in its folder). */
  movedFrom?: string
}
/** A Claude account added in Pitwall: its own config folder, which Claude Code keeps the login for. */
export interface ClaudeAccount { id: string; dir: string; addedAt: number }
export interface AppSettings {
  monoFont: string; monoFontSize: number
  /** Look for newer releases on GitHub, about once a day. */
  checkForUpdates: boolean
  /** Tell agents about the `pitwall` command (so they start helper sessions with it). Not offered on Windows. */
  agentCli: boolean
  /** Claude accounts added in Pitwall (the default one is never listed here). */
  claudeAccounts?: ClaudeAccount[]
  /** The account new sessions start on; absent means the default one. */
  activeAccount?: string
}
export const DEFAULT_SETTINGS: AppSettings = {
  monoFont: '"SF Mono","JetBrains Mono",Menlo,monospace',
  monoFontSize: 13,
  checkForUpdates: true,
  agentCli: true
}
export interface PersistedState {
  version: 1; projects: Project[]; subProjects: SubProject[]; sessions: Session[]; settings: AppSettings
}
export interface HookEvent {
  c: string; t: number; e: string; sid?: string | null; tool?: string | null; nt?: string | null
  src?: string | null; reason?: string | null; msg?: string | null; err?: string | null; code?: number | null; mode?: string | null
  /** pitwall:warning: what the warning is about (one banner per kind). */
  kind?: string | null
  /** Subagent id and type: on SubagentStart/Stop, and on tool events fired inside a subagent. */
  aid?: string | null; at?: string | null
  /** PreToolUse of the Agent tool: the task description, up to 120 characters. */
  desc?: string | null
}
export type Activity = 'starting' | 'idle' | 'working' | 'needs_input' | 'exited'
export type NeedsInputReason = 'permission' | 'question' | 'other'
/** One run of a subagent, kept so the sidebar can list what a session's helpers are doing. */
export interface SubagentRun {
  id: string; type: string; description?: string; state: 'running' | 'done'; startedAt: number; endedAt?: number
  lastTool?: string; needsYou?: boolean; lastMessage?: string
}
export interface SessionRuntime {
  activity: Activity; needsInput?: NeedsInputReason; claudeSessionId?: string
  firstEventSeen: boolean; lastEventAt?: number; lastFinishedAt?: number; lastMessage?: string; lastError?: string; exitCode?: number
  /** What the launcher warned about since Claude last started, by kind (pitwall:warning). */
  warnings?: Record<string, string>
  /** What the session was doing before a subagent needed the user; restored once that is answered. */
  resumeActivity?: Activity
  /** Claude stopped its last turn at a usage limit. */
  limitHit?: boolean
  /** The newest subagent runs, oldest first. */
  subagents?: SubagentRun[]
  /** Agent-tool descriptions waiting for their SubagentStart, oldest first, at most 20. */
  agentDescs?: string[]
  /** The launcher passed Claude a first prompt that it hasn't submitted yet (pitwall:prompt-pending). */
  promptPending?: boolean
  /** When Claude last took a prompt (UserPromptSubmit). */
  lastPromptAt?: number
}
export type DisplayStatus = 'starting' | 'working' | 'needs_you' | 'unread' | 'read' | 'exited'
export interface ChangedFile { path: string; status: 'M' | 'A' | 'D' | '?'; additions: number; deletions: number; binary: boolean }
export type TermKind = 'claude' | 'shell' | 'server'
export interface FileEntry { path: string; status?: 'M' | 'A' | 'D' | '?' }
export type FileContent =
  | { kind: 'text'; content: string; mtimeMs: number }
  | { kind: 'binary' }
  | { kind: 'too_large'; size: number }
export interface SessionView extends Session {
  status: DisplayStatus; needsInput?: NeedsInputReason; lastError?: string
  /** How Claude last exited, while the session shows as exited (0: the user quit it). */
  exitCode?: number
  diffStat?: { additions: number; deletions: number }; liveBranch?: string; startWarning?: string
  lastActivityAt?: number
  /** The config folder of the Claude account this session runs on. */
  account?: string
  /** That account's id ('default' for the default one); absent when the session's project sets its own. */
  accountId?: string
  /** The session's project sets CLAUDE_CONFIG_DIR itself, so the session can't be moved. */
  accountPinned?: boolean
  /** Moved a minute ago and still not started on the new account: Claude is at a prompt there (a sign-in, the folder trust). */
  moveWaiting?: boolean
  /** The Server tab's dev server: whether it runs and the ports it listens on. Absent when the folder has no dev command. */
  server?: { running: boolean; ports: number[] }
  /** The launcher's warnings for this run of Claude (a terminal repaint can wipe its printed lines). */
  launchWarnings?: string[]
  /** Claude stopped its last turn at a usage limit. */
  limitHit?: boolean
  /** The session's subagent runs (oldest first). */
  subagents?: SubagentRun[]
}
export interface AppSnapshot {
  projects: Project[]; subProjects: SubProject[]; sessions: SessionView[]; archived: Session[]; settings: AppSettings
}
export interface GhAccount { login: string; active: boolean; ok: boolean }
/** One Claude subscription limit window, from Claude Code's status line. */
export interface UsageWindow { usedPercentage: number; /** ms */ resetsAt: number }
/** One Claude account's usage: `account` is its config folder, `label` its email or folder for display. */
export interface AccountUsage { account: string; label: string; usage: ClaudeUsage }
/**
 * One Claude account as the switch lists it. `account` is its config folder. `id` is what to switch or move to
 * ('default' for the default one); a folder a project sets for itself has none. `sessions` counts the live sessions
 * running on it or waiting to move to it.
 */
export interface AccountView {
  id?: string; account: string; label: string; active: boolean; usage?: ClaudeUsage; sessions: number; signedIn: boolean
}
export interface ClaudeUsage { fiveHour?: UsageWindow; sevenDay?: UsageWindow; /** When Claude reported it (ms). */ updatedAt: number }
/** What a group of processes costs. `cpu` is `ps %cpu` summed, so 100 is one core. */
export interface ProcStats { cpu: number; rssBytes: number; procs: number }
/** What Pitwall, each session and the Mac are spending, sampled every few seconds. Keys of `sessions` are session ids. */
export interface SystemStats {
  at: number
  pressure: 'normal' | 'warn' | 'critical'
  swapUsedBytes: number
  memTotalBytes: number
  diskFreeBytes: number
  diskTotalBytes: number
  pitwall: ProcStats
  sessions: Record<string, ProcStats>
}
export interface RepoIdentity { sshCommand?: string; name?: string; email?: string }
/** A published release. `notes` is untrusted Markdown from GitHub: never render it as HTML. */
export interface ReleaseInfo { version: string; name: string; notes: string; url: string; publishedAt: number }
export interface UpdateState { current: string; checkedAt: number | null; newer: ReleaseInfo[] /* newest first, strictly newer than current */ }

export type StartStep = 'identity' | 'worktree' | 'files' | 'tmux' | 'claude'
export interface StartProgress { requestId: string; step: StartStep; state: 'running' | 'done' | 'failed' | 'warning'; message?: string }
export interface NewSessionInput {
  requestId: string; subProjectId: string; title: string; branchMode: 'new' | 'existing'; branch: string; baseBranch?: string
  /**
   * Continue this Claude conversation (run outside Pitwall) rather than start one, and the folder it began in. Only
   * continueConversation sets these, after checking them; the renderer's startSession never passes them on.
   */
  continueClaudeId?: string
  continuedFrom?: string
  /** Set only by the command server, for a session started by another session (never by the renderer). */
  createdBy?: string
  initialPrompt?: string
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

/** A Claude conversation run in a folder outside Pitwall (with plain `claude`), found from its transcript. */
export interface OutsideConversation {
  /** Claude's conversation id: the transcript's file name without `.jsonl`. */
  claudeId: string
  /** The name given with /rename, else Claude's own title, else the first message typed; one line, ≤ 120 characters. */
  title: string
  /** The folder the conversation was started in, as recorded in the transcript. */
  cwd: string
  /** The git branch recorded last; absent if none was, or if it was a detached HEAD. */
  branch?: string
  /** The transcript's mtime (ms). */
  updatedAt: number
  transcriptPath: string
}

/** A row of "Continue a conversation": an archived Pitwall session of the folder, or a conversation run outside Pitwall. */
export interface ConversationItem {
  kind: 'archived' | 'outside'
  /** archived: the Pitwall session's id; outside: the Claude conversation's id. */
  id: string
  title: string
  /** archived: when it was archived (else created); outside: the transcript's mtime (ms). */
  updatedAt: number
  branch?: string
  /** outside only: used in the last 5 minutes, so it may still be open in a terminal. */
  recentlyActive?: boolean
}
/** Newest first; `truncated` when there were more than the 200 most recent outside conversations. */
/** A worktree of a repo that no Pitwall session owns (an agent made it with `git worktree add`). */
export interface StrayWorktree { path: string; branch?: string; merged: boolean; dirty: boolean; inUse: boolean; lastCommitAt: number | null
  /** Pitwall couldn't check whether a process is using it (lsof failed): treated as in use. */
  inUseUnknown?: boolean }
export interface ConversationList { items: ConversationItem[]; truncated: boolean }
/** A row of the folder's conversations that matches a search: title matches first, then the newest. */
export interface ConversationMatch {
  kind: 'archived' | 'outside'; id: string; matchedIn: 'title' | 'conversation'
  /** About 60 characters either side of the first match in the conversation ('' if none, or not read). */
  snippet: string
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

/** One comment on a line range of an agent's diff. `quote` is at most the first 3 selected lines, each cut to 160 characters. */
export interface ReviewComment { id: string; path: string; fromLine: number; toLine: number; quote: string; note: string }
