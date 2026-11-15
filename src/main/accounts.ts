import { realpathSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { expandHome } from './identity'
import type { AppSettings, ClaudeAccount, Project, Session } from '@shared/types'

export const DEFAULT_ACCOUNT_ID = 'default'

/** What deciding a session's account needs: the saved accounts, the home folder and the app's own environment. */
export interface AccountCtx { settings: AppSettings; home: string; env: Record<string, string> }

/**
 * One spelling per folder: ~ expanded, absolute, symlinks resolved (when the folder exists), no trailing separator.
 * Claude Code keys a login to the literal path, and usage is grouped by it.
 */
export function normalizeDir(dir: string, home: string): string {
  let out = resolve(expandHome(dir, home))
  try { out = realpathSync(out) } catch { /* not there yet: its resolved spelling stands */ }
  const root = resolve(sep)
  return out !== root && out.endsWith(sep) ? out.slice(0, -1) : out
}

/** The default account's folder: the app's own CLAUDE_CONFIG_DIR, else ~/.claude. */
export function defaultAccountDir(ctx: AccountCtx): string {
  return normalizeDir(ctx.env.CLAUDE_CONFIG_DIR || join(ctx.home, '.claude'), ctx.home)
}

/** The project's own CLAUDE_CONFIG_DIR (the last non-empty one wins), if it sets one. */
function pinnedDir(project: Project): string | undefined {
  return project.extraEnv.filter((e) => e.key === 'CLAUDE_CONFIG_DIR').at(-1)?.value || undefined
}

/** A project that sets CLAUDE_CONFIG_DIR itself decides its sessions' account: they are never moved. */
export function isPinned(project: Project): boolean {
  return pinnedDir(project) !== undefined
}

const added = (id: string | undefined, ctx: AccountCtx): ClaudeAccount | undefined =>
  id === undefined ? undefined : (ctx.settings.claudeAccounts ?? []).find((a) => a.id === id)

/** The session names an account that is no longer there (it then runs on the default one). */
export function accountMissing(session: Pick<Session, 'account'>, ctx: AccountCtx): boolean {
  return session.account !== undefined && session.account !== DEFAULT_ACCOUNT_ID && !added(session.account, ctx)
}

/** The id of the account a session runs on; null when its project is pinned. */
export function sessionAccountId(project: Project, session: Pick<Session, 'account'>, ctx: AccountCtx): string | null {
  if (isPinned(project)) return null
  return added(session.account, ctx)?.id ?? DEFAULT_ACCOUNT_ID
}

/** Where a session's Claude keeps its settings and login: the project's own folder, else the session's account's. */
export function sessionConfigDir(project: Project, session: Pick<Session, 'account'>, ctx: AccountCtx): string {
  const pinned = pinnedDir(project)
  if (pinned) return normalizeDir(pinned, ctx.home)
  const acct = added(session.account, ctx)
  return acct ? normalizeDir(acct.dir, ctx.home) : defaultAccountDir(ctx)
}

/** A Claude account is identified by its config folder: the same folder, however spelled, is the same account. */
export const accountKey = sessionConfigDir

/** Each .claude.json's email, as of its mtime: the file is big and asked about often, so it's read only when it changes. */
const emails = new Map<string, { mtimeMs: number; email: string | null }>()

async function emailIn(file: string): Promise<string | null> {
  const mtimeMs = await stat(file).then((st) => st.mtimeMs, () => null)
  if (mtimeMs === null) {
    emails.delete(file)
    return null
  }
  const hit = emails.get(file)
  if (hit && hit.mtimeMs === mtimeMs) return hit.email
  let email: string | null = null
  try {
    const v = JSON.parse(await readFile(file, 'utf8'))?.oauthAccount?.emailAddress
    if (typeof v === 'string' && v) email = v
  } catch {
    // missing or corrupt: no email
  }
  emails.set(file, { mtimeMs, email })
  return email
}

/**
 * The signed-in email for an account, else its folder with home shown as ~. Claude keeps the default account's
 * profile at <home>/.claude.json (beside the folder), any other account's inside its folder. Read only.
 */
export async function accountLabel(key: string, home: string): Promise<string> {
  const file = key === normalizeDir(join(home, '.claude'), home) ? join(home, '.claude.json') : join(key, '.claude.json')
  const email = await emailIn(file)
  if (email) return email
  const h = normalizeDir(home, home)
  return key === h || key.startsWith(h + sep) ? join('~', key.slice(h.length)) : key
}
