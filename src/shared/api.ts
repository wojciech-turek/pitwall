import type {
  AppSettings, AppSnapshot, ArchiveCheck, ArchiveResult, ChangedFile, ClaudeUsage, EnvVar, FileContent, FileEntry, GhAccount, GitIdentity, NewSessionDefaults, NewSessionInput, Project, RepoIdentity,
  StartProgress, StartResult, SubProject, TermKind, UpdateState
} from './types'

export interface ProjectInput { name: string; identity: GitIdentity; extraEnv: EnvVar[] }

export type AddFolderResult =
  | { status: 'added'; subProject: SubProject }
  | { status: 'cancelled' }
  | { status: 'error'; message: string }
  | { status: 'needs_identity_confirm'; path: string; current: RepoIdentity; proposed: RepoIdentity }

export type MenuCommand =
  | { type: 'new-session' } | { type: 'next-attention' } | { type: 'select-index'; index: number }
  | { type: 'close-tab' } | { type: 'save' } | { type: 'settings' }

export interface PitwallApi {
  getSnapshot(): Promise<AppSnapshot>
  onSnapshot(cb: (s: AppSnapshot) => void): () => void
  listSshKeys(): Promise<string[]>
  listGhAccounts(): Promise<GhAccount[]>
  createProject(i: ProjectInput): Promise<Project>
  updateProject(id: string, i: ProjectInput): Promise<Project>
  removeProject(id: string): Promise<{ ok: boolean; message?: string }>
  addFolder(projectId: string): Promise<AddFolderResult>
  confirmAddFolder(projectId: string, path: string, overwriteIdentity: boolean): Promise<AddFolderResult>
  removeSubProject(id: string): Promise<{ ok: boolean; message?: string }>
  updateSubProject(id: string, patch: { setupCommand?: string }): Promise<void>
  prepareNewSession(subProjectId: string): Promise<NewSessionDefaults>
  startSession(i: NewSessionInput): Promise<StartResult>
  onStartProgress(cb: (p: StartProgress) => void): () => void
  renameSession(id: string, title: string): Promise<void>
  setViewing(sessionIds: string[]): void
  termOpen(sessionId: string, kind: TermKind, cols: number, rows: number): Promise<void>
  termWrite(sessionId: string, kind: TermKind, data: string): void
  termResize(sessionId: string, kind: TermKind, cols: number, rows: number): void
  termClose(sessionId: string, kind: TermKind): void
  onTermData(cb: (sessionId: string, kind: TermKind, data: string) => void): () => void
  onTermExit(cb: (sessionId: string, kind: TermKind, code: number) => void): () => void
  listFiles(sessionId: string): Promise<{ files: FileEntry[]; truncated: boolean }>
  readFile(sessionId: string, rel: string): Promise<FileContent>
  writeFile(sessionId: string, rel: string, content: string, expectedMtimeMs?: number):
    Promise<{ ok: true; mtimeMs: number } | { ok: false; reason: 'changed_on_disk' }>
  sendToAgent(sessionId: string, text: string): Promise<void>
  listChanges(sessionId: string): Promise<{ base: string; baseLabel: string; files: ChangedFile[] }>
  readDiff(sessionId: string, rel: string): Promise<{ original: string; modified: string; binary: boolean; tooLarge: boolean }>
  checkArchive(sessionId: string): Promise<ArchiveCheck>
  archiveSession(sessionId: string, confirmedDataLoss: boolean): Promise<ArchiveResult>
  openExternal(url: string): Promise<void>
  openInCursor(sessionId: string): Promise<{ ok: boolean; message?: string }>
  setSettings(s: AppSettings): Promise<void>
  onFocusSession(cb: (sessionId: string) => void): () => void
  /** Claude subscription usage, or null until Claude has reported any. */
  getUsage(): Promise<ClaudeUsage | null>
  /**
   * Build version, whether this is a dev (unpackaged) run, and whether it looks for updates at all (a dev build only
   * when pointed at a feed with PITWALL_RELEASES_URL).
   */
  appInfo(): Promise<{ version: string; dev: boolean; updateFeed: boolean }>
  onUsage(cb: (u: ClaudeUsage | null) => void): () => void
  /** What the last update check found (nothing until one succeeds). */
  getUpdateState(): Promise<UpdateState>
  /** Checks GitHub now, even with automatic checks off; never fails (a failed check leaves checkedAt as it was). */
  checkForUpdates(): Promise<UpdateState>
  onUpdateState(cb: (s: UpdateState) => void): () => void
  onMenuCommand(cb: (c: MenuCommand) => void): () => void
  /** Absolute path of a dropped file ('' if it has none). Synchronous, preload-only. */
  pathForFile(file: File): string
}

declare global {
  interface Window { pitwall: PitwallApi }
}

/** IPC channel names shared by the preload and the main process. */
export const IPC = {
  getSnapshot: 'pitwall:getSnapshot',
  listSshKeys: 'pitwall:listSshKeys',
  listGhAccounts: 'pitwall:listGhAccounts',
  createProject: 'pitwall:createProject',
  updateProject: 'pitwall:updateProject',
  removeProject: 'pitwall:removeProject',
  addFolder: 'pitwall:addFolder',
  confirmAddFolder: 'pitwall:confirmAddFolder',
  removeSubProject: 'pitwall:removeSubProject',
  updateSubProject: 'pitwall:updateSubProject',
  prepareNewSession: 'pitwall:prepareNewSession',
  startSession: 'pitwall:startSession',
  renameSession: 'pitwall:renameSession',
  setViewing: 'pitwall:setViewing',
  termOpen: 'pitwall:termOpen',
  termWrite: 'pitwall:termWrite',
  termResize: 'pitwall:termResize',
  termClose: 'pitwall:termClose',
  listFiles: 'pitwall:listFiles',
  readFile: 'pitwall:readFile',
  writeFile: 'pitwall:writeFile',
  sendToAgent: 'pitwall:sendToAgent',
  listChanges: 'pitwall:listChanges',
  readDiff: 'pitwall:readDiff',
  checkArchive: 'pitwall:checkArchive',
  archiveSession: 'pitwall:archiveSession',
  openExternal: 'pitwall:openExternal',
  openInCursor: 'pitwall:openInCursor',
  setSettings: 'pitwall:setSettings',
  getUsage: 'pitwall:getUsage',
  appInfo: 'pitwall:appInfo',
  getUpdateState: 'pitwall:getUpdateState',
  checkForUpdates: 'pitwall:checkForUpdates',
  // main -> renderer
  snapshot: 'pitwall:snapshot',
  startProgress: 'pitwall:startProgress',
  termData: 'pitwall:termData',
  termExit: 'pitwall:termExit',
  focusSession: 'pitwall:focusSession',
  menuCommand: 'pitwall:menuCommand',
  usage: 'pitwall:usage',
  updateState: 'pitwall:updateState'
} as const
