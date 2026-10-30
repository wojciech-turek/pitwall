import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { HostBackend } from '../../src/main/host-backend'
import { tmuxSocketPath } from '../helpers/tmux-socket'
import { makeRepo } from '../helpers/repo'
import { waitFor } from '../helpers/wait'

const run = promisify(execFile)
let envCounter = 0
export const SCREENS = process.env.PITWALL_E2E_SCREENS || join(process.cwd(), 'test-results/screens')
const repoRoot = process.cwd()

/** Where the app under test keeps sessions (PITWALL_SESSION_BACKEND=host, or Windows: the Pitwall host; else tmux). */
export const SESSION_BACKEND: 'tmux' | 'host' =
  process.platform === 'win32' || process.env.PITWALL_SESSION_BACKEND === 'host' ? 'host' : 'tmux'

/**
 * The stub claude and gh: the sh scripts; on Windows the Node ones through their .cmd shims (no sh there). With
 * PITWALL_E2E_NODE_STUBS=1 macOS runs the Node ones too, to show they behave the same.
 */
export function stubBin(name: 'claude' | 'gh'): string {
  const dir = join(repoRoot, 'tests/fixtures/bin')
  if (process.platform === 'win32') return join(dir, `${name}.cmd`)
  return join(dir, process.env.PITWALL_E2E_NODE_STUBS === '1' ? `${name}.mjs` : name)
}

export interface E2eEnv {
  tmp: string
  dataDir: string
  socket: string
  repo: Awaited<ReturnType<typeof makeRepo>>
  env: Record<string, string>
  cleanup(): Promise<void>
}

export async function makeE2eEnv(): Promise<E2eEnv> {
  const tmp = await mkdtemp(join(tmpdir(), 'pitwall-e2e-'))
  const dataDir = join(tmp, 'data dir')
  const sshDir = join(tmp, 'ssh')
  await mkdir(sshDir, { recursive: true })
  await writeFile(join(sshDir, 'id_test'), 'not a real key\n', { mode: 0o600 })
  await writeFile(join(sshDir, 'id_test.pub'), 'ssh-ed25519 AAAA test\n')
  const repo = await makeRepo({ dirName: 'tax-service' })
  const socket = `pitwall-e2e-${process.pid}-${envCounter++}`
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v
  delete base.TMUX
  delete base.TMUX_PANE
  const env = {
    ...base,
    PITWALL_DATA_DIR: dataDir,
    PITWALL_WORKTREES_DIR: join(tmp, 'worktrees'),
    PITWALL_TMUX_SOCKET: socket,
    PITWALL_CLAUDE_BIN: stubBin('claude'),
    PITWALL_GH_BIN: stubBin('gh'),
    PITWALL_SSH_DIR: sshDir,
    PITWALL_TEST_PICK_FOLDER: repo.root,
    PITWALL_DISABLE_NOTIFICATIONS: '1',
    // Never ask the real GitHub for releases (a packaged app would); updates.spec points this at its own server.
    PITWALL_RELEASES_URL: '',
    PITWALL_SHOW_INACTIVE: '1',
    // Never chain the real user's status line into test sessions.
    CLAUDE_CONFIG_DIR: join(tmp, 'claude-config'),
    STUB_CLAUDE_LOG: join(tmp, 'claude.log')
  }
  return {
    tmp, dataDir, socket, repo, env,
    cleanup: async () => {
      await tmux(socket, 'kill-server').catch(() => undefined)
      await rm(tmuxSocketPath(socket, env), { force: true })
      await stopHost(dataDir)
      await repo.cleanup()
      await rm(tmp, { recursive: true, force: true })
    }
  }
}

export async function launchApp(env: Record<string, string>, executablePath?: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: [join(repoRoot, 'out/main/index.js')] }),
    env,
    cwd: repoRoot
  })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1400, 900)
  })
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

export async function tmux(socket: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('tmux', ['-L', socket, ...args])
  return stdout
}

export async function shot(page: Page, name: string): Promise<void> {
  await mkdir(SCREENS, { recursive: true })
  await page.screenshot({ path: join(SCREENS, `${name}.png`) })
}

// ---- the sessions' backend, whichever it is --------------------------------------

const hosts = new Map<string, HostBackend>()

/** A client for the app's host that never starts one itself. */
function host(e: E2eEnv): HostBackend {
  let h = hosts.get(e.dataDir)
  if (!h) {
    h = new HostBackend({ dataDir: e.dataDir, appVersion: 'e2e', launch: null })
    hosts.set(e.dataDir, h)
  }
  return h
}

/** The xterm WebGL renderer leaves no DOM text, so read the pane from the backend. */
export async function paneText(e: E2eEnv, sessionId: string, window = 'claude'): Promise<string> {
  if (SESSION_BACKEND === 'host') return host(e).capture(`pw-${sessionId}`).catch(() => '')
  const names = await tmux(e.socket, 'list-windows', '-t', `=pw-${sessionId}`, '-F', '#{window_index}:#{window_name}').catch(() => '')
  const idx = names.split('\n').find((l) => l.endsWith(`:${window}`))?.split(':')[0] ?? '0'
  // -J joins wrapped lines, so long paths match on narrow screens (e.g. CI runners)
  return tmux(e.socket, 'capture-pane', '-p', '-J', '-t', `=pw-${sessionId}:${idx}`).catch(() => '')
}

/** Running session names; none when the backend isn't running. */
export async function sessionNames(e: E2eEnv): Promise<string[]> {
  if (SESSION_BACKEND === 'host') return host(e).listSessions()
  const out = await tmux(e.socket, 'list-sessions', '-F', '#{session_name}').catch(() => '')
  return out.split('\n').filter(Boolean)
}

export async function sessionIdOf(e: E2eEnv): Promise<string> {
  const name = (await sessionNames(e)).find((l) => l.startsWith('pw-'))
  if (!name) throw new Error(`no pw- session in ${SESSION_BACKEND}`)
  return name.slice(3)
}

export async function hasSession(e: E2eEnv, sessionId: string): Promise<boolean> {
  return (await sessionNames(e)).includes(`pw-${sessionId}`)
}

/** As `tmux send-keys`: key names (`Enter`, `C-u`) or text, typed into the session's Claude. */
export async function sendKeys(e: E2eEnv, sessionId: string, ...keys: string[]): Promise<void> {
  if (SESSION_BACKEND === 'host') return host(e).sendKeys(`pw-${sessionId}`, keys)
  await tmux(e.socket, 'send-keys', '-t', `=pw-${sessionId}:`, ...keys)
}

/** Host processes serving `dataDir` (dev: Electron running out/host/index.js; packaged: Pitwall running its copy). */
export async function hostPids(dataDir: string): Promise<number[]> {
  const { stdout } = await run('/bin/ps', ['-axww', '-o', 'pid=,command='], { maxBuffer: 32 * 1024 * 1024 })
  const arg = `host/index.js --data ${dataDir}`
  return stdout.split('\n')
    .filter((l) => l.endsWith(arg) || l.includes(`${arg} --`))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
}

/** Ends the app's host and its agents (a test never leaves one running). */
async function stopHost(dataDir: string): Promise<void> {
  const h = hosts.get(dataDir) ?? new HostBackend({ dataDir, appVersion: 'e2e', launch: null })
  hosts.delete(dataDir)
  await h.shutdown().catch(() => undefined)
  h.disconnect()
  for (const pid of await hostPids(dataDir)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  }
  await waitFor(async () => (await hostPids(dataDir)).length === 0, 10_000, `no host left for ${dataDir}`)
}
