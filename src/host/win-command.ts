/**
 * Starting programs on Windows without a shell, as cmd.exe would find and run them: a bare name is looked up on PATH
 * with PATHEXT (never in the current folder, so a worktree can't plant a `claude.exe`), and a `.cmd`/`.bat` file
 * (npm shims, `cursor.cmd`, the tests' stubs) runs through cmd.exe with every argument escaped to arrive intact.
 * Shared by the app (exec) and the host (launcher). Pure: the file system is injected.
 */
import { win32 } from 'node:path'

export type IsFile = (path: string) => boolean
type Env = Record<string, string | undefined>

/** A variable's value; on Windows a name matches whatever its case (`Path` and `PATH` are one variable). */
export function envValue(env: Env, name: string, platform: NodeJS.Platform = 'win32'): string | undefined {
  if (env[name] !== undefined || platform !== 'win32') return env[name]
  const upper = name.toUpperCase()
  const key = Object.keys(env).find((k) => k.toUpperCase() === upper && env[k] !== undefined)
  return key === undefined ? undefined : env[key]
}

/** `base` with `extra` laid over it. On Windows a variable replaces any spelling of its name (no `Path` + `PATH`). */
export function mergeEnv(
  base: Record<string, string>, extra: Record<string, string>, platform: NodeJS.Platform
): Record<string, string> {
  if (platform !== 'win32') return { ...base, ...extra }
  const out = { ...base }
  for (const [k, v] of Object.entries(extra)) {
    deleteEnv(out, k, platform)
    out[k] = v
  }
  return out
}

/** Removes a variable (on Windows: every spelling of its name). */
export function deleteEnv(env: Record<string, string>, name: string, platform: NodeJS.Platform): void {
  if (platform !== 'win32') {
    delete env[name]
    return
  }
  const upper = name.toUpperCase()
  for (const k of Object.keys(env)) if (k.toUpperCase() === upper) delete env[k]
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'
/** What Pitwall can start: programs, and batch files through cmd.exe (never .vbs, .js, .ps1… from PATHEXT). */
const RUNNABLE = new Set(['.com', '.exe', '.bat', '.cmd'])

/**
 * The file Windows would run for `name`: a path is tried as given (with each PATHEXT extension if it has none), a bare
 * name in each PATH folder. Only .com, .exe, .bat and .cmd, in PATHEXT's order; an extensionless file is never
 * picked (npm puts a POSIX `claude` script beside `claude.cmd`). Null if nothing matches.
 */
export function findWindowsExecutable(name: string, env: Env, isFile: IsFile): string | null {
  const exts = (envValue(env, 'PATHEXT') || DEFAULT_PATHEXT).split(';')
    .map((e) => e.trim().toLowerCase()).filter((e) => RUNNABLE.has(e))
  const hasExt = exts.includes(win32.extname(name).toLowerCase())
  const candidates = (base: string): string[] => (hasExt ? [base] : exts.map((e) => base + e))
  if (/[\\/]/.test(name) || win32.isAbsolute(name)) {
    return candidates(name).find(isFile) ?? null
  }
  for (const raw of (envValue(env, 'PATH') ?? '').split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1')
    if (!dir) continue
    const hit = candidates(win32.join(dir, name)).find(isFile)
    if (hit) return hit
  }
  return null
}

/** One argument as the C runtime (CommandLineToArgvW) splits a command line: quoted only when it has to be. */
export function quoteWindowsArg(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg
  let out = '"'
  let backslashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++
      continue
    }
    out += ch === '"' ? '\\'.repeat(backslashes * 2 + 1) + '"' : '\\'.repeat(backslashes) + ch
    backslashes = 0
  }
  return out + '\\'.repeat(backslashes * 2) + '"'
}

// cmd.exe's special characters, escaped with ^ (the method of https://qntm.org/cmd, as cross-spawn does).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

/**
 * An argument to a batch file on a `cmd /d /s /c "…"` line. Escaped twice: once for that line, once more because the
 * batch file passes it on (`%*`), which cmd parses again. cmd can't carry a line break: it becomes a space.
 */
function batchArg(arg: string): string {
  let a = arg.replace(/[\r\n]+/g, ' ')
  a = a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')
  return `"${a}"`.replace(CMD_META, '^$1').replace(CMD_META, '^$1')
}

/**
 * How to start a program on Windows. `args` with `verbatim` is for child_process (windowsVerbatimArguments);
 * `commandLine` is the same arguments as one string, for node-pty (which takes a ready command line on Windows).
 */
export interface WindowsCommand { file: string; args: string[]; verbatim: boolean; commandLine: string }

export function comSpec(env: Env): string {
  const root = envValue(env, 'SystemRoot')
  return envValue(env, 'ComSpec') || (root ? win32.join(root, 'System32', 'cmd.exe') : 'cmd.exe')
}

const viaCmd = (line: string, env: Env): WindowsCommand => {
  const args = ['/d', '/s', '/c', `"${line}"`]
  return { file: comSpec(env), args, verbatim: true, commandLine: args.join(' ') }
}

/**
 * `file` with `args`, found on PATH. A batch file goes through cmd.exe; anything else starts directly. A name that
 * isn't found is left as it is (starting it then fails with "not found").
 */
export function windowsCommand(file: string, args: string[], env: Env, isFile: IsFile): WindowsCommand {
  const found = findWindowsExecutable(file, env, isFile) ?? file
  if (/\.(cmd|bat)$/i.test(found)) {
    return viaCmd([found.replace(CMD_META, '^$1'), ...args.map(batchArg)].join(' '), env)
  }
  return { file: found, args, verbatim: false, commandLine: args.map(quoteWindowsArg).join(' ') }
}

/** A command line for cmd.exe, as Node's `shell: true` runs it (`cmd /d /s /c "…"`): the user's own setup/teardown. */
export function windowsShellCommand(command: string, env: Env): WindowsCommand {
  return viaCmd(command, env)
}
