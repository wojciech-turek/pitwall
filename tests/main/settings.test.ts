import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import {
  buildHookSettings, findUserStatusLine, forwardSlashes, hookCommandFor, HOOK_EVENTS, quoteForBashAndPowerShell,
  statusLineCommandFor, windowsHookCommand, windowsStatusLineCommand
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
  const made: string[] = []
  afterAll(async () => { for (const d of made) await rm(d, { recursive: true, force: true }) })
  async function dirs() {
    const base = await mkdtemp(join(tmpdir(), 'pitwall-sl-settings-'))
    made.push(base)
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

describe('Windows hooks and status line', () => {
  const ps = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  const bin = 'C:\\Users\\Zoë Łukasz\\AppData\\Roaming\\pitwall\\bin'
  const sd = 'C:\\Users\\Zoë Łukasz\\AppData\\Roaming\\pitwall\\sessions/s_1'

  test('hooks: exec form, every path with forward slashes, spaces and non-ASCII names as they are', () => {
    const h = windowsHookCommand(ps, `${bin}\\pitwall-hook.ps1`, `${sd}/events.jsonl`, 's_1')
    expect(h).toEqual({
      command: 'C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        'C:/Users/Zoë Łukasz/AppData/Roaming/pitwall/bin/pitwall-hook.ps1',
        'C:/Users/Zoë Łukasz/AppData/Roaming/pitwall/sessions/s_1/events.jsonl', 's_1']
    })
    const s = buildHookSettings(h, 'sl')
    expect(Object.keys(s.hooks)).toEqual([...HOOK_EVENTS])
    for (const e of HOOK_EVENTS) expect(s.hooks[e]).toEqual([{ hooks: [{ type: 'command', ...h, timeout: 10 }] }])
    expect(s.statusLine).toEqual({ type: 'command', command: 'sl', padding: 0 })
    // The macOS form is unchanged: a shell command, no args.
    expect(buildHookSettings('cmd').hooks.Stop[0].hooks[0]).toEqual({ type: 'command', command: 'cmd', timeout: 10 })
  })

  test('the status line: a command Git Bash and PowerShell both read the same way', () => {
    expect(windowsStatusLineCommand(`${bin}\\pitwall-statusline.ps1`, sd)).toBe(
      "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " +
      "'C:/Users/Zoë Łukasz/AppData/Roaming/pitwall/bin/pitwall-statusline.ps1' 'C:/Users/Zoë Łukasz/AppData/Roaming/pitwall/sessions/s_1'")
    // A user called O'Brien: double quotes, which neither shell expands here.
    expect(windowsStatusLineCommand("C:\\Users\\O'Brien\\sl.ps1", "C:\\Users\\O'Brien\\s"))
      .toBe('powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:/Users/O\'Brien/sl.ps1" "C:/Users/O\'Brien/s"')
    // Nothing reads the same in both: no status line rather than a wrong one.
    expect(windowsStatusLineCommand("C:\\Users\\O'B$x\\sl.ps1", 'C:\\s')).toBeUndefined()
  })

  test('quoting for both shells', () => {
    expect(quoteForBashAndPowerShell('C:/a b/c')).toBe("'C:/a b/c'")
    expect(quoteForBashAndPowerShell('C:/$x`y')).toBe("'C:/$x`y'")
    expect(quoteForBashAndPowerShell("it's")).toBe('"it\'s"')
    expect(quoteForBashAndPowerShell('it’s')).toBe('"it’s"') // PowerShell ends single quotes at ’ too
    for (const bad of ["it's $x", "it's `x", 'it’s "x"', "it's \\x", 'it’s “x”']) expect(quoteForBashAndPowerShell(bad)).toBeNull()
    expect(forwardSlashes('C:\\a\\b/c')).toBe('C:/a/b/c')
  })
})
