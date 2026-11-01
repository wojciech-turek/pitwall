import { ipcMain, shell } from 'electron'
import { IPC } from '@shared/api'
import type { NewSessionInput, StartResult, TermKind } from '@shared/types'
import type { LauncherChoice, SessionBackend } from './backend'
import type { ChangesService } from './changes'
import type { Exec } from './exec'
import { formatAgentReference, listSessionFiles, readForEditor, writeFromEditor } from './files'
import type { GitClient } from './git'
import { settingsFrom, type Store } from './store'
import { claudeTmuxName } from './tmux'
import type { SessionHistory } from './history'
import { listGhAccounts, listSshKeys } from './identity'
import type { AppPaths } from './paths'
import { openInCursorCommand } from './platform'
import type { ProjectService } from './projects'
import type { PtyBridge } from './pty-bridge'
import { archiveSession, checkArchive } from './sessions/archive'
import type { SessionManager } from './sessions/manager'
import type { KeyedMutex } from './sessions/mutex'
import { APP_VERSION } from '@shared/version'
import type { UpdateChecker } from './updates'
import type { UsageTracker } from './usage'

export interface IpcDeps {
  manager: SessionManager
  changes: ChangesService
  store: Store
  git: GitClient
  backend: SessionBackend
  projects: ProjectService
  bridge: PtyBridge
  paths: AppPaths
  exec: Exec
  env: Record<string, string>
  home: string
  mutex: KeyedMutex
  history: Pick<SessionHistory, 'search'>
  usage: Pick<UsageTracker, 'current' | 'onChange'>
  updates: Pick<UpdateChecker, 'state' | 'checkNow' | 'onChange' | 'hasFeed'>
  /** True for an unpackaged (dev) run. */
  dev: boolean
  /** What starts Claude (archiving relaunches it when the worktree can't be removed). */
  launcher?: LauncherChoice
  /** Sends to the renderer; a no-op when there is no window. */
  send: (channel: string, ...args: unknown[]) => void
  /** The sessions visible in the renderer's panes; main combines them with window focus. */
  onViewing: (sessionIds: string[]) => void
}

/** Registers every IPC handler and wires manager snapshots to the renderer. Returns a disposer. */
export function registerIpc(d: IpcDeps): () => void {
  const { manager, projects, bridge, paths, exec, env, send, store, git, backend } = d
  const handle = <A extends unknown[]>(channel: string, fn: (...args: A) => unknown): void => {
    ipcMain.handle(channel, (_e, ...args) => fn(...(args as A)))
  }
  const on = <A extends unknown[]>(channel: string, fn: (...args: A) => void): void => {
    ipcMain.on(channel, (_e, ...args) => fn(...(args as A)))
  }

  handle(IPC.getSnapshot, () => manager.snapshot())
  handle(IPC.getUsage, () => d.usage.current())
  handle(IPC.appInfo, () => ({ version: APP_VERSION, dev: d.dev, updateFeed: d.updates.hasFeed() }))
  handle(IPC.getUpdateState, () => d.updates.state())
  handle(IPC.checkForUpdates, () => d.updates.checkNow())
  handle(IPC.listSshKeys, () => listSshKeys(paths.sshDir))
  handle(IPC.listGhAccounts, () => listGhAccounts(paths.ghBin, exec, env))
  handle(IPC.createProject, (i: Parameters<ProjectService['createProject']>[0]) => projects.createProject(i))
  handle(IPC.updateProject, (id: string, i: Parameters<ProjectService['updateProject']>[1]) => projects.updateProject(id, i))
  handle(IPC.removeProject, (id: string) => projects.removeProject(id))
  handle(IPC.addFolder, (projectId: string) => projects.addFolder(projectId))
  handle(IPC.confirmAddFolder, (projectId: string, path: string, overwrite: boolean) =>
    projects.confirmAddFolder(projectId, path, overwrite))
  handle(IPC.removeSubProject, (id: string) => projects.removeSubProject(id))
  handle(IPC.updateSubProject, (id: string, patch: { setupCommand?: string; teardownCommand?: string }) => projects.updateSubProject(id, patch))
  handle(IPC.prepareNewSession, (id: string) => manager.prepareNew(id))
  // Only continueConversation continues an outside conversation: it checks it and keeps Claude to the worktree.
  handle(IPC.startSession, (i: NewSessionInput) =>
    manager.start({ ...i, continueClaudeId: undefined, continuedFrom: undefined }, (p) => send(IPC.startProgress, p)))
  handle(IPC.renameSession, (id: string, title: string) => manager.rename(id, title))
  handle(IPC.setProjectMuted, (id: string, muted: boolean) => projects.setProjectMuted(id, muted === true))
  handle(IPC.markSessionUnread, (id: string) => manager.markUnread(id))
  on(IPC.sessionOpened, (id: unknown) => { if (typeof id === 'string') manager.sessionOpened(id) })
  handle(IPC.termOpen, (id: string, kind: TermKind, cols: number, rows: number) => bridge.open(id, kind, cols, rows))
  const sessionFolder = (id: string): { cwd: string; kind: 'repo' | 'folder' } => {
    const s = store.state.sessions.find((x) => x.id === id && x.archivedAt === undefined)
    if (!s) throw new Error('Session not found')
    const sp = store.state.subProjects.find((x) => x.id === s.subProjectId)
    return { cwd: s.cwd, kind: sp?.kind ?? 'folder' }
  }
  handle(IPC.listFiles, (id: string) => {
    const f = sessionFolder(id)
    return listSessionFiles(f.cwd, f.kind, git)
  })
  handle(IPC.readFile, (id: string, rel: string) => readForEditor(sessionFolder(id).cwd, rel))
  handle(IPC.writeFile, (id: string, rel: string, content: string, mtime?: number) =>
    writeFromEditor(sessionFolder(id).cwd, rel, content, mtime))
  handle(IPC.sendToAgent, async (id: string, text: string) => {
    sessionFolder(id)
    await backend.pasteText(claudeTmuxName(id), text) // bracketed paste, never Enter
  })
  handle(IPC.listChanges, (id: string) => d.changes.list(id))
  handle(IPC.readDiff, (id: string, rel: string) => d.changes.readDiff(id, rel))
  const archiveDeps = () => ({
    store, paths, git, backend, exec, env, home: d.home, mutex: d.mutex, manager, ptyBridge: bridge, launcher: d.launcher
  })
  handle(IPC.checkArchive, (id: string) => checkArchive(id, archiveDeps()))
  handle(IPC.archiveSession, (id: string, confirmed: boolean, skipTeardown?: boolean) =>
    archiveSession(id, { confirmedDataLoss: confirmed, skipTeardown: !!skipTeardown }, archiveDeps()))
  handle(IPC.searchSessions, (query: unknown) => (typeof query === 'string' ? d.history.search(query.slice(0, 256)) : []))
  handle(IPC.resumeSession, (id: unknown, requestId: unknown): Promise<StartResult> | StartResult =>
    typeof id === 'string' && typeof requestId === 'string'
      ? manager.resume(id, requestId, (p) => send(IPC.startProgress, p))
      : { ok: false, step: 'identity', error: 'Invalid request.' })
  handle(IPC.listConversations, (id: unknown) =>
    typeof id === 'string' ? manager.listConversations(id) : { items: [], truncated: false })
  handle(IPC.searchConversations, (id: unknown, query: unknown) =>
    typeof id === 'string' && typeof query === 'string' ? manager.searchConversations(id, query) : [])
  handle(IPC.continueConversation, (id: unknown, claudeId: unknown, requestId: unknown): Promise<StartResult> | StartResult =>
    typeof id === 'string' && typeof claudeId === 'string' && typeof requestId === 'string'
      ? manager.continueConversation(id, claudeId, requestId, (p) => send(IPC.startProgress, p))
      : { ok: false, step: 'identity', error: 'Invalid request.' })
  handle(IPC.openExternal, async (url: string) => {
    // Only web links; never let the renderer open file: or custom-scheme URLs.
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })

  handle(IPC.openInCursor, async (id: string) => {
    const { cwd } = sessionFolder(id)
    try {
      const c = openInCursorCommand(cwd, process.platform)
      const r = await exec(c.file, c.args, { env })
      return r.code === 0 ? { ok: true } : { ok: false, message: "Cursor isn't installed." }
    } catch {
      return { ok: false, message: "Cursor isn't installed." }
    }
  })
  handle(IPC.setSettings, async (s: unknown) => {
    const wasOn = store.state.settings.checkForUpdates !== false
    const r = await store.update((d) => { d.settings = settingsFrom(s, d.settings) })
    // Turned back on: check now rather than up to a day later.
    if (!wasOn && store.state.settings.checkForUpdates !== false) void d.updates.checkNow()
    return r
  })

  on(IPC.setViewing, (ids: unknown) =>
    d.onViewing(Array.isArray(ids) && ids.every((x) => typeof x === 'string') ? (ids as string[]) : [])
  )
  on(IPC.termWrite, (id: string, kind: TermKind, data: string) => bridge.write(id, kind, data))
  on(IPC.termResize, (id: string, kind: TermKind, cols: number, rows: number) => bridge.resize(id, kind, cols, rows))
  on(IPC.termClose, (id: string, kind: TermKind) => bridge.close(id, kind))

  const unsub = manager.onSnapshot((s) => send(IPC.snapshot, s))
  const unsubUsage = d.usage.onChange((u) => send(IPC.usage, u))
  const unsubUpdates = d.updates.onChange((u) => send(IPC.updateState, u))
  return () => {
    unsub()
    unsubUsage()
    unsubUpdates()
    for (const ch of Object.values(IPC)) {
      ipcMain.removeHandler(ch)
      ipcMain.removeAllListeners(ch)
    }
  }
}
