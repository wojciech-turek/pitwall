import { describe, expect, test } from 'vitest'
import { sessionBackendKind } from '../../src/main/backend'
import { execPlan } from '../../src/main/exec'
import { buildSessionEnv, buildSshCommand, withoutGhTokens } from '../../src/main/identity'
import { resolvePaths } from '../../src/main/paths'
import { appUserModelId, findGitBash, openInCursorCommand, shellTabArgv, windowsPowerShell } from '../../src/main/platform'
import { killPaneTrees, taskkillArgs } from '../../src/main/sessions/leftovers'
import { teardownSpawn } from '../../src/main/sessions/teardown'
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

  test('each pane\'s process tree is ended with taskkill; never the host, Pitwall or a system process', async () => {
    expect(taskkillArgs(4242)).toEqual(['/T', '/F', '/PID', '4242'])
    const calls: string[][] = []
    const run = async (file: string, args: string[]) => { calls.push([file, ...args]) }
    await killPaneTrees([4242, 4242, 5151, 900, process.pid, 4, 0, -1], 900, { run })
    expect(calls).toEqual([['taskkill', '/T', '/F', '/PID', '4242'], ['taskkill', '/T', '/F', '/PID', '5151']])
    calls.length = 0
    await killPaneTrees([4242], null, { run })
    expect(calls).toEqual([]) // no host, no panes of its own
    await expect(killPaneTrees([4242], 900, { run: async () => { throw new Error('not found') } })).resolves.toBeUndefined()
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
