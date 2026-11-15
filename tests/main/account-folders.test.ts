import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  copyProfileKeys, copyProjectEntry, createAccountFolder, linkShared, profileFile, removeAccountFolder,
  LINKED_DIRS, LINKED_FILES, PROFILE_KEYS
} from '../../src/main/account-folders'

const WINDOWS = process.platform === 'win32'
let tmp: string
let def: string
let root: string
let dir: string

beforeEach(async () => {
  tmp = realpathSync(await mkdtemp(join(tmpdir(), 'pitwall-acctdir-')))
  def = join(tmp, 'home', '.claude')
  root = join(tmp, 'data', 'claude-accounts')
  mkdirSync(join(def, 'projects'), { recursive: true })
  writeFileSync(join(def, 'projects', 'keep.jsonl'), 'history')
  writeFileSync(join(def, 'settings.json'), '{"theme":"dark"}')
  dir = await createAccountFolder(root, 'a1')
})
afterEach(() => rm(tmp, { recursive: true, force: true }))

const json = (f: string): unknown => JSON.parse(readFileSync(f, 'utf8'))
/** Every path under a folder with its size and mtime: what must not change in the default folder. */
function tree(d: string): string[] {
  return readdirSync(d, { recursive: true, withFileTypes: true })
    .map((e) => { const p = join(e.parentPath, e.name); const st = lstatSync(p); return `${p} ${st.size} ${st.mtimeMs}` }).sort()
}

describe('an added account\'s folder', () => {
  test('is made inside the accounts folder, private to the user', () => {
    expect(dir).toBe(join(root, 'a1'))
    expect(statSync(dir).isDirectory()).toBe(true)
    if (!WINDOWS) expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  test('what is shared and what is not', () => {
    expect(LINKED_DIRS).toEqual(['projects', 'todos', 'plans', 'file-history', 'shell-snapshots', 'commands', 'agents', 'skills', 'plugins'])
    expect(LINKED_FILES).toEqual(['settings.json', 'CLAUDE.md', 'keybindings.json'])
    expect(PROFILE_KEYS).toEqual(['mcpServers', 'hasCompletedOnboarding', 'lastOnboardingVersion'])
    for (const never of ['.claude.json', '.credentials.json', 'sessions', 'statsig']) {
      expect([...LINKED_DIRS, ...LINKED_FILES]).not.toContain(never)
    }
  })

  test('links every shared item that exists in the default folder and skips the rest', async () => {
    await linkShared(dir, def)
    expect(realpathSync(join(dir, 'projects'))).toBe(realpathSync(join(def, 'projects')))
    expect(readFileSync(join(dir, 'projects', 'keep.jsonl'), 'utf8')).toBe('history')
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
    expect(existsSync(join(dir, 'plugins'))).toBe(false)
    expect(readdirSync(dir).sort()).toEqual(['projects', 'settings.json'])
  })

  test.skipIf(WINDOWS)('a linked file is a link, so a later edit of the default one shows', async () => {
    await linkShared(dir, def)
    expect(lstatSync(join(dir, 'settings.json')).isSymbolicLink()).toBe(true)
    writeFileSync(join(def, 'settings.json'), '{"theme":"light"}')
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe('{"theme":"light"}')
  })

  test('on Windows: junctions for folders, copies for files', async () => {
    const made: Array<[string, string, string | undefined]> = []
    await linkShared(dir, def, 'win32', async (target, path, type) => { made.push([target, path, type]) })
    expect(made).toEqual([[join(def, 'projects'), join(dir, 'projects'), 'junction']])
    expect(lstatSync(join(dir, 'settings.json')).isFile()).toBe(true)
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
  })

  test('picks up an item that appears in the default folder later, and running it again changes nothing else', async () => {
    await linkShared(dir, def)
    mkdirSync(join(def, 'plugins'))
    await linkShared(dir, def)
    expect(realpathSync(join(dir, 'plugins'))).toBe(realpathSync(join(def, 'plugins')))
    expect(readdirSync(dir).sort()).toEqual(['plugins', 'projects', 'settings.json'])
  })

  test('never replaces a real file or folder already in the account', async () => {
    writeFileSync(join(dir, 'settings.json'), '{"mine":true}')
    mkdirSync(join(dir, 'projects'))
    await linkShared(dir, def)
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe('{"mine":true}')
    expect(lstatSync(join(dir, 'projects')).isSymbolicLink()).toBe(false)
  })

  test('with no default folder at all, nothing is linked and nothing is created there', async () => {
    await linkShared(dir, join(tmp, 'nowhere'))
    expect(readdirSync(dir)).toEqual([])
    expect(existsSync(join(tmp, 'nowhere'))).toBe(false)
  })
})

describe('the profile file (.claude.json)', () => {
  test("the built-in default keeps it beside its folder; any other folder inside", () => {
    const home = join(tmp, 'home')
    expect(profileFile(join(home, '.claude'), home)).toBe(join(home, '.claude.json'))
    expect(profileFile(dir, home)).toBe(join(dir, '.claude.json'))
  })

  test('copies only the named keys and never the signed-in profile', async () => {
    const from = join(tmp, 'from.json')
    const to = join(dir, '.claude.json')
    writeFileSync(from, JSON.stringify({ mcpServers: { x: 1 }, hasCompletedOnboarding: true, oauthAccount: { emailAddress: 'a@x' }, userID: 'u', projects: { '/p': {} } }))
    writeFileSync(to, JSON.stringify({ oauthAccount: { emailAddress: 'b@x' } }))
    await copyProfileKeys(from, to, PROFILE_KEYS)
    expect(json(to)).toEqual({ oauthAccount: { emailAddress: 'b@x' }, mcpServers: { x: 1 }, hasCompletedOnboarding: true })
    if (!WINDOWS) expect(statSync(to).mode & 0o777).toBe(0o600)
  })

  test('a key asked for that is the profile itself is refused', async () => {
    const from = join(tmp, 'from.json')
    const to = join(dir, '.claude.json')
    writeFileSync(from, JSON.stringify({ oauthAccount: { emailAddress: 'a@x' }, userID: 'u' }))
    writeFileSync(to, JSON.stringify({ oauthAccount: { emailAddress: 'b@x' } }))
    await copyProfileKeys(from, to, ['oauthAccount', 'userID'])
    expect(json(to)).toEqual({ oauthAccount: { emailAddress: 'b@x' } })
  })

  test('a missing or corrupt source changes nothing; a missing destination is created', async () => {
    const to = join(dir, '.claude.json')
    await copyProfileKeys(join(tmp, 'none.json'), to, PROFILE_KEYS)
    expect(existsSync(to)).toBe(false)
    writeFileSync(join(tmp, 'bad.json'), '{ nope')
    await copyProfileKeys(join(tmp, 'bad.json'), to, PROFILE_KEYS)
    expect(existsSync(to)).toBe(false)
    writeFileSync(join(tmp, 'ok.json'), JSON.stringify({ mcpServers: { y: 2 } }))
    await copyProfileKeys(join(tmp, 'ok.json'), to, PROFILE_KEYS)
    expect(json(to)).toEqual({ mcpServers: { y: 2 } })
  })

  test('a corrupt destination is left as it is', async () => {
    const to = join(dir, '.claude.json')
    writeFileSync(to, '{ half')
    writeFileSync(join(tmp, 'ok.json'), JSON.stringify({ mcpServers: { y: 2 } }))
    await copyProfileKeys(join(tmp, 'ok.json'), to, PROFILE_KEYS)
    expect(readFileSync(to, 'utf8')).toBe('{ half')
  })

  test("copies one folder's entry (its trust and allowed tools), leaving the others", async () => {
    const from = join(tmp, 'from.json')
    const to = join(dir, '.claude.json')
    writeFileSync(from, JSON.stringify({ projects: { '/w/a': { hasTrustDialogAccepted: true, allowedTools: ['Bash'] }, '/w/b': { hasTrustDialogAccepted: true } } }))
    writeFileSync(to, JSON.stringify({ oauthAccount: { emailAddress: 'b@x' }, projects: { '/w/c': { hasTrustDialogAccepted: false } } }))
    await copyProjectEntry(from, to, '/w/a')
    expect(json(to)).toEqual({
      oauthAccount: { emailAddress: 'b@x' },
      projects: { '/w/c': { hasTrustDialogAccepted: false }, '/w/a': { hasTrustDialogAccepted: true, allowedTools: ['Bash'] } }
    })
    await copyProjectEntry(from, to, '/w/unknown') // nothing to copy: unchanged
    expect(Object.keys((json(to) as { projects: object }).projects)).toEqual(['/w/c', '/w/a'])
  })
})

describe('removing an account', () => {
  test("never touches what its links point at", async () => {
    await linkShared(dir, def)
    writeFileSync(join(dir, '.claude.json'), '{}')
    await removeAccountFolder(dir, root)
    expect(existsSync(dir)).toBe(false)
    expect(readFileSync(join(def, 'projects', 'keep.jsonl'), 'utf8')).toBe('history')
    expect(readFileSync(join(def, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
  })

  test('refuses a folder that is not directly inside the accounts folder', async () => {
    await expect(removeAccountFolder(def, root)).rejects.toThrow(/not an account folder/)
    await expect(removeAccountFolder(root, root)).rejects.toThrow(/not an account folder/)
    await expect(removeAccountFolder(join(root, 'a1', 'deeper'), root)).rejects.toThrow(/not an account folder/)
    await expect(removeAccountFolder(join(root, '..', 'claude-accounts-evil'), root)).rejects.toThrow(/not an account folder/)
    expect(existsSync(def)).toBe(true)
    expect(existsSync(dir)).toBe(true)
  })

  test('a folder already gone is fine', async () => {
    await removeAccountFolder(join(root, 'never'), root)
  })
})

test('creating, linking and copying write nothing into the default folder', async () => {
  const home = join(tmp, 'home')
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { x: 1 }, projects: { '/w/a': { hasTrustDialogAccepted: true } } }))
  const before = [...tree(def), ...tree(home)]
  await linkShared(dir, def)
  await copyProfileKeys(profileFile(def, home), profileFile(dir, home), PROFILE_KEYS)
  await copyProjectEntry(profileFile(def, home), profileFile(dir, home), '/w/a')
  await removeAccountFolder(dir, root)
  expect([...tree(def), ...tree(home)]).toEqual(before)
})

describe('review fixes', () => {
  test("several sessions moved at once each keep their folder's entry (no lost update)", async () => {
    const from = join(tmp, 'from.json')
    const to = join(dir, '.claude.json')
    const cwds = Array.from({ length: 8 }, (_, i) => `/w/s${i}`)
    writeFileSync(from, JSON.stringify({ projects: Object.fromEntries(cwds.map((c) => [c, { hasTrustDialogAccepted: true }])) }))
    writeFileSync(to, JSON.stringify({ oauthAccount: { emailAddress: 'b@x' } }))
    await Promise.all(cwds.map((c) => copyProjectEntry(from, to, c)))
    expect(Object.keys((json(to) as { projects: object }).projects).sort()).toEqual(cwds)
  })

  test('on Windows, copying settings again refreshes the copied files; without asking, a file there is left alone', async () => {
    const noLink = async (): Promise<void> => {}
    await linkShared(dir, def, 'win32', noLink)
    writeFileSync(join(def, 'settings.json'), '{"theme":"light"}')
    await linkShared(dir, def, 'win32', noLink)
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
    await linkShared(dir, def, 'win32', noLink, { refreshCopies: true })
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe('{"theme":"light"}')
  })

  test.skipIf(WINDOWS)('refreshing never replaces a link or follows one into the default folder', async () => {
    await linkShared(dir, def)
    await linkShared(dir, def, process.platform, undefined, { refreshCopies: true })
    expect(lstatSync(join(dir, 'settings.json')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(def, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
  })
})
