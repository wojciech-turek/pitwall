import { ipcMain, shell } from 'electron'
import { IPC } from '@shared/api'
import type { NewSessionInput, TermKind } from '@shared/types'
import type { ChangesService } from './changes'
import type { Exec } from './exec'
import { formatAgentReference, listSessionFiles, readForEditor, writeFromEditor } from './files'
import type { GitClient } from './git'
import { settingsFrom, type Store } from './store'
import { claudeTmuxName, type Tmux } from './tmux'
import { listGhAccounts, listSshKeys } from './identity'
import type { AppPaths } from './paths'
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
  tmux: Tmux
  projects: ProjectService
  bridge: PtyBridge
  paths: AppPaths
  exec: Exec
  env: Record<string, string>
  home: string
  mutex: KeyedMutex
  usage: Pick<UsageTracker, 'current' | 'onChange'>
  updates: Pick<UpdateChecker, 'state' | 'checkNow' | 'onChange'>
  /** True for an unpackaged (dev) run. */
  dev: boolean
  /** Sends to the renderer; a no-op when there is no window. */
  send: (channel: string, ...args: unknown[]) => void
  /** The sessions visible in the renderer's panes; main combines them with window focus. */
  onViewing: (sessionIds: string[]) => void
}

/** Registers every IPC handler and wires manager snapshots to the renderer. Returns a disposer. */
export function registerIpc(d: IpcDeps): () => void {
  const { manager, projects, bridge, paths, exec, env, send, store, git, tmux } = d
  const handle = <A extends unknown[]>(channel: string, fn: (...args: A) => unknown): void => {
    ipcMain.handle(channel, (_e, ...args) => fn(...(args as A)))
  }
  const on = <A extends unknown[]>(channel: string, fn: (...args: A) => void): void => {
    ipcMain.on(channel, (_e, ...args) => fn(...(args as A)))
  }

  handle(IPC.getSnapshot, () => manager.snapshot())
  handle(IPC.getUsage, () => d.usage.current())
  handle(IPC.appInfo, () => ({ version: APP_VERSION, dev: d.dev }))
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
  handle(IPC.updateSubProject, (id: string, patch: { setupCommand?: string }) => projects.updateSubProject(id, patch))
  handle(IPC.prepareNewSession, (id: string) => manager.prepareNew(id))
  handle(IPC.startSession, (i: NewSessionInput) => manager.start(i, (p) => send(IPC.startProgress, p)))
  handle(IPC.renameSession, (id: string, title: string) => manager.rename(id, title))
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
    await tmux.pasteText(claudeTmuxName(id), text) // bracketed paste, never Enter
  })
  handle(IPC.listChanges, (id: string) => d.changes.list(id))
  handle(IPC.readDiff, (id: string, rel: string) => d.changes.readDiff(id, rel))
  const archiveDeps = () => ({
    store, paths, git, tmux, exec, env, home: d.home, mutex: d.mutex, manager, ptyBridge: bridge
  })
  handle(IPC.checkArchive, (id: string) => checkArchive(id, archiveDeps()))
  handle(IPC.archiveSession, (id: string, confirmed: boolean) =>
    archiveSession(id, { confirmedDataLoss: confirmed }, archiveDeps()))
  handle(IPC.openExternal, async (url: string) => {
    // Only web links; never let the renderer open file: or custom-scheme URLs.
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })

  handle(IPC.openInCursor, async (id: string) => {
    const { cwd } = sessionFolder(id)
    try {
      const r = await exec('open', ['-a', 'Cursor', cwd], { env })
      return r.code === 0 ? { ok: true } : { ok: false, message: "Cursor isn't installed." }
    } catch {
      return { ok: false, message: "Cursor isn't installed." }
    }
  })
  handle(IPC.setSettings, (s: unknown) => store.update((d) => { d.settings = settingsFrom(s, d.settings) }))

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
