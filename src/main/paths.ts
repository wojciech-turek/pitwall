import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

export interface AppPaths {
  dataDir: string
  stateFile: string
  /** Last known Claude usage, shown again after a restart. */
  usageFile: string
  /** The last update check, so a relaunch doesn't ask GitHub again within a day. */
  updatesFile: string
  sessionsDir: string
  binDir: string
  tmuxConf: string
  worktreesRoot: string
  sshDir: string
  tmuxSocket: string
  claudeBin: string
  ghBin: string
  testPickFolder?: string
  notificationsDisabled: boolean
}

/**
 * `dev`: an unpackaged build (pnpm dev, tests) gets its own data dir, tmux socket and worktrees, so it never shares
 * state or agents with the installed app. Explicit PITWALL_* overrides win either way.
 * Windows: data in %APPDATA%\pitwall, worktrees in %USERPROFILE%\pitwall\worktrees (`home` is %USERPROFILE%).
 */
export function resolvePaths(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  o: { dev?: boolean; platform?: NodeJS.Platform } = {}
): AppPaths {
  const suffix = o.dev ? '-dev' : ''
  const windows = (o.platform ?? process.platform) === 'win32'
  const join = windows ? win32.join : posix.join
  const appData = windows ? env.APPDATA || join(home, 'AppData', 'Roaming') : join(home, 'Library', 'Application Support')
  const dataDir = env.PITWALL_DATA_DIR || join(appData, `pitwall${suffix}`)
  return {
    dataDir,
    stateFile: join(dataDir, 'state.json'),
    usageFile: join(dataDir, 'usage.json'),
    updatesFile: join(dataDir, 'updates.json'),
    sessionsDir: join(dataDir, 'sessions'),
    binDir: join(dataDir, 'bin'),
    tmuxConf: join(dataDir, 'tmux.conf'),
    worktreesRoot: env.PITWALL_WORKTREES_DIR || join(home, 'pitwall', `worktrees${suffix}`),
    sshDir: env.PITWALL_SSH_DIR || join(home, '.ssh'),
    tmuxSocket: env.PITWALL_TMUX_SOCKET || `pitwall${suffix}`,
    claudeBin: env.PITWALL_CLAUDE_BIN || 'claude',
    ghBin: env.PITWALL_GH_BIN || 'gh',
    testPickFolder: env.PITWALL_TEST_PICK_FOLDER || undefined,
    notificationsDisabled: !!env.PITWALL_DISABLE_NOTIFICATIONS && env.PITWALL_DISABLE_NOTIFICATIONS !== '0'
  }
}

export function sessionDir(paths: AppPaths, sessionId: string): string {
  return `${paths.sessionsDir}/${sessionId}`
}

export function eventsFile(paths: AppPaths, sessionId: string): string {
  return `${sessionDir(paths, sessionId)}/events.jsonl`
}
