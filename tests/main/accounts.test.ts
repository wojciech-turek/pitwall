import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { accountKey, accountLabel } from '../../src/main/accounts'
import type { Project } from '@shared/types'

const mkProject = (dir?: string): Project => ({
  id: 'p1', name: 'P', createdAt: 0,
  identity: { sshKeyPath: '', ghAccount: '', gitName: 'a', gitEmail: 'a@b.c' },
  extraEnv: dir ? [{ key: 'CLAUDE_CONFIG_DIR', value: dir }] : []
})
const tmpHome = () => mkdtemp(join(tmpdir(), 'pitwall-acct-'))

describe('accountKey', () => {
  test('~/.claude-work and <home>/.claude-work/ are the same account', async () => {
    const home = await tmpHome()
    const a = accountKey(mkProject('~/.claude-work'), home, {})
    const b = accountKey(mkProject(join(home, '.claude-work') + '/'), home, {})
    expect(a).toBe(join(home, '.claude-work'))
    expect(b).toBe(a)
  })

  test('no CLAUDE_CONFIG_DIR is <home>/.claude', async () => {
    const home = await tmpHome()
    expect(accountKey(mkProject(), home, {})).toBe(join(home, '.claude'))
  })

  test('the app environment CLAUDE_CONFIG_DIR is used when the project has none', async () => {
    const home = await tmpHome()
    expect(accountKey(mkProject(), home, { CLAUDE_CONFIG_DIR: join(home, 'x') + '/' })).toBe(join(home, 'x'))
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
