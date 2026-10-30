import { homedir } from 'node:os'
import { join } from 'node:path'

export interface AppPaths {
  dataDir: string
  stateFile: string
  /** Last known Claude usage, shown again after a restart. */
  usageFile: string
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
 */
export function resolvePaths(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  o: { dev?: boolean } = {}
): AppPaths {
  const suffix = o.dev ? '-dev' : ''
  const dataDir = env.PITWALL_DATA_DIR || join(home, 'Library', 'Application Support', `pitwall${suffix}`)
  return {
    dataDir,
    stateFile: join(dataDir, 'state.json'),
    usageFile: join(dataDir, 'usage.json'),
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
