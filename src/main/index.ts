import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, Menu, powerMonitor, shell } from 'electron'
import { IPC } from '@shared/api'
import { sessionBackendKind, type SessionBackend } from './backend'
import { exec } from './exec'
import { historySources, SessionHistory } from './history'
import { HostBackend } from './host-backend'
import { appShortcut, buildMenuTemplate } from './menu'
import { GitClient } from './git'
import { ChangesService } from './changes'
import { PrPoller } from './pr'
import { registerIpc } from './ipc'
import { electronNotifier } from './notifier'
import { resolvePaths, sessionDir } from './paths'
import { appUserModelId } from './platform'
import { ProjectService } from './projects'
import { PtyBridge } from './pty-bridge'
import { installResources, resourcesDir } from './resources'
import { SessionManager } from './sessions/manager'
import { KeyedMutex } from './sessions/mutex'
import { resolveShellEnv } from './shell-env'
import { Store } from './store'
import { Tmux } from './tmux'
import { TmuxBackend } from './tmux-backend'
import { releasesUrl, UpdateChecker } from './updates'
import { UsageTracker } from './usage'
import { windowChrome } from './window-chrome'
import { APP_VERSION } from '@shared/version'

// A dev build is unmistakable: its own name, and below its own Dock icon.
const DEV = !app.isPackaged
app.setName(DEV ? 'Pitwall Dev' : 'Pitwall')
const WINDOWS = process.platform === 'win32'
// Windows ties notifications and the taskbar button to this id; it must be set before any notification.
if (WINDOWS) app.setAppUserModelId(appUserModelId(DEV))
// A dev build keeps its own data, tmux socket and worktrees (see resolvePaths).
const paths = resolvePaths(process.env, homedir(), { dev: DEV })
app.setPath('userData', paths.dataDir)
// One instance per data dir: a second launch only brings the first one forward.
const isPrimaryInstance = app.requestSingleInstanceLock()

let win: BrowserWindow | null = null
let winLoaded = false
let visibleIds: string[] = []
let pendingFocusId: string | null = null // a session to select once the window has loaded
let bridge: PtyBridge | null = null
let manager: SessionManager | null = null
let disposeIpc: (() => void) | null = null
let disposeChanges: (() => void) | null = null
let disposePr: (() => void) | null = null
let disposeUsage: (() => void) | null = null
let disposeUpdates: (() => void) | null = null
let refreshBadge: (() => void) | null = null

const send = (channel: string, ...args: unknown[]): void => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

function createWindow(): void {
  const w = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    ...windowChrome(process.platform),
    // macOS: the bundle's icon (a dev run sets the Dock's below). Windows: the installed .exe's, or the dev one.
    ...(WINDOWS && DEV ? { icon: join(resourcesDir(), 'icon-dev.png') } : {}),
    title: DEV ? 'Pitwall Dev' : 'Pitwall',
    backgroundColor: '#171615',
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win = w
  winLoaded = false
  // The page's <title> must not override the window title.
  w.on('page-title-updated', (e) => e.preventDefault())
  // Tests open windows without taking the keyboard, so typing elsewhere during a run can't reach them.
  w.once('ready-to-show', () => {
    if (process.env.PITWALL_SHOW_INACTIVE === '1') w.showInactive()
    else w.show()
    refreshBadge?.() // Windows: the waiting count is an overlay on this window's taskbar button
  })
  w.on('focus', () => {
    if (WINDOWS) w.flashFrame(false)
    manager?.setViewing(visibleIds, true)
  })
  // Windows: the menu's Ctrl shortcuts go to the app even while a terminal has the keyboard (see appShortcut).
  w.webContents.on('before-input-event', (e, input) => {
    const command = appShortcut(input, process.platform)
    if (!command) return
    e.preventDefault()
    w.webContents.send(IPC.menuCommand, command)
  })
  w.on('blur', () => manager?.setViewing(visibleIds, false))
  // Nothing may replace the app's UI (a file dropped outside a terminal used to navigate to it). The one exception is
  // reloading the app's own page (the error screen's Reload button; location.reload() counts as a navigation).
  w.webContents.on('will-navigate', (e) => {
    if (e.url !== w.webContents.getURL()) e.preventDefault()
  })
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  w.webContents.on('did-start-loading', () => { if (win === w) winLoaded = false })
  w.webContents.on('did-finish-load', () => {
    if (win !== w) return
    winLoaded = true
    if (pendingFocusId) w.webContents.send(IPC.focusSession, pendingFocusId)
    pendingFocusId = null
  })
  w.on('closed', () => {
    if (win === w) win = null
    // The renderer is gone; its terminals are detached (tmux sessions keep running) and nothing is being viewed.
    bridge?.closeAll()
    visibleIds = []
    manager?.setViewing([], false)
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void w.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void w.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
  if (!app.isPackaged) {
    w.webContents.once('did-finish-load', () => {
      void w.webContents.executeJavaScript('typeof window.pitwall').then((t) => console.log(`[pitwall] typeof window.pitwall = ${t}`))
    })
  }
}

function showAndFocus(): void {
  if (!win) createWindow()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** Notification click: bring the window up (creating it if it was closed) and select the session once it can listen. */
function focusSession(sessionId: string): void {
  showAndFocus()
  if (!win) return
  if (winLoaded) send(IPC.focusSession, sessionId)
  else pendingFocusId = sessionId
}

/**
 * tmux on Pitwall's private socket, or (PITWALL_SESSION_BACKEND=host) the Pitwall host: this executable run as Node
 * on out/host/index.js, one per data dir, so a dev build and the installed app never share agents.
 */
function createBackend(env: Record<string, string>): SessionBackend {
  if (sessionBackendKind(process.env) === 'tmux') {
    return new TmuxBackend(new Tmux({ socket: paths.tmuxSocket, confPath: paths.tmuxConf, env, exec }), env)
  }
  return new HostBackend({
    dataDir: paths.dataDir,
    appVersion: APP_VERSION,
    launch: {
      file: process.execPath,
      args: [join(import.meta.dirname, '../host/index.js'), '--data', paths.dataDir],
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' }
    }
  })
}

async function bootstrap(): Promise<void> {
  const home = homedir()
  const env = await resolveShellEnv()
  await installResources(paths)
  const store = await Store.open(paths.stateFile)
  const git = new GitClient(exec, env)
  const backend = createBackend(env)
  const notifier = electronNotifier(focusSession, paths.notificationsDisabled, { window: () => win })
  refreshBadge = () => notifier.refresh()
  const mutex = new KeyedMutex()
  const mgr = new SessionManager({ store, paths, git, backend, exec, env, home, mutex, notifier })
  manager = mgr
  await mgr.init()

  const projects = new ProjectService({
    store, git, exec, env, home,
    onProjectUpdated: (id) => mgr.rewriteProjectSessionFiles(id),
    pickFolder: async () => {
      if (paths.testPickFolder) return paths.testPickFolder
      const opts = { properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return r.canceled ? null : (r.filePaths[0] ?? null)
    }
  })
  bridge = new PtyBridge({
    backend,
    ensureTarget: (id, kind) => mgr.ensureTerminalTarget(id, kind),
    onData: (id, kind, data) => send(IPC.termData, id, kind, data),
    onExit: (id, kind, code) => send(IPC.termExit, id, kind, code),
    onUserInput: (id, kind, data) => mgr.userInput(id, kind, data)
  })
  const changes = new ChangesService({ store, git, manager: mgr })
  changes.start()
  disposeChanges = () => changes.stop()
  const pr = new PrPoller({ store, manager: mgr, git, exec, env, paths, notifier })
  pr.start()
  disposePr = () => pr.stop()
  const usage = new UsageTracker({
    file: paths.usageFile,
    sessionDirs: () => store.state.sessions.filter((s) => s.archivedAt === undefined).map((s) => sessionDir(paths, s.id))
  })
  await usage.load()
  usage.start()
  disposeUsage = () => usage.stop()
  // A dev build looks for releases only when pointed at a feed (PITWALL_RELEASES_URL).
  const updates = new UpdateChecker({
    current: APP_VERSION,
    url: releasesUrl(process.env, DEV),
    file: paths.updatesFile,
    fetch: (url, init) => fetch(url, init),
    now: Date.now,
    timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t as NodeJS.Timeout) },
    enabled: () => store.state.settings.checkForUpdates !== false
  })
  await updates.load() // the saved notice shows at once; the next check waits until the last one is a day old
  updates.start()
  // Timers stop while the Mac sleeps; reschedule on wake so "about once a day" stays true on laptops.
  const onResume = (): void => updates.start()
  powerMonitor.on('resume', onResume)
  disposeUpdates = () => { powerMonitor.removeListener('resume', onResume); updates.stop() }
  const history = new SessionHistory(() => historySources(mgr.snapshot(), home, env))
  disposeIpc = registerIpc({
    manager: mgr, changes, store, git, backend, projects, bridge, paths, exec, env, home, mutex, history, usage, updates, send, dev: DEV,
    onViewing: (ids) => {
      visibleIds = ids
      mgr.setViewing(ids, win?.isFocused() ?? false)
    }
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate((c) => send(IPC.menuCommand, c), !app.isPackaged)))
  createWindow()
}

function reportFatal(e: unknown): void {
  const message = e instanceof Error ? e.message : String(e)
  console.error('[pitwall] startup failed:', e)
  dialog.showErrorBox('Pitwall could not start', message)
}

if (!isPrimaryInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (manager) showAndFocus()
  })

  void app.whenReady().then(async () => {
    // The packaged app gets its icon from the bundle; a dev run would show Electron's.
    if (!app.isPackaged) {
      try { app.dock?.setIcon(join(resourcesDir(), 'icon-dev.png')) } catch { /* cosmetic */ }
    }
    try {
      await bootstrap()
    } catch (e) {
      reportFatal(e)
    }
    app.on('activate', () => {
      if (manager && BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', () => {
    bridge?.dispose() // detaches only, and no terminal opens after this; tmux sessions keep running
    disposeIpc?.()
    disposeIpc = null
    disposeChanges?.()
    disposeChanges = null
    disposePr?.()
    disposePr = null
    disposeUsage?.()
    disposeUsage = null
    disposeUpdates?.()
    disposeUpdates = null
    manager?.dispose()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
