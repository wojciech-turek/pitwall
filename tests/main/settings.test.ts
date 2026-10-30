import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  buildHookSettings, findUserStatusLine, hookCommandFor, HOOK_EVENTS, statusLineCommandFor
} from '../../src/main/hooks/settings'

test('hookCommandFor quotes paths with spaces', () =>
  expect(hookCommandFor('/a b/pitwall-hook', '/a b/events.jsonl', 's_1')).toBe(`'/a b/pitwall-hook' '/a b/events.jsonl' 's_1'`))

test('buildHookSettings registers every event with timeout 10 and no matcher', () => {
  const s = buildHookSettings('cmd')
  expect(Object.keys(s.hooks)).toEqual([...HOOK_EVENTS])
  for (const e of HOOK_EVENTS) {
    expect(s.hooks[e]).toEqual([{ hooks: [{ type: 'command', command: 'cmd', timeout: 10 }] }])
  }
  expect('statusLine' in s).toBe(false)
})

test('buildHookSettings adds the status line command', () => {
  const sl = statusLineCommandFor('/a b/pitwall-statusline', "/a b/sessions/s_1 it's")
  expect(sl).toBe(`'/a b/pitwall-statusline' '/a b/sessions/s_1 it'"'"'s'`)
  const s = buildHookSettings('cmd', sl)
  expect(s.statusLine).toEqual({ type: 'command', command: sl, padding: 0 })
  expect(s.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'cmd', timeout: 10 }] }])
})

describe('findUserStatusLine', () => {
  async function dirs() {
    const base = await mkdtemp(join(tmpdir(), 'pitwall-sl-settings-'))
    const cwd = join(base, 'work tree')
    const configDir = join(base, '.claude')
    await mkdir(join(cwd, '.claude'), { recursive: true })
    await mkdir(configDir, { recursive: true })
    return { cwd, configDir }
  }
  const put = (file: string, value: unknown) => writeFile(file, typeof value === 'string' ? value : JSON.stringify(value))
  const sl = (command: string) => ({ statusLine: { type: 'command', command } })

  test('local project settings win over project settings, which win over user settings', async () => {
    const { cwd, configDir } = await dirs()
    expect(await findUserStatusLine(cwd, configDir)).toBeUndefined()
    await put(join(configDir, 'settings.json'), { ...sl('user-line'), model: 'x' })
    expect(await findUserStatusLine(cwd, configDir)).toBe('user-line')
    await put(join(cwd, '.claude', 'settings.json'), sl('project-line'))
    expect(await findUserStatusLine(cwd, configDir)).toBe('project-line')
    await put(join(cwd, '.claude', 'settings.local.json'), sl('local-line'))
    expect(await findUserStatusLine(cwd, configDir)).toBe('local-line')
  })

  test('malformed files and status lines that are not commands are skipped', async () => {
    const { cwd, configDir } = await dirs()
    await put(join(configDir, 'settings.json'), sl('~/.claude/statusline.sh'))
    await put(join(cwd, '.claude', 'settings.local.json'), '{ not json')
    await put(join(cwd, '.claude', 'settings.json'), { statusLine: { type: 'static', command: 'nope' } })
    expect(await findUserStatusLine(cwd, configDir)).toBe('~/.claude/statusline.sh')
    for (const bad of [null, [], 'str', { statusLine: null }, { statusLine: { type: 'command', command: '  ' } },
      { statusLine: { type: 'command', command: 7 } }, { statusLine: { type: 'command' } }]) {
      await put(join(cwd, '.claude', 'settings.json'), JSON.stringify(bad))
      expect(await findUserStatusLine(cwd, configDir)).toBe('~/.claude/statusline.sh')
    }
  })

  test('a folder where a settings file should be is ignored', async () => {
    const { cwd, configDir } = await dirs()
    await mkdir(join(cwd, '.claude', 'settings.local.json'))
    await put(join(configDir, 'settings.json'), sl('user-line'))
    expect(await findUserStatusLine(cwd, configDir)).toBe('user-line')
  })
})
