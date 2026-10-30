import { spawn } from 'node:child_process'

export interface ExecResult { code: number; stdout: string; stderr: string }
export interface ExecOptions { cwd?: string; env?: Record<string, string>; timeoutMs?: number; input?: string }
export type Exec = (file: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>

const TIMEOUT_CODE = 124

/** Runs a command, collecting output. Resolves with the exit code; rejects only if the process cannot be spawned. */
export const exec: Exec = (file, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe']
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
