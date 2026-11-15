import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { AccountsService, MIN_CLAUDE_FOR_ACCOUNTS, loginTermId } from '../../src/main/accounts-service'
import type { ExecOptions } from '../../src/main/exec'
import { Store } from '../../src/main/store'
import type { AccountUsage, Project, Session, SubProject } from '../../src/shared/types'

let tmp: string
let home: string
let root: string
let store: Store
let svc: AccountsService
let started: Array<{ name: string; argv: string[]; env?: Record<string, string> }>
let killed: string[]
let execs: Array<{ file: string; args: string[]; env?: Record<string, string> }>
let version: string
let usage: AccountUsage[]

const project = (id: string, extraEnv: Project['extraEnv'] = []): Project =>
  ({ id, name: id, createdAt: 0, extraEnv, identity: { sshKeyPath: '', ghAccount: '', gitName: '', gitEmail: '' } })
const sub = (id: string, projectId: string): SubProject => ({ id, projectId, name: id, kind: 'folder', path: '/x', createdAt: 0 })
const session = (id: string, o: Partial<Session> = {}): Session =>
  ({ id, subProjectId: 'sp', title: id, slug: id, claudeSessionId: id, cwd: '/x', branchCreatedByPitwall: false, createdAt: 0, lastViewedAt: 0, ...o })
/** As `claude auth login` leaves a folder. */
const signIn = (dir: string, email: string, org?: string, orgName?: string): void => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email, organizationUuid: org, organizationName: orgName }, userID: 'u-' + email }))
}
const addSignedIn = async (email: string, org?: string, orgName?: string) => {
  const { addId, dir } = await svc.beginAdd()
  signIn(dir, email, org, orgName)
  return { addId, dir, res: await svc.finishAdd(addId) }
}

beforeEach(async () => {
  tmp = realpathSync(await mkdtemp(join(tmpdir(), 'pitwall-acctsvc-')))
  home = join(tmp, 'home')
  root = join(tmp, 'data', 'claude-accounts')
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@x.com' }, mcpServers: { srv: 1 }, hasCompletedOnboarding: true }))
  store = await Store.open(join(tmp, 'state.json'))
  await store.update((d) => { d.projects.push(project('p')); d.subProjects.push(sub('sp', 'p')) })
  started = []; killed = []; execs = []; usage = []
  version = '2.1.325 (Claude Code)'
  svc = new AccountsService({
    store, home, env: { PATH: '/bin' }, paths: { claudeAccountsDir: root, claudeBin: '/bin/claude' },
    backend: {
      hasSession: async (name) => started.some((s) => s.name === name) && !killed.includes(name),
      newSession: async (o) => { started.push({ name: o.name, argv: o.argv, env: o.env }) },
      killSession: async (name) => { killed.push(name) }
    },
    exec: async (file: string, args: string[], o?: ExecOptions) => {
      execs.push({ file, args, env: o?.env })
      return { code: 0, stdout: args[0] === '--version' ? version + '\n' : '', stderr: '' }
    },
    usage: { current: () => usage, onChange: () => () => {} }
  })
})
afterEach(() => rm(tmp, { recursive: true, force: true }))

describe('the account list', () => {
  test('with nothing added: the default account, active', async () => {
    expect(await svc.list()).toEqual([
      { id: 'default', account: join(home, '.claude'), label: 'me@x.com', active: true, sessions: 0, signedIn: true }
    ])
  })

  test('added accounts follow, the active one first, each with its usage and how many sessions use it', async () => {
    const { res } = await addSignedIn('work@x.com')
    if (!res.ok) throw new Error(res.message)
    const u = { fiveHour: { usedPercentage: 8, resetsAt: 5 }, updatedAt: 3 }
    usage = [{ account: join(root, res.id), label: 'stale', usage: u }]
    await store.update((d) => {
      d.sessions.push(session('s1'), session('s2', { account: res.id }), session('s3', { moveTo: res.id }), session('old', { account: res.id, archivedAt: 1 }))
    })
    let list = await svc.list()
    expect(list.map((a) => [a.id, a.label, a.active, a.sessions])).toEqual([['default', 'me@x.com', true, 2], [res.id, 'work@x.com', false, 2]])
    expect(list[1].usage).toEqual(u)
    expect(list[0].usage).toBeUndefined()
    await svc.setActive(res.id)
    list = await svc.list()
    expect(list.map((a) => [a.id, a.active])).toEqual([[res.id, true], ['default', false]])
  })

  test("a pinned project's folder that has reported usage is listed without an id (it can't be switched to)", async () => {
    const pinned = join(tmp, 'pinned')
    await store.update((d) => {
      d.projects.push(project('pp', [{ key: 'CLAUDE_CONFIG_DIR', value: pinned }])); d.subProjects.push(sub('spp', 'pp'))
      d.sessions.push(session('s9', { subProjectId: 'spp' }))
    })
    usage = [{ account: pinned, label: 'x', usage: { updatedAt: 1 } }]
    const row = (await svc.list()).find((a) => a.account === pinned)!
    expect(row.id).toBeUndefined()
    expect(row.sessions).toBe(1)
    expect(row.active).toBe(false)
    expect((await svc.list()).find((a) => a.id === 'default')!.sessions).toBe(0)
  })
})

describe('adding an account', () => {
  test('makes a folder and signs in there in a terminal; nothing is listed until it is finished', async () => {
    const { addId, dir } = await svc.beginAdd()
    expect(dir).toBe(join(root, addId))
    expect(existsSync(dir)).toBe(true)
    await svc.ensureLogin(loginTermId(addId))
    expect(started).toEqual([{ name: `pw-login-${addId}`, argv: ['/bin/claude', 'auth', 'login'], env: { CLAUDE_CONFIG_DIR: dir } }])
    await svc.ensureLogin(loginTermId(addId)) // already running: not started twice
    expect(started).toHaveLength(1)
    expect(await svc.list()).toHaveLength(1)
    expect(store.state.settings.claudeAccounts).toBeUndefined()
  })

  test('finished: listed, linked to the default folder, with its MCP servers; never made active, never given the profile', async () => {
    const { dir, res } = await addSignedIn('work@x.com')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(store.state.settings.claudeAccounts).toMatchObject([{ id: res.id, dir }])
    expect(store.state.settings.activeAccount).toBeUndefined()
    expect(realpathSync(join(dir, 'projects'))).toBe(realpathSync(join(home, '.claude', 'projects')))
    const profile = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8'))
    expect(profile.mcpServers).toEqual({ srv: 1 })
    expect(profile.hasCompletedOnboarding).toBe(true)
    expect(profile.oauthAccount.emailAddress).toBe('work@x.com')
    expect(killed).toContain(`pw-login-${res.id}`)
  })

  test("nobody signed in: nothing is added and the folder is gone", async () => {
    const { addId, dir } = await svc.beginAdd()
    expect(await svc.finishAdd(addId)).toEqual({ ok: false, message: "Sign-in didn't finish, so nothing was added." })
    expect(existsSync(dir)).toBe(false)
    expect(store.state.settings.claudeAccounts).toBeUndefined()
  })

  test('the same account again (the default one, or an added one) is refused and its folder discarded', async () => {
    const dup = await addSignedIn('me@x.com')
    expect(dup.res).toEqual({ ok: false, message: 'me@x.com is already added.' })
    expect(existsSync(dup.dir)).toBe(false)
    expect((await addSignedIn('work@x.com', 'org-1', 'Acme')).res.ok).toBe(true)
    expect((await addSignedIn('work@x.com', 'org-1', 'Acme')).res).toEqual({ ok: false, message: 'work@x.com is already added.' })
    expect(store.state.settings.claudeAccounts).toHaveLength(1)
  })

  test('the same email in another organisation is another account, and the labels say which', async () => {
    expect((await addSignedIn('me@x.com', 'org-1', 'Acme')).res.ok).toBe(true)
    expect((await svc.list()).map((a) => a.label).sort()).toEqual(['me@x.com · Acme', 'me@x.com · Personal'])
  })

  test('cancelling ends the sign-in and discards the folder', async () => {
    const { addId, dir } = await svc.beginAdd()
    await svc.ensureLogin(loginTermId(addId))
    await svc.cancelAdd(addId)
    expect(existsSync(dir)).toBe(false)
    expect(killed).toContain(`pw-login-${addId}`)
    expect(await svc.finishAdd(addId)).toEqual({ ok: false, message: "Sign-in didn't finish, so nothing was added." })
  })

  test('an older Claude Code is refused before anything is created', async () => {
    version = '2.0.1 (Claude Code)'
    await expect(svc.beginAdd()).rejects.toThrow(`Claude Code ${MIN_CLAUDE_FOR_ACCOUNTS} or newer is needed to add accounts.`)
    expect(existsSync(root)).toBe(false)
  })

  test('a sign-in terminal for something that is not being added or already added is refused', async () => {
    await expect(svc.ensureLogin('login-nope')).rejects.toThrow('Account not found.')
    await expect(svc.ensureLogin(loginTermId('default'))).rejects.toThrow('Account not found.')
    expect(started).toEqual([])
  })

  test('signing in again to an added account opens the terminal on its folder', async () => {
    const { dir, res } = await addSignedIn('work@x.com')
    if (!res.ok) throw new Error(res.message)
    started = []; killed = []
    await svc.ensureLogin(loginTermId(res.id))
    expect(started).toEqual([{ name: `pw-login-${res.id}`, argv: ['/bin/claude', 'auth', 'login'], env: { CLAUDE_CONFIG_DIR: dir } }])
  })
})

describe('removing an account', () => {
  test('signs it out in its own folder and deletes the folder; the default folder is untouched', async () => {
    const { dir, res } = await addSignedIn('work@x.com')
    if (!res.ok) throw new Error(res.message)
    execs = []
    await svc.remove(res.id)
    expect(execs).toEqual([{ file: '/bin/claude', args: ['auth', 'logout'], env: { PATH: '/bin', CLAUDE_CONFIG_DIR: dir } }])
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(join(home, '.claude', 'projects'))).toBe(true)
    expect(store.state.settings.claudeAccounts).toEqual([])
  })

  test('is refused while a session runs on it or is waiting to move to it', async () => {
    const { dir, res } = await addSignedIn('work@x.com')
    if (!res.ok) throw new Error(res.message)
    await store.update((d) => { d.sessions.push(session('s1', { moveTo: res.id })) })
    execs = []
    await expect(svc.remove(res.id)).rejects.toThrow('Move or archive the sessions using this account first.')
    expect(execs).toEqual([])
    expect(existsSync(dir)).toBe(true)
  })

  test('removing the active account makes the default one active; the default one can never be removed', async () => {
    const { res } = await addSignedIn('work@x.com')
    if (!res.ok) throw new Error(res.message)
    await svc.setActive(res.id)
    await svc.remove(res.id)
    expect(store.state.settings.activeAccount).toBeUndefined()
    execs = []
    await expect(svc.remove('default')).rejects.toThrow('Account not found.')
    expect(execs).toEqual([]) // never a logout without a folder of its own
  })
})

describe('the active account', () => {
  test('an added one by id; the default one clears it; an unknown one is refused', async () => {
    const { res } = await addSignedIn('work@x.com')
    if (!res.ok) throw new Error(res.message)
    await svc.setActive(res.id)
    expect(store.state.settings.activeAccount).toBe(res.id)
    await svc.setActive('default')
    expect('activeAccount' in store.state.settings).toBe(false)
    await expect(svc.setActive('nope')).rejects.toThrow('Account not found.')
  })
})

test('copying settings from the default account again: MCP servers and newly shared folders, nothing else', async () => {
  const { dir, res } = await addSignedIn('work@x.com')
  if (!res.ok) throw new Error(res.message)
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@x.com' }, mcpServers: { srv: 1, more: 2 }, hasCompletedOnboarding: false }))
  mkdirSync(join(home, '.claude', 'plugins'))
  await svc.copyFromDefault(res.id)
  const profile = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8'))
  expect(profile.mcpServers).toEqual({ srv: 1, more: 2 })
  expect(profile.hasCompletedOnboarding).toBe(true) // only the MCP servers are copied again
  expect(profile.oauthAccount.emailAddress).toBe('work@x.com')
  expect(existsSync(join(dir, 'plugins'))).toBe(true)
})
