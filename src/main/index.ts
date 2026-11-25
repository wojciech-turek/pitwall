import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { parseEventLine } from './hooks/events'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { app, BrowserWindow, dialog, Menu, nativeImage, powerMonitor, shell } from 'electron'
import { IPC } from '@shared/api'
import { chooseBackend, launcherChoice, readRecordedBackend, recordBackend, type SessionBackend } from './backend'
import { exec, findExecutable } from './exec'
import { historySources, SessionHistory } from './history'
import { HostBackend, hostAlive } from './host-backend'
import { buildMenuTemplate } from './menu'
import { GitClient } from './git'
import { ChangesService } from './changes'
import { PrPoller } from './pr'
import { ServerWatcher } from './server-watch'
import { registerIpc } from './ipc'
import { electronNotifier } from './notifier'
import { cliSocketPath, loadCliKey } from './cli/auth'
import { CliServer } from './cli/server'
import { eventsFile, resolvePaths, sessionDir } from './paths'
import { appUserModelId } from './platform'
import { PortAllocator } from './ports'
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
import { accountKey, accountLabel, defaultAccountDir } from './accounts'
import { AccountsService, isLoginTerm } from './accounts-service'
import { AccountMover } from './sessions/mover'
import { UsageTracker } from './usage'
import { ContinueScheduler } from './sessions/continue-at'
import { SystemMonitor } from './system-monitor'
import { isViewing, viewingAfter, type ViewingEvent } from './viewing'
import { windowChrome } from './window-chrome'
import { APP_VERSION } from '@shared/version'

// A dev build is unmistakable: its own name, and below its own Dock icon.
const DEV = !app.isPackaged
app.setName(DEV ? 'Pitwall Dev' : 'Pitwall')
const WINDOWS = process.platform === 'win32'
// Tests (PITWALL_SHOW_INACTIVE=1, set for every e2e launch): the app never takes the keyboard or shows up while
// someone works at the machine. macOS: no Dock icon, never the active app; its window is invisible and lets clicks
// through (tests drive it over the DevTools protocol, which needs neither).
const QUIET = process.env.PITWALL_SHOW_INACTIVE === '1'
const keepInBackground = (): void => {
  if (!QUIET || process.platform !== 'darwin') return
  try { app.setActivationPolicy('accessory') } catch { /* not yet allowed: whenReady sets it again */ }
}
keepInBackground()
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
let disposeServers: (() => void) | null = null
let disposeUsage: (() => void) | null = null
let disposeContinueAt: (() => void) | null = null
let disposeMover: (() => void) | null = null
let disposeSystemStats: (() => void) | null = null
let disposeUpdates: (() => void) | null = null
let disposeCli: (() => void) | null = null
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
    // Tests: invisible, but still painting (screenshots) and running timers as if it were in front.
    ...(QUIET ? { opacity: 0 } : {}),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      ...(QUIET ? { backgroundThrottling: false } : {})
    }
  })
  if (QUIET) w.setIgnoreMouseEvents(true)
  win = w
  winLoaded = false
  // The page's <title> must not override the window title.
  w.on('page-title-updated', (e) => e.preventDefault())
  // Tests open windows without taking the keyboard, so typing elsewhere during a run can't reach them.
  w.once('ready-to-show', () => {
    if (QUIET) w.showInactive()
    else w.show()
    refreshBadge?.() // Windows: the waiting count is an overlay on this window's taskbar button
  })
  // Viewed while focused and neither minimized nor hidden: on Windows a minimize can come with no blur.
  const viewing = (e: ViewingEvent): void => manager?.setViewing(visibleIds, viewingAfter(e, w))
  w.on('focus', () => {
    if (WINDOWS) w.flashFrame(false)
    viewing('focus')
  })
  w.on('blur', () => viewing('blur'))
  w.on('minimize', () => viewing('minimize'))
  w.on('hide', () => viewing('hide'))
  w.on('restore', () => viewing('restore'))
  w.on('show', () => viewing('show'))
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
  if (QUIET) { // tests: never in front, never the keyboard
    if (!win.isVisible()) win.showInactive()
    return
  }
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
 * tmux on Pitwall's private socket, or (PITWALL_SESSION_BACKEND=host, or no tmux installed; see chooseBackend) the Pitwall host: this executable run as Node
 * on out/host/index.js, one per data dir, so a dev build and the installed app never share agents.
 */
async function createBackend(env: Record<string, string>, store: Store): Promise<SessionBackend> {
  const file = join(paths.dataDir, 'backend.json')
  // PITWALL_TMUX_BIN: a path to use, or `none` to act as if tmux isn't installed (a login shell can always find Homebrew's).
  const tmuxPath = paths.tmuxBin === 'none' ? null : paths.tmuxBin || findExecutable('tmux', env.PATH)
  const recorded = await readRecordedBackend(file)
  const liveSessions = store.state.sessions.filter((s) => s.archivedAt === undefined).length
  const choice = chooseBackend({
    env: process.env, platform: process.platform, tmuxPath, recorded, liveSessions,
    // Only asked when it can decide anything: no record, and sessions to keep.
    hostAlive: !WINDOWS && recorded === null && liveSessions > 0 && await hostAlive(paths.dataDir)
  })
  if (choice.record) await recordBackend(file, choice.kind, recorded)
  if (choice.kind === 'tmux') {
    const tmux = new Tmux({ socket: paths.tmuxSocket, confPath: paths.tmuxConf, env, exec, tmuxBin: tmuxPath ?? undefined })
    await tmux.reloadConfig().catch(() => {}) // a server left running by an older version takes this version's config
    return new TmuxBackend(tmux, env)
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
  const backend = await createBackend(env, store)
  const notifier = electronNotifier(focusSession, paths.notificationsDisabled, {
    window: () => win, quiet: QUIET,
    // The red dot is drawn on the icon the Dock shows: the bundle's (the same artwork), or a dev run's own.
    dockIcon: () => {
      const icon = nativeImage.createFromPath(join(resourcesDir(), app.isPackaged ? 'icon.png' : 'icon-dev.png'))
      return icon.isEmpty() ? null : icon
    }
  })
  refreshBadge = () => notifier.refresh()
  const mutex = new KeyedMutex()
  const launcher = launcherChoice(process.env)
  // Searches every session's conversation (⌘K) and a folder's (Continue a conversation).
  const history = new SessionHistory(() => historySources(mgr.snapshot(), home, env))
  // The `pitwall` command (not on Windows: no unix sockets): its key signs each session's token, so load it first.
  let cliKey: Buffer | undefined
  if (!WINDOWS) {
    try {
      cliKey = await loadCliKey(paths.cliKey)
    } catch (e) {
      console.error('pitwall command key unavailable:', e)
    }
  }
  const cliJs = join(import.meta.dirname, '../cli/index.js')
  const mgr = new SessionManager({ store, paths, git, backend, exec, env, home, mutex, notifier, launcher, history, ports: new PortAllocator(), cliKey, cliJs })
  manager = mgr
  await mgr.init()
  // The `pitwall` command's socket: sessions ask Pitwall to start and watch helper sessions. Not on Windows (no unix sockets).
  if (cliKey) {
    try {
      const cli = new CliServer({ key: cliKey, socketPath: cliSocketPath(paths.dataDir), manager: mgr })
      await cli.start()
      disposeCli = () => { void cli.stop() }
    } catch (e) {
      console.error('pitwall command server did not start:', e)
    }
  }

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
    // A sign-in terminal (login-<account>) belongs to the accounts service; every other id is a session's.
    ensureTarget: (id, kind) => (isLoginTerm(id) ? accounts.ensureLogin(id) : mgr.ensureTerminalTarget(id, kind)),
    onData: (id, kind, data) => send(IPC.termData, id, kind, data),
    onExit: (id, kind, code) => send(IPC.termExit, id, kind, code),
    onUserInput: (id, kind, data) => { if (!isLoginTerm(id)) mgr.userInput(id, kind, data) }
  })
  const changes = new ChangesService({ store, git, manager: mgr })
  changes.start()
  disposeChanges = () => changes.stop()
  const pr = new PrPoller({ store, manager: mgr, git, exec, env, paths, notifier })
  pr.start()
  disposePr = () => pr.stop()
  const servers = new ServerWatcher({ store, manager: mgr, backend, exec })
  servers.start()
  disposeServers = () => servers.stop()
  const usage = new UsageTracker({
    file: paths.usageFile,
    defaultAccount: defaultAccountDir({ settings: store.state.settings, home, env }),
    labelFor: (k) => accountLabel(k, home),
    sessions: () => store.state.sessions.filter((s) => s.archivedAt === undefined).flatMap((s) => {
      const sp = store.state.subProjects.find((x) => x.id === s.subProjectId)
      const project = store.state.projects.find((p) => p.id === sp?.projectId)
      return project ? [{ dir: sessionDir(paths, s.id), account: accountKey(project, s, { settings: store.state.settings, home, env }) }] : []
    })
  })
  await usage.load()
  usage.start()
  const accounts = new AccountsService({ store, home, env, paths, backend, exec, usage })
  disposeUsage = () => usage.stop()
  // statfs needs a path that exists: the worktrees folder may not yet.
  let diskPath = paths.worktreesRoot
  while (!existsSync(diskPath) && dirname(diskPath) !== diskPath) diskPath = dirname(diskPath)
  const systemStats = new SystemMonitor({
    exec, backend, diskPath,
    liveSessionIds: () => store.state.sessions.filter((s) => s.archivedAt === undefined).map((s) => s.id),
    appMetrics: () => {
      let cpu = 0, kb = 0, procs = 0
      for (const m of app.getAppMetrics()) { cpu += m.cpu.percentCPUUsage; kb += m.memory.workingSetSize; procs++ }
      return { cpu, rssBytes: kb * 1024, procs }
    }
  })
  if (process.platform !== 'win32') systemStats.start()
  disposeSystemStats = () => systemStats.stop()
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
  const continueAt = new ContinueScheduler({
    store, manager: mgr,
    usageFor: (id) => {
      const s = mgr.snapshot().sessions.find((x) => x.id === id)
      return s?.account ? usage.current().find((a) => a.account === s.account)?.usage : undefined
    }
  })
  continueAt.start()
  disposeContinueAt = () => continueAt.stop()
  const mover = new AccountMover({
    store, home, env, manager: mgr, continueAt,
    sessionDir: (id) => sessionDir(paths, id),
    readEvents: async (id) => (await readFile(eventsFile(paths, id), 'utf8').catch(() => '')).split('\n').flatMap((l) => parseEventLine(l) ?? []),
    labelFor: async (id) => (await accounts.list()).find((a) => a.id === id)?.label ?? id,
    onRestarted: (id) => send(IPC.termRestart, id)
  })
  mover.start()
  disposeMover = () => mover.stop()
  disposeIpc = registerIpc({
    manager: mgr, changes, store, git, backend, projects, bridge, paths, exec, env, home, mutex, history, usage, accounts, mover, systemStats, updates, pr, continueAt, send, dev: DEV,
    launcher,
    onViewing: (ids) => {
      visibleIds = ids
      mgr.setViewing(ids, isViewing(win))
    }
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate((c) => send(IPC.menuCommand, c), !app.isPackaged, process.platform)))
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
    keepInBackground()
    // The packaged app gets its icon from the bundle; a dev run would show Electron's (tests show none).
    if (!app.isPackaged && !QUIET) {
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
    disposeServers?.()
    disposeServers = null
    disposeUsage?.()
    disposeUsage = null
    disposeContinueAt?.()
    disposeContinueAt = null
    disposeMover?.()
    disposeMover = null
    disposeSystemStats?.()
    disposeSystemStats = null
    disposeUpdates?.()
    disposeUpdates = null
    disposeCli?.()
    disposeCli = null
    manager?.dispose()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
