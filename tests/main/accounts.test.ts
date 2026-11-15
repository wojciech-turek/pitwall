import { realpathSync } from 'node:fs'
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  accountIdentity, accountKey, accountLabel, accountLabels, accountMissing, sameAccount, defaultAccountDir, isPinned, normalizeDir, sessionAccountId, sessionConfigDir,
  DEFAULT_ACCOUNT_ID, type AccountCtx
} from '../../src/main/accounts'
import { DEFAULT_SETTINGS, type AppSettings, type Project } from '@shared/types'

const mkProject = (dir?: string): Project => ({
  id: 'p1', name: 'P', createdAt: 0,
  identity: { sshKeyPath: '', ghAccount: '', gitName: 'a', gitEmail: 'a@b.c' },
  extraEnv: dir ? [{ key: 'CLAUDE_CONFIG_DIR', value: dir }] : []
})
// The real path: a temp folder is often reached through a symlink (/var on macOS), and account folders are real paths.
const tmpHome = async () => realpathSync(await mkdtemp(join(tmpdir(), 'pitwall-acct-')))
const ctxOf = (home: string, over: Partial<AppSettings> = {}, env: Record<string, string> = {}): AccountCtx =>
  ({ settings: { ...DEFAULT_SETTINGS, ...over }, home, env })

describe('accountKey', () => {
  test('~/.claude-work and <home>/.claude-work/ are the same account', async () => {
    const home = await tmpHome()
    const a = accountKey(mkProject('~/.claude-work'), {}, ctxOf(home))
    const b = accountKey(mkProject(join(home, '.claude-work') + '/'), {}, ctxOf(home))
    expect(a).toBe(join(home, '.claude-work'))
    expect(b).toBe(a)
  })

  test('no CLAUDE_CONFIG_DIR is <home>/.claude', async () => {
    const home = await tmpHome()
    expect(accountKey(mkProject(), {}, ctxOf(home))).toBe(join(home, '.claude'))
  })

  test('the app environment CLAUDE_CONFIG_DIR is used when the project has none', async () => {
    const home = await tmpHome()
    expect(accountKey(mkProject(), {}, ctxOf(home, {}, { CLAUDE_CONFIG_DIR: join(home, 'x') + '/' }))).toBe(join(home, 'x'))
  })
})

describe("a session's account", () => {
  const added = (home: string) => ({ id: 'a1', dir: join(home, 'data', 'claude-accounts', 'a1'), addedAt: 1 })

  test('a session with no account runs on Default', async () => {
    const home = await tmpHome()
    expect(sessionAccountId(mkProject(), {}, ctxOf(home))).toBe(DEFAULT_ACCOUNT_ID)
    expect(DEFAULT_ACCOUNT_ID).toBe('default')
    expect(sessionConfigDir(mkProject(), {}, ctxOf(home))).toBe(join(home, '.claude'))
  })

  test("a session's own account gives that account's folder", async () => {
    const home = await tmpHome()
    const ctx = ctxOf(home, { claudeAccounts: [added(home)] })
    expect(sessionAccountId(mkProject(), { account: 'a1' }, ctx)).toBe('a1')
    expect(sessionConfigDir(mkProject(), { account: 'a1' }, ctx)).toBe(added(home).dir)
    expect(accountKey(mkProject(), { account: 'a1' }, ctx)).toBe(added(home).dir)
  })

  test('a project that sets CLAUDE_CONFIG_DIR is pinned and wins over the session account', async () => {
    const home = await tmpHome()
    const p = mkProject('~/work-claude')
    const ctx = ctxOf(home, { claudeAccounts: [added(home)] })
    expect(isPinned(p)).toBe(true)
    expect(isPinned(mkProject())).toBe(false)
    expect(sessionAccountId(p, { account: 'a1' }, ctx)).toBeNull()
    expect(sessionConfigDir(p, { account: 'a1' }, ctx)).toBe(join(home, 'work-claude'))
  })

  test("of several CLAUDE_CONFIG_DIR values the last wins, and an empty one doesn't pin", async () => {
    const home = await tmpHome()
    const withDirs = (...values: string[]): Project =>
      ({ ...mkProject(), extraEnv: values.map((value) => ({ key: 'CLAUDE_CONFIG_DIR', value })) })
    expect(sessionConfigDir(withDirs(join(home, 'a'), join(home, 'b')), {}, ctxOf(home))).toBe(join(home, 'b'))
    expect(isPinned(withDirs(''))).toBe(false)
    expect(sessionConfigDir(withDirs(''), {}, ctxOf(home))).toBe(join(home, '.claude'))
  })

  test('an account that no longer exists falls back to Default and is reported missing', async () => {
    const home = await tmpHome()
    expect(sessionAccountId(mkProject(), { account: 'gone' }, ctxOf(home))).toBe('default')
    expect(sessionConfigDir(mkProject(), { account: 'gone' }, ctxOf(home))).toBe(join(home, '.claude'))
    expect(accountMissing({ account: 'gone' }, ctxOf(home))).toBe(true)
    expect(accountMissing({}, ctxOf(home))).toBe(false)
    expect(accountMissing({ account: 'default' }, ctxOf(home))).toBe(false)
    expect(accountMissing({ account: 'a1' }, ctxOf(home, { claudeAccounts: [added(home)] }))).toBe(false)
  })

  test("the app's own CLAUDE_CONFIG_DIR starting with ~ is expanded", async () => {
    const home = await tmpHome()
    expect(defaultAccountDir(ctxOf(home, {}, { CLAUDE_CONFIG_DIR: '~/alt' }))).toBe(join(home, 'alt'))
    expect(defaultAccountDir(ctxOf(home))).toBe(join(home, '.claude'))
  })
})

describe('normalizeDir', () => {
  test('expands ~ and drops a trailing slash', async () => {
    const home = await tmpHome()
    expect(normalizeDir('~/x/', home)).toBe(join(home, 'x'))
    expect(normalizeDir('~', home)).toBe(home)
  })

  test.skipIf(process.platform === 'win32')('a symlinked spelling of a folder is the same folder', async () => {
    const home = await tmpHome()
    await mkdir(join(home, 'real'))
    await symlink(join(home, 'real'), join(home, 'link'))
    expect(normalizeDir(join(home, 'link'), home)).toBe(join(home, 'real'))
  })
})

describe('accountLabel', () => {
  test('the default dir reads <home>/.claude.json', async () => {
    const home = await tmpHome()
    await writeFile(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com' } }))
    expect(await accountLabel(join(home, '.claude'), home)).toBe('me@example.com')
  })

  test('another dir reads <key>/.claude.json, not the home one', async () => {
    const home = await tmpHome()
    await writeFile(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'home@example.com' } }))
    const key = join(home, '.claude-work')
    await mkdir(key)
    await writeFile(join(key, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'work@example.com' } }))
    expect(await accountLabel(key, home)).toBe('work@example.com')
  })

  test('missing file falls back to the key with home as ~', async () => {
    const home = await tmpHome()
    expect(await accountLabel(join(home, '.claude-work'), home)).toBe(join('~', '.claude-work'))
  })

  test('corrupt JSON falls back to the ~ form', async () => {
    const home = await tmpHome()
    await writeFile(join(home, '.claude.json'), '{ nope')
    expect(await accountLabel(join(home, '.claude'), home)).toBe(join('~', '.claude'))
  })

  test('a non-string email falls back to the ~ form', async () => {
    const home = await tmpHome()
    await writeFile(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 42 } }))
    expect(await accountLabel(join(home, '.claude'), home)).toBe(join('~', '.claude'))
  })

  test('the file is read again only when its mtime changes', async () => {
    const home = await tmpHome()
    const file = join(home, '.claude.json')
    const at = new Date('2026-11-01T10:00:00Z')
    await writeFile(file, JSON.stringify({ oauthAccount: { emailAddress: 'aaa@example.com' } }))
    await utimes(file, at, at)
    expect(await accountLabel(join(home, '.claude'), home)).toBe('aaa@example.com')
    // New contents, same mtime: the cached label stands (the file wasn't read).
    await writeFile(file, JSON.stringify({ oauthAccount: { emailAddress: 'bbb@example.com' } }))
    await utimes(file, at, at)
    expect(await accountLabel(join(home, '.claude'), home)).toBe('aaa@example.com')
    const later = new Date('2026-11-01T10:00:05Z')
    await utimes(file, later, later)
    expect(await accountLabel(join(home, '.claude'), home)).toBe('bbb@example.com')
    await rm(file)
    expect(await accountLabel(join(home, '.claude'), home)).toBe(join('~', '.claude'))
  })

  test('a dir outside home is shown as is', async () => {
    const home = await tmpHome()
    const other = await tmpHome()
    expect(await accountLabel(other, home)).toBe(other)
  })
})

describe('who an account is', () => {
  const signIn = async (dir: string, o: { email: string; org?: string; orgName?: string }) => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '.claude.json'), JSON.stringify({
      oauthAccount: { emailAddress: o.email, ...(o.org ? { organizationUuid: o.org } : {}), ...(o.orgName ? { organizationName: o.orgName } : {}) }
    }))
  }

  test('the email and the organisation, from the profile; null when nobody is signed in', async () => {
    const home = await tmpHome()
    await signIn(join(home, 'a'), { email: 'me@x.com', org: 'org-1', orgName: 'Acme' })
    expect(await accountIdentity(join(home, 'a'), home)).toEqual({ email: 'me@x.com', org: 'org-1', orgName: 'Acme' })
    await signIn(join(home, 'b'), { email: 'me@x.com' })
    expect(await accountIdentity(join(home, 'b'), home)).toEqual({ email: 'me@x.com', org: null, orgName: null })
    expect(await accountIdentity(join(home, 'none'), home)).toBeNull()
  })

  test('one email in two organisations is two accounts', () => {
    const a = { email: 'me@x.com', org: 'org-1', orgName: 'Acme' }
    expect(sameAccount(a, { ...a })).toBe(true)
    expect(sameAccount(a, { email: 'me@x.com', org: 'org-2', orgName: 'Other' })).toBe(false)
    expect(sameAccount(a, { email: 'me@x.com', org: null, orgName: null })).toBe(false)
    expect(sameAccount(a, { email: 'ME@x.com', org: 'org-1', orgName: 'Acme' })).toBe(true)
    expect(sameAccount(a, { email: 'you@x.com', org: 'org-1', orgName: 'Acme' })).toBe(false)
  })

  test('labels: the email; accounts sharing an email add their organisation, or Personal', async () => {
    const home = await tmpHome()
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((n) => join(home, n))
    await signIn(a, { email: 'me@x.com', org: 'org-1', orgName: 'Acme' })
    await signIn(b, { email: 'me@x.com' })
    await signIn(c, { email: 'other@x.com', org: 'org-9', orgName: 'Nine' })
    const labels = await accountLabels([a, b, c, d], home)
    expect(labels.get(a)).toBe('me@x.com · Acme')
    expect(labels.get(b)).toBe('me@x.com · Personal')
    expect(labels.get(c)).toBe('other@x.com')
    expect(labels.get(d)).toBe(join('~', 'd')) // nobody signed in: its folder
  })
})
