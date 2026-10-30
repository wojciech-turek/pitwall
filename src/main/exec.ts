import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { windowsCommand, type IsFile } from '../host/win-command'

export interface ExecResult { code: number; stdout: string; stderr: string }
export interface ExecOptions { cwd?: string; env?: Record<string, string>; timeoutMs?: number; input?: string }
export type Exec = (file: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>

const TIMEOUT_CODE = 124

export const isFile: IsFile = (p) => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * What to spawn for `file args`. Elsewhere exactly that. Windows: `file` is found on the PATH of `env` (PATHEXT), and
 * a `.cmd`/`.bat` (cursor.cmd, npm shims) runs through cmd.exe with its arguments escaped, since Node won't start one
 * directly.
 */
export function execPlan(
  file: string, args: string[], env: Record<string, string | undefined>, platform: NodeJS.Platform, exists: IsFile = isFile
): { file: string; args: string[]; verbatim: boolean } {
  if (platform !== 'win32') return { file, args, verbatim: false }
  const c = windowsCommand(file, args, env, exists)
  return { file: c.file, args: c.args, verbatim: c.verbatim }
}

/** Runs a command, collecting output. Resolves with the exit code; rejects only if the process cannot be spawned. */
export const exec: Exec = (file, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const plan = execPlan(file, args, opts.env ?? process.env, process.platform)
    const child = spawn(plan.file, plan.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Windows: no console window flashes up for each git/gh call from the app.
      windowsHide: true,
      windowsVerbatimArguments: plan.verbatim
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, opts.timeoutMs ?? 30000)

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(err.code === 'ENOENT' ? `Command not found: ${file}` : `Failed to run ${file}: ${err.message}`))
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const exitCode = timedOut ? TIMEOUT_CODE : (code ?? (signal ? 128 : 1))
      resolve({ code: exitCode, stdout, stderr })
    })

    child.stdin.on('error', () => {}) // EPIPE if the child exits before reading input
    child.stdin.end(opts.input)
  })
