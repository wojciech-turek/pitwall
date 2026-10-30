import { readdir, open } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'
import type { Exec } from './exec'
import { deleteEnv } from '../host/win-command'
import type { GhAccount, GitIdentity, Project, RepoIdentity, Session } from '@shared/types'

export type { GhAccount, RepoIdentity }

const SKIP_PREFIXES = ['config', 'known_hosts', 'authorized_keys', 'allowed_signers']

async function looksLikePrivateKey(file: string): Promise<boolean> {
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(64)
    const { bytesRead } = await fh.read(buf, 0, 64, 0)
    return /^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(buf.subarray(0, bytesRead).toString('utf8'))
  } finally {
    await fh.close()
  }
}

export async function listSshKeys(sshDir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(sshDir, { withFileTypes: true })
  } catch {
    return []
  }
  const keys: string[] = []
  for (const e of entries) {
    if (!e.isFile() || e.name.endsWith('.pub')) continue
    if (SKIP_PREFIXES.some((p) => e.name.startsWith(p))) continue
    const full = join(sshDir, e.name)
    try {
      if (e.name.startsWith('id_') || (await looksLikePrivateKey(full))) keys.push(full)
    } catch {
      // unreadable file: skip
    }
  }
  return keys.sort()
}

export async function listGhAccounts(ghBin: string, exec: Exec, env: Record<string, string>): Promise<GhAccount[]> {
  // gh exits 1 if any account has issues, so parse stdout regardless of exit code.
  const r = await exec(ghBin, ['auth', 'status', '--hostname', 'github.com', '--json', 'hosts'], { env })
  try {
    const parsed = JSON.parse(r.stdout) as {
      hosts?: Record<string, Array<{ login: string; active: boolean; state: string }>>
    }
    return (parsed.hosts?.['github.com'] ?? []).map((a) => ({
      login: a.login,
      active: !!a.active,
      ok: a.state === 'success'
    }))
  } catch {
    return []
  }
}

/** Env vars gh reads a token from before its own store; inherited ones must never stand in for a project's account. */
export const INHERITED_GH_TOKENS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']

/** `env` without the inherited token variables (on Windows, whatever their case: gh reads them that way there). */
export function withoutGhTokens(env: Record<string, string>, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const out = { ...env }
  for (const k of INHERITED_GH_TOKENS) deleteEnv(out, k, platform)
  return out
}

export async function getGhToken(
  ghBin: string,
  account: string,
  exec: Exec,
  env: Record<string, string>
): Promise<string | null> {
  // An inherited token env var would make gh print that token instead of the account's own.
  const r = await exec(ghBin, ['auth', 'token', '--hostname', 'github.com', '--user', account], { env: withoutGhTokens(env) })
  if (r.code !== 0) return null
  const token = r.stdout.trim()
  return token || null
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`
}

function expandHome(p: string, home: string, platform: NodeJS.Platform = process.platform): string {
  if (p === '~') return home
  if (platform === 'win32') return /^~[\\/]/.test(p) ? win32.join(home, p.slice(2)) : p
  return p.startsWith('~/') ? posix.join(home, p.slice(2)) : p
}

/**
 * Git runs GIT_SSH_COMMAND (and core.sshCommand) through its shell. On Windows that is Git for Windows' sh, and the
 * key path is written with forward slashes in double quotes (`ssh -i "C:/Users/me/.ssh/id" …`), which every ssh
 * there (Git's own, Windows OpenSSH) reads, spaces and non-ASCII names included.
 */
export function buildSshCommand(keyPath: string, home = process.env.HOME ?? '', platform: NodeJS.Platform = process.platform): string {
  const key = expandHome(keyPath, home, platform)
  if (platform === 'win32') {
    return `ssh -i "${key.replace(/\\/g, '/').replace(/["$`\\]/g, '\\$&')}" -o IdentitiesOnly=yes`
  }
  return `ssh -i ${shellQuote(key)} -o IdentitiesOnly=yes`
}

/** Why a project's extra environment variable name can't be used, or null if it can. */
export function envVarNameError(key: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return `Environment variable name is invalid: ${key}`
  if (key.startsWith('PITWALL_') || key === 'GIT_SSH_COMMAND' || key === 'GH_TOKEN') {
    return `Environment variable name is reserved: ${key}`
  }
  return null
}

export function buildSessionEnv(input: {
  project: Project
  session: Pick<Session, 'id' | 'title'>
  rootPath: string
  sessionDir: string
  eventsFile: string
  claudeBin: string
  ghBin: string
  setupCommand?: string
  /** The user's own status line command, run by pitwall-statusline. */
  userStatusLine?: string
  /** Windows: Git Bash, which runs the user's status line as Claude Code would (else PowerShell does). */
  gitBash?: string
  home: string
  platform?: NodeJS.Platform
}): Record<string, string> {
  const { project, session, home } = input
  const platform = input.platform ?? process.platform
  const id = project.identity
  const env: Record<string, string> = {}
  for (const { key, value } of project.extraEnv) {
    const error = envVarNameError(key)
    if (error) throw new Error(error)
    env[key] = expandHome(value, home, platform) // env.sh single-quotes values, so the shell would never expand ~ itself
  }
  if (id.sshKeyPath) env.GIT_SSH_COMMAND = buildSshCommand(id.sshKeyPath, home, platform)
  Object.assign(env, {
    GIT_AUTHOR_NAME: id.gitName,
    GIT_AUTHOR_EMAIL: id.gitEmail,
    GIT_COMMITTER_NAME: id.gitName,
    GIT_COMMITTER_EMAIL: id.gitEmail,
    PITWALL_GH_ACCOUNT: id.ghAccount,
    PITWALL_GH_BIN: input.ghBin,
    PITWALL_SESSION_ID: session.id,
    PITWALL_TITLE: session.title,
    PITWALL_ROOT_PATH: input.rootPath,
    PITWALL_SESSION_DIR: input.sessionDir,
    PITWALL_EVENTS_FILE: input.eventsFile,
    PITWALL_CLAUDE_BIN: input.claudeBin
  })
  if (input.setupCommand) env.PITWALL_SETUP_COMMAND = input.setupCommand
  if (input.userStatusLine) env.PITWALL_USER_STATUSLINE = input.userStatusLine
  if (input.userStatusLine && input.gitBash) env.PITWALL_GIT_BASH = input.gitBash
  return env
}

/** Where a session's Claude keeps its user settings: the project's CLAUDE_CONFIG_DIR, else the app's, else ~/.claude. */
export function claudeConfigDir(project: Project, home: string, env: Record<string, string> = {}): string {
  const own = project.extraEnv.filter((e) => e.key === 'CLAUDE_CONFIG_DIR').at(-1)?.value
  if (own) return expandHome(own, home)
  return env.CLAUDE_CONFIG_DIR || join(home, '.claude')
}

export function renderEnvFile(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `export ${k}=${shellQuote(v)}\n`)
    .join('')
}

async function gitConfigGet(repoRoot: string, key: string, exec: Exec, env: Record<string, string>) {
  const r = await exec('git', ['-C', repoRoot, 'config', '--local', '--get', key], { env })
  return r.code === 0 ? r.stdout.replace(/\n$/, '') : undefined
}

export async function readRepoIdentity(
  repoRoot: string,
  exec: Exec,
  env: Record<string, string>
): Promise<RepoIdentity> {
  const [sshCommand, name, email] = await Promise.all([
    gitConfigGet(repoRoot, 'core.sshCommand', exec, env),
    gitConfigGet(repoRoot, 'user.name', exec, env),
    gitConfigGet(repoRoot, 'user.email', exec, env)
  ])
  const out: RepoIdentity = {}
  if (sshCommand !== undefined) out.sshCommand = sshCommand
  if (name !== undefined) out.name = name
  if (email !== undefined) out.email = email
  return out
}

export async function applyRepoIdentity(
  repoRoot: string,
  identity: GitIdentity,
  exec: Exec,
  env: Record<string, string>,
  home: string
): Promise<void> {
  const settings: Array<[string, string]> = [
    ...(identity.sshKeyPath ? [['core.sshCommand', buildSshCommand(identity.sshKeyPath, home)] as [string, string]] : []),
    ['user.name', identity.gitName],
    ['user.email', identity.gitEmail]
  ]
  for (const [key, value] of settings) {
    const r = await exec('git', ['-C', repoRoot, 'config', '--local', key, value], { env })
    if (r.code !== 0) throw new Error(`git config ${key} failed: ${r.stderr.trim()}`)
  }
}

/**
 * After a project's identity changes: a repo still configured with the old identity gets the new one (and loses the
 * old key if the new identity has none); a repo with anything else is left alone. Returns whether it was updated.
 */
export async function replaceRepoIdentity(
  repoRoot: string,
  from: GitIdentity,
  to: GitIdentity,
  exec: Exec,
  env: Record<string, string>,
  home: string
): Promise<boolean> {
  const current = await readRepoIdentity(repoRoot, exec, env)
  if (!identityMatches(current, from, home)) return false
  await applyRepoIdentity(repoRoot, to, exec, env, home)
  if (!to.sshKeyPath && from.sshKeyPath && current.sshCommand === buildSshCommand(from.sshKeyPath, home)) {
    const r = await exec('git', ['-C', repoRoot, 'config', '--local', '--unset', 'core.sshCommand'], { env })
    if (r.code !== 0 && r.code !== 5) throw new Error(`git config --unset core.sshCommand failed: ${r.stderr.trim()}`)
  }
  return true
}

export function identityMatches(current: RepoIdentity, identity: GitIdentity, home: string): boolean {
  return (
    (!identity.sshKeyPath || current.sshCommand === buildSshCommand(identity.sshKeyPath, home)) &&
    current.name === identity.gitName &&
    current.email === identity.gitEmail
  )
}
