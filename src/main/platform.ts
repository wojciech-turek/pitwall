import { win32 } from 'node:path'
import { envValue, findWindowsExecutable, type IsFile } from '../host/win-command'

/**
 * Programs Pitwall starts that differ by OS. Pure (the file system is injected), so the Windows choices are tested on
 * any machine.
 */

type Env = Record<string, string | undefined>

/** Windows PowerShell, which every Windows 10/11 has: by its full path, never whatever `powershell.exe` is on PATH. */
export function windowsPowerShell(env: Env): string {
  const root = envValue(env, 'SystemRoot') || envValue(env, 'windir')
  return root ? win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe'
}

/** The Shell tab's program: PowerShell 7 (`pwsh`) if it is on PATH, else Windows PowerShell; elsewhere a login shell. */
export function shellTabArgv(platform: NodeJS.Platform, env: Env, isFile: IsFile): string[] {
  if (platform !== 'win32') return [envValue(env, 'SHELL', platform) || '/bin/zsh', '-l']
  return [findWindowsExecutable('pwsh.exe', env, isFile) ?? windowsPowerShell(env), '-NoLogo']
}

/**
 * Git Bash, where Claude Code on Windows runs shell commands (its status line, shell-form hooks) when it finds one:
 * CLAUDE_CODE_GIT_BASH_PATH, else beside the `git` on PATH, else the usual install folders. Null if there's none
 * (Claude Code then uses PowerShell).
 */
export function findGitBash(env: Env, isFile: IsFile): string | null {
  const set = envValue(env, 'CLAUDE_CODE_GIT_BASH_PATH')
  if (set) return isFile(set) ? set : null
  const candidates: string[] = []
  const git = findWindowsExecutable('git.exe', env, isFile)
  if (git) {
    // <Git>\cmd\git.exe or <Git>\bin\git.exe or <Git>\mingw64\bin\git.exe
    const dir = win32.dirname(git)
    candidates.push(win32.join(dir, '..', 'bin', 'bash.exe'), win32.join(dir, 'bash.exe'), win32.join(dir, '..', '..', 'bin', 'bash.exe'))
  }
  for (const v of ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)']) {
    const base = envValue(env, v)
    if (base) candidates.push(win32.join(base, 'Git', 'bin', 'bash.exe'))
  }
  const local = envValue(env, 'LOCALAPPDATA')
  if (local) candidates.push(win32.join(local, 'Programs', 'Git', 'bin', 'bash.exe'))
  return candidates.map((c) => win32.normalize(c)).find(isFile) ?? null
}

/** Opens a folder in Cursor: the app by name on macOS, its `cursor` command (cursor.cmd) on PATH elsewhere. */
export function openInCursorCommand(cwd: string, platform: NodeJS.Platform): { file: string; args: string[] } {
  return platform === 'darwin' ? { file: 'open', args: ['-a', 'Cursor', cwd] } : { file: 'cursor', args: [cwd] }
}

/** Windows ties notifications and the taskbar button to this id (the installer's shortcut carries the same one). */
export function appUserModelId(dev: boolean): string {
  return dev ? 'com.wojciechturek.pitwall.dev' : 'com.wojciechturek.pitwall'
}
