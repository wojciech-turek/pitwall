import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { exec } from '../../src/main/exec'
import { resolveShellEnv, utf8LangFor } from '../../src/main/shell-env'
import { WINDOWS } from '../helpers/processes'

// What a Dock/Finder launch hands the app: no LANG/LC_*, no CLAUDE* vars, a minimal PATH.
const FINDER = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir() }
const all = () => true

const tmps: string[] = []
afterEach(async () => {
  for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true })
})

/** A fake login shell: sets the given exports, then runs the command like `sh -c`. */
async function fakeShell(exports: string): Promise<string> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'pitwall-shell-'))
  tmps.push(tmp)
  const file = path.join(tmp, 'shell')
  await writeFile(file, `#!/bin/sh\n${exports}\nshift\nexec /bin/sh -c "$1"\n`)
  await chmod(file, 0o755)
  return file
}

// The login shell (zsh, sh): macOS only. Windows takes the app's own environment (windows-platform.test.ts).
describe.skipIf(WINDOWS)('resolveShellEnv', () => {
  test('Finder-like minimal PATH still finds tmux', { timeout: 60_000 }, async () => {
    const real = (await exec('/bin/zsh', ['-ilc', 'command -v tmux'])).stdout.trim().split('\n').pop() ?? ''
    if (!real.startsWith('/')) return // no tmux on this machine's login shell
    const env = await resolveShellEnv({ shell: '/bin/zsh', base: FINDER })
    expect(env.PATH.split(':')).toContain(path.dirname(real))
    expect(env.TMUX).toBeUndefined()
  })

  test('TMUX and TMUX_PANE are removed even when inherited', { timeout: 60_000 }, async () => {
    const env = await resolveShellEnv({
      shell: '/bin/zsh',
      base: { PATH: '/usr/bin:/bin', HOME: os.homedir(), TMUX: '/x,1,0', TMUX_PANE: '%1' }
    })
    expect(env.TMUX).toBeUndefined()
    expect(env.TMUX_PANE).toBeUndefined()
  })

  test('broken shell falls back to augmented PATH', async () => {
    const env = await resolveShellEnv({ shell: '/nonexistent', base: { PATH: '/usr/bin:/bin', HOME: '/Users/x' } })
    expect(env.PATH.startsWith('/opt/homebrew/bin:/usr/local/bin:/Users/x/.local/bin:')).toBe(true)
  })

  test('Finder-like env without LANG/LC_* gets a UTF-8 LANG from the login shell path', { timeout: 60_000 }, async () => {
    const env = await resolveShellEnv({ shell: '/bin/zsh', base: FINDER })
    expect([env.LC_ALL, env.LC_CTYPE, env.LANG].some((v) => v && /utf-?8/i.test(v))).toBe(true)
    if (!env.LC_ALL && !env.LC_CTYPE) expect(env.LANG).toMatch(/^[A-Za-z_]+\.UTF-8$/)
  })

  test('LANG is derived from AppleLocale, on both the shell and the fallback path', async () => {
    const shell = await fakeShell(':')
    const env = await resolveShellEnv({ shell, base: FINDER, appleLocale: async () => 'en_GB' })
    expect(env.LANG).toBe('en_GB.UTF-8')
    const fb = await resolveShellEnv({ shell: '/nonexistent', base: FINDER, appleLocale: async () => 'en_US@rg=plzzzz' })
    expect(fb.LANG).toBe('en_US.UTF-8')
    const none = await resolveShellEnv({ shell: '/nonexistent', base: FINDER, appleLocale: async () => undefined })
    expect(none.LANG).toBe('en_US.UTF-8')
  })

  test('an existing UTF-8 setting is left alone', async () => {
    const shell = await fakeShell(':')
    const locale = async () => 'en_GB'
    expect((await resolveShellEnv({ shell, base: { ...FINDER, LANG: 'pl_PL.UTF-8' }, appleLocale: locale })).LANG)
      .toBe('pl_PL.UTF-8')
    const ctype = await resolveShellEnv({ shell, base: { ...FINDER, LC_CTYPE: 'UTF-8' }, appleLocale: locale })
    expect(ctype.LANG).toBeUndefined()
    expect(ctype.LC_CTYPE).toBe('UTF-8')
    const rc = await fakeShell('export LC_ALL=en_US.utf8')
    expect((await resolveShellEnv({ shell: rc, base: FINDER, appleLocale: locale })).LANG).toBeUndefined()
  })

  test('a non-UTF-8 LANG is replaced', async () => {
    const shell = await fakeShell(':')
    const env = await resolveShellEnv({ shell, base: { ...FINDER, LANG: 'C' }, appleLocale: async () => 'en_GB' })
    expect(env.LANG).toBe('en_GB.UTF-8')
  })

  test('nested-Claude markers are stripped; CLAUDE_CODE_* set by the user\'s own rc files survive', async () => {
    const nested = { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SSE_PORT: '123', CLAUDE_PID: '42' }
    const shell = await fakeShell('export CLAUDE_CODE_USE_BEDROCK=1')
    const env = await resolveShellEnv({ shell, base: { ...FINDER, ...nested }, appleLocale: async () => 'en_GB' })
    for (const k of Object.keys(nested)) expect(env[k]).toBeUndefined()
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1')
    const fb = await resolveShellEnv({ shell: '/nonexistent', base: { ...FINDER, ...nested } })
    for (const k of Object.keys(nested)) expect(fb[k]).toBeUndefined()
  })
})

describe('utf8LangFor', () => {
  test('derives <locale>.UTF-8, strips @ modifiers, falls back to en_US.UTF-8', () => {
    expect(utf8LangFor('en_GB', all)).toBe('en_GB.UTF-8')
    expect(utf8LangFor('en_US@rg=plzzzz', all)).toBe('en_US.UTF-8')
    expect(utf8LangFor('pl_PL@currency=PLN', all)).toBe('pl_PL.UTF-8')
    expect(utf8LangFor(undefined, all)).toBe('en_US.UTF-8')
    expect(utf8LangFor('', all)).toBe('en_US.UTF-8')
    expect(utf8LangFor('garbage value; rm -rf', all)).toBe('en_US.UTF-8')
  })

  test('a locale macOS does not ship (en_PL) falls back', () => {
    expect(utf8LangFor('en_PL', (n) => n !== 'en_PL.UTF-8')).toBe('en_US.UTF-8')
  })
})
