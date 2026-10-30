import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC, type PitwallApi } from '../shared/api'

// Sandboxed preloads can only require 'electron'; shared code is bundled in (type imports are erased).
function subscribe<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: unknown, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener) }
}

// A focus request can arrive before the app has subscribed (the window was just created for a notification click):
// keep the latest one until someone listens.
const focusListeners = new Set<(id: string) => void>()
let pendingFocus: string | null = null
ipcRenderer.on(IPC.focusSession, (_e, id: string) => {
  if (focusListeners.size === 0) pendingFocus = id
  for (const cb of [...focusListeners]) cb(id)
})
function onFocusSession(cb: (id: string) => void): () => void {
  focusListeners.add(cb)
  if (pendingFocus !== null) {
    const id = pendingFocus
    pendingFocus = null
    cb(id)
  }
  return () => { focusListeners.delete(cb) }
}

const api: PitwallApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.getSnapshot),
  onSnapshot: (cb) => subscribe(IPC.snapshot, cb),
  listSshKeys: () => ipcRenderer.invoke(IPC.listSshKeys),
  listGhAccounts: () => ipcRenderer.invoke(IPC.listGhAccounts),
  createProject: (i) => ipcRenderer.invoke(IPC.createProject, i),
  updateProject: (id, i) => ipcRenderer.invoke(IPC.updateProject, id, i),
  removeProject: (id) => ipcRenderer.invoke(IPC.removeProject, id),
  addFolder: (projectId) => ipcRenderer.invoke(IPC.addFolder, projectId),
  confirmAddFolder: (projectId, path, overwrite) => ipcRenderer.invoke(IPC.confirmAddFolder, projectId, path, overwrite),
  removeSubProject: (id) => ipcRenderer.invoke(IPC.removeSubProject, id),
  updateSubProject: (id, patch) => ipcRenderer.invoke(IPC.updateSubProject, id, patch),
  prepareNewSession: (id) => ipcRenderer.invoke(IPC.prepareNewSession, id),
  startSession: (i) => ipcRenderer.invoke(IPC.startSession, i),
  onStartProgress: (cb) => subscribe(IPC.startProgress, cb),
  renameSession: (id, title) => ipcRenderer.invoke(IPC.renameSession, id, title),
  setViewing: (ids) => ipcRenderer.send(IPC.setViewing, ids),
  termOpen: (id, kind, cols, rows) => ipcRenderer.invoke(IPC.termOpen, id, kind, cols, rows),
  termWrite: (id, kind, data) => ipcRenderer.send(IPC.termWrite, id, kind, data),
  termResize: (id, kind, cols, rows) => ipcRenderer.send(IPC.termResize, id, kind, cols, rows),
  termClose: (id, kind) => ipcRenderer.send(IPC.termClose, id, kind),
  onTermData: (cb) => subscribe(IPC.termData, cb),
  onTermExit: (cb) => subscribe(IPC.termExit, cb),
  listFiles: (id) => ipcRenderer.invoke(IPC.listFiles, id),
  readFile: (id, rel) => ipcRenderer.invoke(IPC.readFile, id, rel),
  writeFile: (id, rel, content, mtime) => ipcRenderer.invoke(IPC.writeFile, id, rel, content, mtime),
  sendToAgent: (id, text) => ipcRenderer.invoke(IPC.sendToAgent, id, text),
  listChanges: (id) => ipcRenderer.invoke(IPC.listChanges, id),
  readDiff: (id, rel) => ipcRenderer.invoke(IPC.readDiff, id, rel),
  checkArchive: (id) => ipcRenderer.invoke(IPC.checkArchive, id),
  archiveSession: (id, confirmed) => ipcRenderer.invoke(IPC.archiveSession, id, confirmed),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  openInCursor: (id) => ipcRenderer.invoke(IPC.openInCursor, id),
  setSettings: (s) => ipcRenderer.invoke(IPC.setSettings, s),
  onFocusSession,
  getUsage: () => ipcRenderer.invoke(IPC.getUsage),
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  onUsage: (cb) => subscribe(IPC.usage, cb),
  onMenuCommand: (cb) => subscribe(IPC.menuCommand, cb),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  }
}

contextBridge.exposeInMainWorld('pitwall', api)
