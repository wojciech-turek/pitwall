import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { tmuxSocketPath } from '../helpers/tmux-socket'
import { makeRepo } from '../helpers/repo'

const run = promisify(execFile)
let envCounter = 0
export const SCREENS = process.env.PITWALL_E2E_SCREENS || join(process.cwd(), 'test-results/screens')
const repoRoot = process.cwd()

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
    PITWALL_CLAUDE_BIN: join(repoRoot, 'tests/fixtures/bin/claude'),
    PITWALL_GH_BIN: join(repoRoot, 'tests/fixtures/bin/gh'),
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

/** The xterm WebGL renderer leaves no DOM text, so read the pane from tmux. */
export async function paneText(socket: string, sessionId: string, window = 'claude'): Promise<string> {
  const names = await tmux(socket, 'list-windows', '-t', `=pw-${sessionId}`, '-F', '#{window_index}:#{window_name}').catch(() => '')
  const idx = names.split('\n').find((l) => l.endsWith(`:${window}`))?.split(':')[0] ?? '0'
  return tmux(socket, 'capture-pane', '-p', '-t', `=pw-${sessionId}:${idx}`).catch(() => '')
}

export async function sessionIdOf(socket: string): Promise<string> {
  const out = await tmux(socket, 'list-sessions', '-F', '#{session_name}')
  const name = out.split('\n').find((l) => l.startsWith('pw-'))
  if (!name) throw new Error('no pw- tmux session')
  return name.slice(3)
}
