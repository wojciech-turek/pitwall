import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { launcherChoice, sessionBackendKind } from '../../src/main/backend'
import { usesHostLauncher } from '../../src/main/sessions/starter'
import { execPlan } from '../../src/main/exec'
import { buildSessionEnv, buildSshCommand, withoutGhTokens } from '../../src/main/identity'
import { resolvePaths } from '../../src/main/paths'
import { appUserModelId, findGitBash, openInCursorCommand, shellTabArgv, windowsPowerShell } from '../../src/main/platform'
import {
  parseWindowsPs, snapshotLeftovers, startedAround, stopLeftovers, stopProcessTree, toFileTime, windowsEndScript, WINDOWS_PS_SCRIPT
} from '../../src/main/sessions/leftovers'
import { teardownSpawn } from '../../src/main/sessions/teardown'
import type { Tmux } from '../../src/main/tmux'
import { TmuxBackend } from '../../src/main/tmux-backend'
import { resolveShellEnv } from '../../src/main/shell-env'
import {
  deleteEnv, envValue, findWindowsExecutable, mergeEnv, quoteWindowsArg, windowsCommand, windowsShellCommand
} from '../../src/host/win-command'
import type { Project } from '../../src/shared/types'

const HOME = 'C:\\Users\\Zoë Łukasz'
const WIN_ENV = {
  APPDATA: `${HOME}\\AppData\\Roaming`, LOCALAPPDATA: `${HOME}\\AppData\\Local`, USERPROFILE: HOME,
  SystemRoot: 'C:\\WINDOWS', ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe', PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS',
  Path: 'C:\\WINDOWS\\system32;"C:\\Program Files\\Git\\cmd";C:\\Program Files\\PowerShell\\7;C:\\stub'
}
/** A fake disk: these files exist (compared case-insensitively, as on Windows). */
const disk = (...files: string[]) => (p: string) => files.some((f) => f.toLowerCase() === p.toLowerCase())

/** How a Windows program's C runtime splits its command line (CommandLineToArgvW), to check the quoting against. */
function parseCommandLine(s: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < s.length) {
    while (s[i] === ' ' || s[i] === '\t') i++
    if (i >= s.length) break
    let arg = ''
    let quoted = false
    for (; i < s.length; i++) {
      const c = s[i]
      if (c === '\\') {
        let n = 0
        while (s[i] === '\\') { n++; i++ }
        if (s[i] === '"') {
          arg += '\\'.repeat(Math.floor(n / 2))
          if (n % 2) arg += '"'
          else quoted = !quoted
        } else {
          arg += '\\'.repeat(n)
          i--
        }
        continue
      }
      if (c === '"') { quoted = !quoted; continue }
      if (!quoted && (c === ' ' || c === '\t')) break
      arg += c
    }
    out.push(arg)
  }
  return out
}

describe('paths on Windows', () => {
  test('data in %APPDATA%\\pitwall, worktrees in %USERPROFILE%\\pitwall\\worktrees, keys in %USERPROFILE%\\.ssh', () => {
    const p = resolvePaths(WIN_ENV, HOME, { platform: 'win32' })
    expect(p.dataDir).toBe(`${HOME}\\AppData\\Roaming\\pitwall`)
    expect(p.stateFile).toBe(`${HOME}\\AppData\\Roaming\\pitwall\\state.json`)
    expect(p.sessionsDir).toBe(`${HOME}\\AppData\\Roaming\\pitwall\\sessions`)
    expect(p.binDir).toBe(`${HOME}\\AppData\\Roaming\\pitwall\\bin`)
    expect(p.worktreesRoot).toBe(`${HOME}\\pitwall\\worktrees`)
    expect(p.sshDir).toBe(`${HOME}\\.ssh`)
    expect(p).toMatchObject({ claudeBin: 'claude', ghBin: 'gh' })
  })

  test('a dev build uses pitwall-dev; without APPDATA it is found under the profile; overrides still win', () => {
    expect(resolvePaths(WIN_ENV, HOME, { platform: 'win32', dev: true })).toMatchObject({
      dataDir: `${HOME}\\AppData\\Roaming\\pitwall-dev`, worktreesRoot: `${HOME}\\pitwall\\worktrees-dev`
    })
    expect(resolvePaths({}, HOME, { platform: 'win32' }).dataDir).toBe(`${HOME}\\AppData\\Roaming\\pitwall`)
    expect(resolvePaths({ ...WIN_ENV, PITWALL_DATA_DIR: 'D:\\pw' }, HOME, { platform: 'win32' }).dataDir).toBe('D:\\pw')
  })

  test('macOS is unchanged when asked explicitly', () => {
    expect(resolvePaths({}, '/Users/w', { platform: 'darwin' }).dataDir).toBe('/Users/w/Library/Application Support/pitwall')
  })
})

describe('session backend', () => {
  test("tmux can't run the host's launcher", async () => {
    const tmux = { newSession: async () => {} } as unknown as Tmux
    await expect(new TmuxBackend(tmux, {}).newSession({ name: 'pw-x', cwd: '/', argv: [], launcher: { kind: 'claude', sessionDir: '/s' } }))
      .rejects.toThrow(/launcher/)
  })

  test("Claude starts through the host's launcher on Windows; pitwall-launch elsewhere unless asked (with the host)", () => {
    expect(launcherChoice({}, 'win32')).toBe('host')
    expect(launcherChoice({}, 'darwin')).toBe('script')
    expect(launcherChoice({ PITWALL_LAUNCHER: 'host' }, 'darwin')).toBe('script') // tmux can't
    expect(launcherChoice({ PITWALL_LAUNCHER: 'host', PITWALL_SESSION_BACKEND: 'host' }, 'darwin')).toBe('host')
    expect(usesHostLauncher({ platform: 'win32' })).toBe(true)
    expect(usesHostLauncher({ platform: 'darwin' })).toBe(false)
    expect(usesHostLauncher({ platform: 'darwin', launcher: 'host' })).toBe(true)
  })

  test('Windows always uses the host (no tmux there); macOS keeps tmux unless asked', () => {
    expect(sessionBackendKind({}, 'win32')).toBe('host')
    expect(sessionBackendKind({ PITWALL_SESSION_BACKEND: 'tmux' }, 'win32')).toBe('host')
    expect(sessionBackendKind({}, 'darwin')).toBe('tmux')
    expect(sessionBackendKind({ PITWALL_SESSION_BACKEND: 'host' }, 'darwin')).toBe('host')
  })
})

describe('environment on Windows', () => {
  test('no login shell: the app environment as it is, keeping the user\'s own CLAUDE_CODE_* settings', async () => {
    const base = { Path: 'C:\\x', CLAUDE_CODE_GIT_BASH_PATH: 'D:\\Git\\bin\\bash.exe', CLAUDE_CODE_USE_BEDROCK: '1' }
    const env = await resolveShellEnv({ platform: 'win32', base, shell: '/nonexistent/shell' })
    expect(env).toEqual(base)
  })

  test('started from inside Claude (CLAUDECODE set): the nested-Claude markers are dropped', async () => {
    const env = await resolveShellEnv({
      platform: 'win32', shell: '/nonexistent/shell',
      base: { Path: 'C:\\x', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: '7', OTHER: 'y' }
    })
    expect(env).toEqual({ Path: 'C:\\x', OTHER: 'y' })
  })

  test('variable names match whatever their case on Windows only', () => {
    expect(envValue({ Path: 'a' }, 'PATH')).toBe('a')
    expect(envValue({ Path: 'a' }, 'PATH', 'darwin')).toBeUndefined()
    expect(mergeEnv({ Path: 'a', X: '1' }, { PATH: 'b' }, 'win32')).toEqual({ PATH: 'b', X: '1' })
    expect(mergeEnv({ Path: 'a' }, { PATH: 'b' }, 'darwin')).toEqual({ Path: 'a', PATH: 'b' })
    const e = { gh_token: 'x', GH_TOKEN: 'y', KEEP: '1' }
    deleteEnv(e, 'GH_TOKEN', 'win32')
    expect(e).toEqual({ KEEP: '1' })
  })

  test('inherited GitHub tokens are dropped in any spelling on Windows (gh reads them that way)', () => {
    const env = { Gh_Token: 'a', github_token: 'b', GH_ENTERPRISE_TOKEN: 'c', GITHUB_ENTERPRISE_TOKEN: 'd', Path: 'p' }
    expect(withoutGhTokens(env, 'win32')).toEqual({ Path: 'p' })
    expect(withoutGhTokens({ GH_TOKEN: 'a', Gh_Token: 'b' }, 'darwin')).toEqual({ Gh_Token: 'b' })
  })
})

describe('identity on Windows', () => {
  test('GIT_SSH_COMMAND: forward slashes in double quotes, spaces and non-ASCII names intact', () => {
    expect(buildSshCommand(`${HOME}\\.ssh\\id_ed25519`, HOME, 'win32'))
      .toBe('ssh -i "C:/Users/Zoë Łukasz/.ssh/id_ed25519" -o IdentitiesOnly=yes')
    expect(buildSshCommand('~\\.ssh\\work key', HOME, 'win32'))
      .toBe('ssh -i "C:/Users/Zoë Łukasz/.ssh/work key" -o IdentitiesOnly=yes')
    expect(buildSshCommand('~/.ssh/id', HOME, 'win32')).toBe('ssh -i "C:/Users/Zoë Łukasz/.ssh/id" -o IdentitiesOnly=yes')
    // Characters Git's sh would expand inside double quotes are escaped.
    expect(buildSshCommand('C:\\keys\\$a`b', HOME, 'win32')).toBe('ssh -i "C:/keys/\\$a\\`b" -o IdentitiesOnly=yes')
    // macOS unchanged.
    expect(buildSshCommand('/k/id x', '/Users/w', 'darwin')).toBe("ssh -i '/k/id x' -o IdentitiesOnly=yes")
  })

  const project: Project = {
    id: 'p', name: 'P', createdAt: 0, extraEnv: [{ key: 'CACHE', value: '~\\cache' }],
    identity: { sshKeyPath: `${HOME}\\.ssh\\id`, ghAccount: 'dev-work', gitName: 'Jane', gitEmail: 'j@x.io' }
  }
  const input = {
    project, session: { id: 's_1', title: 'T' }, rootPath: 'C:\\r', sessionDir: 'C:\\d\\s_1', eventsFile: 'C:\\d\\s_1\\events.jsonl',
    claudeBin: 'claude', ghBin: 'gh', home: HOME, platform: 'win32' as const
  }

  test('the session environment uses the Windows forms; ~ in extra variables expands to the profile', () => {
    const env = buildSessionEnv(input)
    expect(env.GIT_SSH_COMMAND).toBe('ssh -i "C:/Users/Zoë Łukasz/.ssh/id" -o IdentitiesOnly=yes')
    expect(env.CACHE).toBe(`${HOME}\\cache`)
    expect(env.PITWALL_GIT_BASH).toBeUndefined()
  })

  test('Git Bash is recorded only for chaining the user\'s own status line', () => {
    const bash = 'C:\\Program Files\\Git\\bin\\bash.exe'
    expect(buildSessionEnv({ ...input, gitBash: bash }).PITWALL_GIT_BASH).toBeUndefined()
    expect(buildSessionEnv({ ...input, gitBash: bash, userStatusLine: '~/sl.sh' })).toMatchObject({
      PITWALL_USER_STATUSLINE: '~/sl.sh', PITWALL_GIT_BASH: bash
    })
  })
})

describe('finding and starting programs on Windows', () => {
  test('PATH with PATHEXT, in order; quoted PATH entries; never an extensionless file', () => {
    const isFile = disk(
      'C:\\stub\\claude', 'C:\\stub\\claude.cmd', 'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\WINDOWS\\system32\\where.exe'
    )
    expect(findWindowsExecutable('claude', WIN_ENV, isFile)).toBe('C:\\stub\\claude.cmd')
    expect(findWindowsExecutable('git', WIN_ENV, isFile)).toBe('C:\\Program Files\\Git\\cmd\\git.exe')
    expect(findWindowsExecutable('pwsh.exe', WIN_ENV, isFile)).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    expect(findWindowsExecutable('nope', WIN_ENV, isFile)).toBeNull()
    expect(findWindowsExecutable('C:\\stub\\claude', WIN_ENV, isFile)).toBe('C:\\stub\\claude.cmd')
    expect(findWindowsExecutable('D:/tools/x.exe', WIN_ENV, disk('D:/tools/x.exe'))).toBe('D:/tools/x.exe')
    // Not the current folder: only PATH.
    expect(findWindowsExecutable('claude', { Path: '' }, () => true)).toBeNull()
  })

  test('only programs and batch files, whatever else PATHEXT lists', () => {
    const env = { ...WIN_ENV, PATHEXT: '.VBS;.JS;.PS1;.CMD;.EXE' }
    expect(findWindowsExecutable('claude', env, disk('C:\\stub\\claude.js', 'C:\\stub\\claude.ps1', 'C:\\stub\\claude.exe'))).toBe('C:\\stub\\claude.exe')
    expect(findWindowsExecutable('claude', env, disk('C:\\stub\\claude.cmd', 'C:\\stub\\claude.exe'))).toBe('C:\\stub\\claude.cmd') // PATHEXT order
    expect(findWindowsExecutable('claude.js', env, disk('C:\\stub\\claude.js'))).toBeNull() // never a script run as itself
  })

  test('the PowerShell scripts: ASCII only (Windows PowerShell reads BOM-less files in the ANSI code page), no progress bars', () => {
    for (const name of ['pitwall-hook.ps1', 'pitwall-statusline.ps1']) {
      const text = readFileSync(resolve(__dirname, '../../resources/bin', name), 'utf8')
      expect(/^[\x00-\x7f]*$/.test(text)).toBe(true)
      expect(text).toContain("$ProgressPreference = 'SilentlyContinue'")
      expect(text.trimEnd().endsWith('exit 0')).toBe(true)
    }
  })

  test('argument quoting survives the C runtime\'s splitting (random strings)', () => {
    const alphabet = ['a', 'Z', ' ', '\t', '\\', '"', 'é', 'Ł', '&', '%', '^', "'", '$']
    let seed = 7
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n }
    for (let i = 0; i < 2000; i++) {
      const args = Array.from({ length: 1 + rnd(4) }, () => Array.from({ length: rnd(10) }, () => alphabet[rnd(alphabet.length)]).join(''))
      expect(parseCommandLine(args.map(quoteWindowsArg).join(' '))).toEqual(args)
    }
    expect(quoteWindowsArg('plain')).toBe('plain')
    expect(quoteWindowsArg('')).toBe('""')
    expect(quoteWindowsArg('C:\\a b\\')).toBe('"C:\\a b\\\\"')
  })

  test('an .exe starts directly, with its full path and a C-runtime command line', () => {
    const c = windowsCommand('claude', ['--session-id', 'u-1', '--settings', 'C:/a b/hooks.json', '--name', 'Fix "tax" & co'],
      WIN_ENV, disk('C:\\stub\\claude.exe'))
    expect(c.file).toBe('C:\\stub\\claude.exe')
    expect(c.verbatim).toBe(false)
    expect(c.args).toEqual(['--session-id', 'u-1', '--settings', 'C:/a b/hooks.json', '--name', 'Fix "tax" & co'])
    expect(parseCommandLine(c.commandLine)).toEqual(c.args)
  })

  test('a .cmd runs through cmd.exe, every argument escaped for cmd twice (it passes them on with %*)', () => {
    const c = windowsCommand('claude', ['--name', 'a & b'], WIN_ENV, disk('C:\\stub\\claude.cmd'))
    expect(c.file).toBe('C:\\WINDOWS\\system32\\cmd.exe')
    expect(c.verbatim).toBe(true)
    expect(c.args).toEqual(['/d', '/s', '/c', '"C:\\stub\\claude.cmd ^^^"--name^^^" ^^^"a^^^ ^^^&^^^ b^^^""'])
    expect(c.commandLine).toBe(c.args.join(' '))
    const spaced = windowsCommand('C:\\Program Files\\cursor\\bin\\cursor.cmd', ['C:\\w\\x'], WIN_ENV, () => true)
    expect(spaced.args[3]).toBe('"C:\\Program^ Files\\cursor\\bin\\cursor.cmd ^^^"C:\\w\\x^^^""')
    // A line break can't cross cmd: it becomes a space.
    expect(windowsCommand('x.cmd', ['a\r\nb'], WIN_ENV, disk('C:\\stub\\x.cmd')).args[3]).toBe('"C:\\stub\\x.cmd ^^^"a^^^ b^^^""')
  })

  test('a name that isn\'t found is left alone (starting it fails as "not found")', () => {
    expect(windowsCommand('cursor', ['C:\\w'], WIN_ENV, () => false)).toMatchObject({ file: 'cursor', args: ['C:\\w'], verbatim: false })
  })

  test('exec: Windows plans through PATH; macOS spawns exactly what it was given', () => {
    expect(execPlan('gh', ['auth', 'status'], { ...WIN_ENV, Path: 'C:\\stub' }, 'win32', disk('C:\\stub\\gh.cmd')))
      .toMatchObject({ file: 'C:\\WINDOWS\\system32\\cmd.exe', verbatim: true })
    expect(execPlan('gh', ['auth', 'status'], { PATH: '/x' }, 'darwin', () => true))
      .toEqual({ file: 'gh', args: ['auth', 'status'], verbatim: false })
  })

  test('shell commands (setup, teardown) run as cmd /d /s /c "…", as Node\'s shell option does', () => {
    expect(windowsShellCommand('pnpm install && echo "done"', WIN_ENV))
      .toEqual({ file: 'C:\\WINDOWS\\system32\\cmd.exe', args: ['/d', '/s', '/c', '"pnpm install && echo "done""'], verbatim: true,
        commandLine: '/d /s /c "pnpm install && echo "done""' })
    expect(windowsShellCommand('x', { SystemRoot: 'C:\\Win' }).file).toBe('C:\\Win\\System32\\cmd.exe')
    expect(windowsShellCommand('x', {}).file).toBe('cmd.exe')
  })
})

describe('teardown and leftovers on Windows', () => {
  test('teardown runs in cmd.exe with the session env, not in a new process group', () => {
    expect(teardownSpawn('docker compose down', WIN_ENV, 'win32')).toEqual({
      file: 'C:\\WINDOWS\\system32\\cmd.exe', args: ['/d', '/s', '/c', '"docker compose down"'], verbatim: true, detached: false
    })
    expect(teardownSpawn('docker compose down', {}, 'darwin')).toEqual({
      file: '/bin/sh', args: ['-c', 'docker compose down'], verbatim: false, detached: true
    })
  })

  // pid ppid created (FILETIME), as WINDOWS_PS_SCRIPT prints them.
  const LIST = [
    '4 0 100',
    '900 4 1000', // the host
    '4242 900 2000', // a pane
    '5000 4242 3000', // what it started
    '5001 5000 3500', // and below that
    '5100 4242 1500', // older than the pane: its real parent died long ago and 4242 was reused since
    '5200 5100 3600', // below the stale one: not reached
    '6000 900 500', // older than the host: the pid 900 had before the host took it
    `${process.pid} 5000 500`, // Pitwall, older than 5000: its parent died and 5000 is someone else now
    '7000 1 3000' // unrelated
  ].join('\r\n')

  test('the process list: pid, parent and creation time per line', () => {
    expect(parseWindowsPs('  12 4 133\r\n\r\nnot a row\r\n7 0 99')).toEqual([
      { pid: 12, ppid: 4, start: '133' }, { pid: 7, ppid: 0, start: '99' }
    ])
    expect(WINDOWS_PS_SCRIPT).toContain('Get-CimInstance Win32_Process')
    expect(WINDOWS_PS_SCRIPT).toContain('ToFileTimeUtc()')
  })

  test('leftovers: the host\'s panes and what they started, each newer than its parent; never the host or Pitwall', async () => {
    const snap = await snapshotLeftovers([4242, 6000, 7000], 900, { platform: 'win32', ps: async () => LIST })
    expect([...snap].sort()).toEqual([[4242, '2000'], [5000, '3000'], [5001, '3500']])
    expect(await snapshotLeftovers([4242], null, { platform: 'win32', ps: async () => LIST })).toEqual(new Map())
    // A pane pid that isn't the host's child (or a host the list doesn't show): nothing.
    expect(await snapshotLeftovers([4242], 901, { platform: 'win32', ps: async () => LIST })).toEqual(new Map())
    expect(await snapshotLeftovers([4242], 900, { platform: 'win32', ps: async () => { throw new Error('no powershell') } })).toEqual(new Map())
  })

  test('ending: only what still runs with the same creation time, by taskkill /F /PID (never /T), each checked again', async () => {
    const snap = new Map([[4242, '2000'], [5000, '3000'], [5001, '3500']])
    const ended: Array<[number, string]>[] = []
    // 5000 is gone and its pid taken by a newer process; 5001 is gone.
    await stopLeftovers(snap, { platform: 'win32', ps: async () => '4242 900 2000\r\n5000 1 9000', end: async (t) => { ended.push(t) } })
    expect(ended).toEqual([[[4242, '2000']]])
    const script = windowsEndScript([[4242, '2000'], [5001, '3500']])
    expect(script).toContain("Join-Path $env:SystemRoot 'System32\\taskkill.exe'")
    expect(script).toContain('$pids = @(4242,5001)')
    expect(script).toContain("$starts = @('2000','3500')")
    expect(script).toContain('& $taskkill /F /PID $id')
    expect(script).not.toMatch(/\/T\b/)
    // All opened first (their pids can't be reused while held), then one listing, then the matching ones ended.
    const opened = script.indexOf('$null = $p.Handle')
    const listed = script.indexOf('Get-CimInstance Win32_Process')
    const killed = script.indexOf('& $taskkill')
    expect(opened).toBeGreaterThan(0)
    expect(listed).toBeGreaterThan(opened)
    expect(killed).toBeGreaterThan(listed)
    expect(script.split('Get-CimInstance').length - 1).toBe(1)
    expect(script).toContain('$held.ContainsKey($id) -and $created[$id] -eq $starts[$i]')
    expect(script.indexOf('$p.Dispose()')).toBeGreaterThan(killed)
  })

  test('a teardown that ran too long: its own tree, walked by creation time, if the root is still the one started', async () => {
    const spawned = Date.UTC(2026, 9, 30, 12, 0, 0)
    const at = (ms: number) => toFileTime(ms).toString()
    const list = [
      `900 4 ${at(spawned - 60_000)}`, `4242 900 ${at(spawned + 30)}`, `5000 4242 ${at(spawned + 2000)}`, `5100 4242 ${at(spawned - 9000)}`
    ].join('\r\n')
    const ended: Array<[number, string]>[] = []
    const end = async (t: Array<[number, string]>) => { ended.push(t) }
    await stopProcessTree(4242, spawned, { ps: async () => list, end })
    expect(ended.map((t) => t.map(([p]) => p).sort())).toEqual([[4242, 5000]])
    // The command exited as the time ran out and 4242 went to another process before the list: nothing is ended.
    ended.length = 0
    await stopProcessTree(4242, spawned - 60_000, { ps: async () => list, end })
    await stopProcessTree(4242, spawned + 60_000, { ps: async () => list, end })
    await stopProcessTree(7777, spawned, { ps: async () => list, end })
    expect(ended).toEqual([])
    await expect(stopProcessTree(1, spawned, { ps: async () => { throw new Error('x') } })).resolves.toBeUndefined()
    expect(startedAround(at(spawned + 4000), spawned)).toBe(true)
    expect(startedAround(at(spawned - 6000), spawned)).toBe(false)
  })

  test('a pane the host started at another time is not that pane (its pid was reused)', async () => {
    const t0 = Date.UTC(2026, 9, 30, 12, 0, 0)
    const at = (ms: number) => toFileTime(ms).toString()
    const list = [`900 4 ${at(t0)}`, `4242 900 ${at(t0 + 60_000)}`, `5000 4242 ${at(t0 + 61_000)}`].join('\r\n')
    const ps = async () => list
    expect([...(await snapshotLeftovers([4242], 900, { platform: 'win32', ps, paneStartedAt: new Map([[4242, t0 + 60_010]]) })).keys()])
      .toEqual(expect.arrayContaining([4242, 5000]))
    expect(await snapshotLeftovers([4242], 900, { platform: 'win32', ps, paneStartedAt: new Map([[4242, t0 + 10_000]]) })).toEqual(new Map())
  })
})

describe('programs Pitwall starts on Windows', () => {
  test('the Shell tab: pwsh if on PATH, else Windows PowerShell by its full path; macOS a login shell', () => {
    expect(shellTabArgv('win32', WIN_ENV, disk('C:\\Program Files\\PowerShell\\7\\pwsh.exe')))
      .toEqual(['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-NoLogo'])
    expect(shellTabArgv('win32', WIN_ENV, () => false))
      .toEqual(['C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-NoLogo'])
    expect(windowsPowerShell({})).toBe('powershell.exe')
    expect(shellTabArgv('darwin', { SHELL: '/bin/bash' }, () => true)).toEqual(['/bin/bash', '-l'])
    expect(shellTabArgv('darwin', {}, () => true)).toEqual(['/bin/zsh', '-l'])
  })

  test('Git Bash as Claude Code finds it: its own variable, beside git on PATH, or the usual folders', () => {
    expect(findGitBash({ ...WIN_ENV, CLAUDE_CODE_GIT_BASH_PATH: 'D:\\G\\bash.exe' }, disk('D:\\G\\bash.exe'))).toBe('D:\\G\\bash.exe')
    expect(findGitBash({ ...WIN_ENV, CLAUDE_CODE_GIT_BASH_PATH: 'D:\\G\\bash.exe' }, () => false)).toBeNull()
    expect(findGitBash(WIN_ENV, disk('C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\bash.exe')))
      .toBe('C:\\Program Files\\Git\\bin\\bash.exe')
    expect(findGitBash({ ...WIN_ENV, Path: '', ProgramFiles: 'C:\\PF' }, disk('C:\\PF\\Git\\bin\\bash.exe'))).toBe('C:\\PF\\Git\\bin\\bash.exe')
    expect(findGitBash({ LOCALAPPDATA: 'C:\\L' }, disk('C:\\L\\Programs\\Git\\bin\\bash.exe'))).toBe('C:\\L\\Programs\\Git\\bin\\bash.exe')
    expect(findGitBash(WIN_ENV, () => false)).toBeNull()
  })

  test('Open in Cursor: `cursor` on PATH on Windows, the app by name on macOS', () => {
    expect(openInCursorCommand('C:\\w t', 'win32')).toEqual({ file: 'cursor', args: ['C:\\w t'] })
    expect(openInCursorCommand('/w', 'darwin')).toEqual({ file: 'open', args: ['-a', 'Cursor', '/w'] })
  })

  test('the app user model id (dev builds have their own)', () => {
    expect(appUserModelId(false)).toBe('com.wojciechturek.pitwall')
    expect(appUserModelId(true)).toBe('com.wojciechturek.pitwall.dev')
  })
})
