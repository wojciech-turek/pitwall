import { randomInt } from 'node:crypto'
import {
  accountIdentity, accountLabels, defaultAccountDir, sameAccount, sessionAccountId, sessionConfigDir, DEFAULT_ACCOUNT_ID,
  type AccountCtx
} from './accounts'
import { copyProfileKeys, createAccountFolder, linkShared, profileFile, removeAccountFolder, PROFILE_KEYS } from './account-folders'
import type { SessionBackend } from './backend'
import type { Exec } from './exec'
import type { AppPaths } from './paths'
import type { Store } from './store'
import { claudeTmuxName } from './tmux'
import type { UsageTracker } from './usage'
import type { AccountView, ClaudeAccount } from '@shared/types'

/**
 * The oldest Claude Code that keeps each config folder's login apart. PROVISIONAL: the version Pitwall already asks
 * for elsewhere, until the real floor is found by hand (the plan's Task 0, check 2).
 */
export const MIN_CLAUDE_FOR_ACCOUNTS = '2.1.257'

const NOT_FOUND = 'Account not found.'
const NOT_FINISHED = "Sign-in didn't finish, so nothing was added."

/** The terminal a sign-in runs in: `login-<account id>`, shown by the renderer like a session's Claude terminal. */
export const loginTermId = (accountId: string): string => `login-${accountId}`
export const isLoginTerm = (termId: string): boolean => termId.startsWith('login-')

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'
function newAccountId(): string {
  let out = ''
  for (let i = 0; i < 8; i++) out += ID_CHARS[randomInt(ID_CHARS.length)]
  return `acct_${out}`
}

/** [major, minor, patch] from `claude --version` ("2.1.325 (Claude Code)"), or null. */
function parseVersion(text: string): number[] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
function atLeast(have: number[], want: number[]): boolean {
  for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return have[i] > want[i]
  return true
}

interface Deps {
  store: Store
  home: string
  env: Record<string, string>
  paths: Pick<AppPaths, 'claudeAccountsDir' | 'claudeBin'>
  backend: Pick<SessionBackend, 'hasSession' | 'newSession' | 'killSession'>
  exec: Exec
  usage: Pick<UsageTracker, 'current' | 'onChange'>
}

/**
 * Pitwall's Claude accounts: the default one (the folder Claude uses anyway) and those added here, each a folder of
 * its own that Claude Code keeps the login for. Pitwall never reads or stores a login; it only reads who is signed in
 * (email and organisation) from each folder's profile.
 */
export class AccountsService {
  /** Accounts being added: signed in to (or not yet), not listed until finished. */
  private adding = new Map<string, string>()

  constructor(private deps: Deps) {}

  private ctx(): AccountCtx {
    return { settings: this.deps.store.state.settings, home: this.deps.home, env: this.deps.env }
  }

  private added(): ClaudeAccount[] {
    return this.deps.store.state.settings.claudeAccounts ?? []
  }

  /** The default account, every added one, then folders projects set for themselves that have reported usage. */
  async list(): Promise<AccountView[]> {
    const st = this.deps.store.state
    const ctx = this.ctx()
    const active = this.added().find((a) => a.id === st.settings.activeAccount)?.id ?? DEFAULT_ACCOUNT_ID
    const usage = new Map(this.deps.usage.current().map((u) => [u.account, u.usage]))
    const rows: Array<{ id?: string; account: string }> = [
      { id: DEFAULT_ACCOUNT_ID, account: defaultAccountDir(ctx) },
      ...this.added().map((a) => ({ id: a.id, account: a.dir }))
    ]
    for (const key of usage.keys()) if (!rows.some((r) => r.account === key)) rows.push({ account: key })

    // Each live session counts for the account it runs on, and for the one it is waiting to move to.
    const byId = new Map<string, number>()
    const byKey = new Map<string, number>()
    const bump = (m: Map<string, number>, k: string): void => { m.set(k, (m.get(k) ?? 0) + 1) }
    for (const s of st.sessions) {
      if (s.archivedAt !== undefined) continue
      const project = st.projects.find((p) => p.id === st.subProjects.find((x) => x.id === s.subProjectId)?.projectId)
      if (!project) continue
      const id = sessionAccountId(project, s, ctx)
      if (id === null) { bump(byKey, sessionConfigDir(project, s, ctx)); continue }
      bump(byId, id)
      if (s.moveTo !== undefined && s.moveTo !== id) bump(byId, s.moveTo)
    }

    const labels = await accountLabels(rows.map((r) => r.account), this.deps.home)
    const identities = await Promise.all(rows.map((r) => accountIdentity(r.account, this.deps.home)))
    const views = rows.map((r, i): AccountView => {
      const v: AccountView = {
        account: r.account, label: labels.get(r.account) ?? r.account, active: r.id === active,
        sessions: r.id !== undefined ? byId.get(r.id) ?? 0 : byKey.get(r.account) ?? 0, signedIn: identities[i] !== null
      }
      if (r.id !== undefined) v.id = r.id
      const u = usage.get(r.account)
      if (u) v.usage = u
      return v
    })
    // The active one first; the rest keep their order (default, added by age, then the pinned folders).
    return [...views.filter((v) => v.active), ...views.filter((v) => !v.active)]
  }

  /** Calls back with the list whenever the saved state or the usage changes. */
  onChange(cb: (a: AccountView[]) => void): () => void {
    let gen = 0
    const push = (): void => {
      const mine = ++gen
      void this.list().then((l) => { if (mine === gen) cb(l) }, () => undefined)
    }
    const offStore = this.deps.store.onChange(push)
    const offUsage = this.deps.usage.onChange(push)
    return () => { gen = -1; offStore(); offUsage() }
  }

  /** A folder for a new account, to sign in to. Listed only once finishAdd finds someone signed in there. */
  async beginAdd(): Promise<{ addId: string; dir: string }> {
    const r = await this.deps.exec(this.deps.paths.claudeBin, ['--version'], { env: this.deps.env, timeoutMs: 15_000 })
    const have = parseVersion(r.stdout)
    if (!have || !atLeast(have, parseVersion(MIN_CLAUDE_FOR_ACCOUNTS)!)) {
      throw new Error(`Claude Code ${MIN_CLAUDE_FOR_ACCOUNTS} or newer is needed to add accounts.`)
    }
    const addId = newAccountId()
    const dir = await createAccountFolder(this.deps.paths.claudeAccountsDir, addId)
    this.adding.set(addId, dir)
    return { addId, dir }
  }

  private folderOf(accountId: string): string | undefined {
    return this.adding.get(accountId) ?? this.added().find((a) => a.id === accountId)?.dir
  }

  /** Starts `claude auth login` in the account's folder (one being added, or an added one to sign in to again), unless it runs already. */
  async ensureLogin(termId: string): Promise<void> {
    const dir = isLoginTerm(termId) ? this.folderOf(termId.slice('login-'.length)) : undefined
    if (!dir) throw new Error(NOT_FOUND)
    const name = claudeTmuxName(termId)
    if (await this.deps.backend.hasSession(name)) return
    await this.deps.backend.newSession({
      name, cwd: this.deps.home, argv: [this.deps.paths.claudeBin, 'auth', 'login'], env: { CLAUDE_CONFIG_DIR: dir }
    })
  }

  /** Ends the account's sign-in terminal, if one is open. */
  endLogin(accountId: string): Promise<void> {
    return this.deps.backend.killSession(claudeTmuxName(loginTermId(accountId))).catch(() => undefined)
  }

  private async discard(addId: string, dir: string): Promise<void> {
    this.adding.delete(addId)
    await removeAccountFolder(dir, this.deps.paths.claudeAccountsDir).catch(() => undefined)
  }

  /** Lists the account if someone signed in to its folder and it isn't one already there. Never makes it active. */
  async finishAdd(addId: string): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
    const dir = this.adding.get(addId)
    if (!dir) return { ok: false, message: NOT_FINISHED }
    await this.endLogin(addId)
    const who = await accountIdentity(dir, this.deps.home)
    if (!who) {
      await this.discard(addId, dir)
      return { ok: false, message: NOT_FINISHED }
    }
    const ctx = this.ctx()
    const defaultDir = defaultAccountDir(ctx)
    for (const other of [defaultDir, ...this.added().map((a) => a.dir)]) {
      const theirs = await accountIdentity(other, this.deps.home)
      if (theirs && sameAccount(who, theirs)) {
        await this.discard(addId, dir)
        return { ok: false, message: `${who.email} is already added.` }
      }
    }
    await copyProfileKeys(profileFile(defaultDir, this.deps.home), profileFile(dir, this.deps.home), PROFILE_KEYS)
    await linkShared(dir, defaultDir)
    this.adding.delete(addId)
    await this.deps.store.update((d) => {
      d.settings.claudeAccounts = [...(d.settings.claudeAccounts ?? []), { id: addId, dir, addedAt: Date.now() }]
    })
    return { ok: true, id: addId }
  }

  async cancelAdd(addId: string): Promise<void> {
    const dir = this.adding.get(addId)
    if (!dir) return
    await this.endLogin(addId)
    await this.discard(addId, dir)
  }

  /** Signs the account out (Claude removes its own login) and deletes its folder. Only when no session uses it. */
  async remove(id: string): Promise<void> {
    const acct = this.added().find((a) => a.id === id)
    if (!acct) throw new Error(NOT_FOUND)
    if (((await this.list()).find((a) => a.id === id)?.sessions ?? 0) > 0) {
      throw new Error('Move or archive the sessions using this account first.')
    }
    await this.endLogin(id)
    // Always with the account's own folder: a logout without one would sign the default account out.
    await this.deps.exec(this.deps.paths.claudeBin, ['auth', 'logout'], { env: { ...this.deps.env, CLAUDE_CONFIG_DIR: acct.dir }, timeoutMs: 30_000 })
      .catch(() => undefined)
    await removeAccountFolder(acct.dir, this.deps.paths.claudeAccountsDir)
    await this.deps.store.update((d) => {
      d.settings.claudeAccounts = (d.settings.claudeAccounts ?? []).filter((a) => a.id !== id)
      if (d.settings.activeAccount === id) delete d.settings.activeAccount
    })
  }

  /** The default account's user-level MCP servers again, and anything it has started sharing since. */
  async copyFromDefault(id: string): Promise<void> {
    const acct = this.added().find((a) => a.id === id)
    if (!acct) throw new Error(NOT_FOUND)
    const defaultDir = defaultAccountDir(this.ctx())
    await copyProfileKeys(profileFile(defaultDir, this.deps.home), profileFile(acct.dir, this.deps.home), ['mcpServers'])
    await linkShared(acct.dir, defaultDir, process.platform, undefined, { refreshCopies: true })
  }

  /** The account sessions started from now on run on. */
  async setActive(id: string): Promise<void> {
    if (id !== DEFAULT_ACCOUNT_ID && !this.added().some((a) => a.id === id)) throw new Error(NOT_FOUND)
    await this.deps.store.update((d) => {
      if (id === DEFAULT_ACCOUNT_ID) delete d.settings.activeAccount
      else d.settings.activeAccount = id
    })
  }
}
