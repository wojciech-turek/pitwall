import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { exec } from '../../src/main/exec'
import {
  applyRepoIdentity, buildSessionEnv, buildSshCommand, claudeConfigDir, getGhToken, identityMatches, listGhAccounts,
  listSshKeys, readRepoIdentity, renderEnvFile, shellQuote
} from '../../src/main/identity'
import type { Project } from '@shared/types'

const gh = resolve('tests/fixtures/bin/gh')
const home = homedir()
const tmp = () => mkdtemp(join(tmpdir(), 'pitwall-id-'))

const project: Project = {
  id: 'p1', name: 'P', createdAt: 0,
  identity: { sshKeyPath: '~/.ssh/id_ed25519_work', ghAccount: 'dev-work', gitName: 'Jane Doe', gitEmail: 'jane@example.com' },
  extraEnv: []
}
const base = {
  project, session: { id: 's1', title: 'T' }, rootPath: '/r', sessionDir: '/sd', eventsFile: '/e.jsonl',
  claudeBin: '/bin/claude', ghBin: '/bin/gh', home: '/home/u'
}

describe('identity', () => {
  test('listSshKeys picks private keys only', async () => {
    const dir = await tmp()
    await writeFile(join(dir, 'id_a'), 'x')
    await writeFile(join(dir, 'id_a.pub'), 'x')
    await writeFile(join(dir, 'raw'), '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n')
    for (const f of ['config', 'config.bak-20260917', 'known_hosts', 'known_hosts.old', 'notes.txt']) await writeFile(join(dir, f), 'hello')
    await mkdir(join(dir, 'sub'))
    expect(await listSshKeys(dir)).toEqual([`${dir}/id_a`, `${dir}/raw`])
    expect(await listSshKeys(join(dir, 'missing'))).toEqual([])
  })

  test('listGhAccounts parses gh json', async () => {
    expect(await listGhAccounts(gh, exec, {})).toEqual([
      { login: 'dev-personal', active: true, ok: true },
      { login: 'dev-work', active: false, ok: true }
    ])
  })

  test('getGhToken per account, never switches', async () => {
    const log = join(await tmp(), 'gh.log')
    const env = { STUB_GH_LOG: log }
    expect(await getGhToken(gh, 'dev-work', exec, env)).toBe('token-for-dev-work')
    expect(await getGhToken(gh, 'nobody', exec, env)).toBeNull()
    const lines = (await readFile(log, 'utf8')).split('\n')
    expect(lines.some((l) => l.includes('--user dev-work'))).toBe(true)
    expect(lines.some((l) => l.includes('switch'))).toBe(false)
  })

  test('getGhToken ignores inherited token env vars', async () => {
    const log = join(await tmp(), 'gh.log')
    await getGhToken(gh, 'dev-work', exec, { STUB_GH_LOG: log, GH_TOKEN: 'inherited', GITHUB_TOKEN: 'inherited' })
    const out = await readFile(log, 'utf8')
    expect(out).toContain('GH_TOKEN=unset')
    expect(out).toContain('GITHUB_TOKEN=unset')
  })

  test('shellQuote', () => expect(shellQuote("it's $HOME")).toBe(`'it'"'"'s $HOME'`))

  test('buildSshCommand expands ~ and quotes', () =>
    expect(buildSshCommand('~/.ssh/id_ed25519_work', home)).toBe(`ssh -i '${home}/.ssh/id_ed25519_work' -o IdentitiesOnly=yes`))

  test('buildSessionEnv', () => {
    const env = buildSessionEnv(base)
    expect(Object.keys(env).sort()).toEqual([
      'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_SSH_COMMAND',
      'PITWALL_CLAUDE_BIN', 'PITWALL_EVENTS_FILE', 'PITWALL_GH_ACCOUNT', 'PITWALL_GH_BIN', 'PITWALL_ROOT_PATH',
      'PITWALL_SESSION_DIR', 'PITWALL_SESSION_ID', 'PITWALL_TITLE'
    ])
    expect(env.GIT_SSH_COMMAND).toBe("ssh -i '/home/u/.ssh/id_ed25519_work' -o IdentitiesOnly=yes")
    expect(env.PITWALL_GH_ACCOUNT).toBe('dev-work')
    expect(buildSessionEnv({ ...base, setupCommand: 'pnpm i' }).PITWALL_SETUP_COMMAND).toBe('pnpm i')
    const withExtra = buildSessionEnv({ ...base, project: { ...project, extraEnv: [{ key: 'CLAUDE_CONFIG_DIR', value: '/x' }] } })
    expect(withExtra.CLAUDE_CONFIG_DIR).toBe('/x')
    const bad = (key: string) => () => buildSessionEnv({ ...base, project: { ...project, extraEnv: [{ key, value: '1' }] } })
    expect(bad('PITWALL_X')).toThrow(/reserved/)
    expect(bad('1BAD')).toThrow(/invalid/)
  })

  test('the user status line is passed on as PITWALL_USER_STATUSLINE, only when there is one', () => {
    expect(buildSessionEnv({ ...base, userStatusLine: '~/.claude/line.sh --x' }).PITWALL_USER_STATUSLINE).toBe('~/.claude/line.sh --x')
    expect('PITWALL_USER_STATUSLINE' in buildSessionEnv({ ...base, userStatusLine: '' })).toBe(false)
  })

  test("claudeConfigDir: the project's CLAUDE_CONFIG_DIR (~ expanded, last one wins), else the app's, else ~/.claude", () => {
    const withDir = (...values: string[]) => ({ ...project, extraEnv: values.map((value) => ({ key: 'CLAUDE_CONFIG_DIR', value })) })
    expect(claudeConfigDir(project, '/home/u')).toBe('/home/u/.claude')
    expect(claudeConfigDir(project, '/home/u', { CLAUDE_CONFIG_DIR: '/shell/claude' })).toBe('/shell/claude')
    expect(claudeConfigDir(withDir('~/.claude-work'), '/home/u', { CLAUDE_CONFIG_DIR: '/shell/claude' })).toBe('/home/u/.claude-work')
    expect(claudeConfigDir(withDir('/a', '/b'), '/home/u')).toBe('/b')
    expect(claudeConfigDir(withDir(''), '/home/u')).toBe('/home/u/.claude')
  })

  test('extraEnv values: a leading ~/ (or a bare ~) means the home folder', () => {
    const env = buildSessionEnv({
      ...base,
      project: { ...project, extraEnv: [
        { key: 'A', value: '~/.claude-work' }, { key: 'B', value: '~' }, { key: 'C', value: 'x~/y' }, { key: 'D', value: '~other/z' }
      ] }
    })
    expect(env).toMatchObject({ A: '/home/u/.claude-work', B: '/home/u', C: 'x~/y', D: '~other/z' })
  })

  test('renderEnvFile round-trips through sh', async () => {
    const file = join(await tmp(), 'env.sh')
    await writeFile(file, renderEnvFile({ PITWALL_TITLE: "Fix 'tax' $ rounding 🧾", P: '/a b/c' }))
    const r = await exec('sh', ['-c', '. "$0"; printf %s "$PITWALL_TITLE|$P"', file])
    expect(r.stdout).toBe("Fix 'tax' $ rounding 🧾|/a b/c")
  })

  test('no ssh key: env omits GIT_SSH_COMMAND, apply leaves core.sshCommand alone', async () => {
    const noKey = { ...project, identity: { ...project.identity, sshKeyPath: '', ghAccount: '' } }
    const env = buildSessionEnv({ ...base, project: noKey })
    expect('GIT_SSH_COMMAND' in env).toBe(false)
    expect(env.PITWALL_GH_ACCOUNT).toBe('')
    const dir = await tmp()
    const globalCfg = join(dir, 'global')
    await writeFile(globalCfg, '')
    const genv = { GIT_CONFIG_GLOBAL: globalCfg, GIT_CONFIG_NOSYSTEM: '1' }
    const repo = join(dir, 'repo')
    await mkdir(repo)
    expect((await exec('git', ['init', repo], { env: genv })).code).toBe(0)
    await exec('git', ['-C', repo, 'config', '--local', 'core.sshCommand', 'ssh -i custom'], { env: genv })
    await applyRepoIdentity(repo, noKey.identity, exec, genv, home)
    const cur = await readRepoIdentity(repo, exec, genv)
    expect(cur.sshCommand).toBe('ssh -i custom')
    expect(identityMatches(cur, noKey.identity, home)).toBe(true)
  })

  test('apply/read repo identity is local only, identityMatches', async () => {
    const dir = await tmp()
    const globalCfg = join(dir, 'global')
    await writeFile(globalCfg, '')
    const env = { GIT_CONFIG_GLOBAL: globalCfg, GIT_CONFIG_NOSYSTEM: '1' }
    const repo = join(dir, 'repo')
    await mkdir(repo)
    expect((await exec('git', ['init', repo], { env })).code).toBe(0)
    expect(await readRepoIdentity(repo, exec, env)).toEqual({})
    await applyRepoIdentity(repo, project.identity, exec, env, home)
    const cur = await readRepoIdentity(repo, exec, env)
    expect(cur).toEqual({ sshCommand: buildSshCommand(project.identity.sshKeyPath, home), name: 'Jane Doe', email: 'jane@example.com' })
    expect(await readFile(globalCfg, 'utf8')).toBe('')
    expect(identityMatches(cur, project.identity, home)).toBe(true)
    expect(identityMatches({ ...cur, email: 'other@x.com' }, project.identity, home)).toBe(false)
  })
})
