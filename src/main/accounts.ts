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

/** Who is signed in to an account: the email, and the organisation when the plan belongs to one. */
export interface AccountIdentity { email: string; org: string | null; orgName: string | null }

/** Each .claude.json's identity, as of its mtime: the file is big and asked about often, so it's read only when it changes. */
const identities = new Map<string, { mtimeMs: number; identity: AccountIdentity | null }>()

async function identityIn(file: string): Promise<AccountIdentity | null> {
  const mtimeMs = await stat(file).then((st) => st.mtimeMs, () => null)
  if (mtimeMs === null) {
    identities.delete(file)
    return null
  }
  const hit = identities.get(file)
  if (hit && hit.mtimeMs === mtimeMs) return hit.identity
  let identity: AccountIdentity | null = null
  try {
    const o = JSON.parse(await readFile(file, 'utf8'))?.oauthAccount
    const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
    const email = str(o?.emailAddress)
    if (email) identity = { email, org: str(o?.organizationUuid), orgName: str(o?.organizationName) }
  } catch {
    // missing or corrupt: nobody signed in
  }
  identities.set(file, { mtimeMs, identity })
  return identity
}

/** Where an account keeps its profile: beside the folder for the built-in default (~/.claude), inside any other. */
export function profileFile(dir: string, home: string): string {
  return normalizeDir(dir, home) === normalizeDir(join(home, '.claude'), home) ? join(home, '.claude.json') : join(dir, '.claude.json')
}

/** Who is signed in to the account in this folder, or null. Reads only the email and organisation from its profile. */
export function accountIdentity(key: string, home: string): Promise<AccountIdentity | null> {
  return identityIn(profileFile(key, home))
}

/** One email can hold a personal plan and a seat in an organisation: those are two accounts. */
export function sameAccount(a: AccountIdentity, b: AccountIdentity): boolean {
  return a.email.toLowerCase() === b.email.toLowerCase() && a.org === b.org
}

const folderLabel = (key: string, home: string): string => {
  const h = normalizeDir(home, home)
  return key === h || key.startsWith(h + sep) ? join('~', key.slice(h.length)) : key
}

/** The signed-in email for an account, else its folder with home shown as ~. Read only. */
export async function accountLabel(key: string, home: string): Promise<string> {
  return (await accountIdentity(key, home))?.email ?? folderLabel(key, home)
}

/** A label per account: its email, with the organisation (or "Personal") added where two accounts share an email. */
export async function accountLabels(keys: string[], home: string): Promise<Map<string, string>> {
  const ids = await Promise.all(keys.map((k) => accountIdentity(k, home)))
  const count = new Map<string, number>()
  for (const id of ids) if (id) count.set(id.email.toLowerCase(), (count.get(id.email.toLowerCase()) ?? 0) + 1)
  return new Map(keys.map((k, i) => {
    const id = ids[i]
    if (!id) return [k, folderLabel(k, home)]
    return [k, (count.get(id.email.toLowerCase()) ?? 0) > 1 ? `${id.email} · ${id.orgName ?? 'Personal'}` : id.email]
  }))
}
