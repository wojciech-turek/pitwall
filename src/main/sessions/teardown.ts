import { spawn } from 'node:child_process'

export const TEARDOWN_LIMIT_MS = 120_000
const KEEP_BYTES = 4096

export interface TeardownResult { exitCode: number | null; timedOut: boolean; output: string }

/**
 * Runs a shell command in its own process group. Keeps only the last 4 KB of combined output.
 * On timeout the whole group is killed. Resolves as soon as the shell exits or the limit hits, even if a
 * background child still holds the output pipes.
 */
export function runTeardown(
  command: string,
  o: { cwd: string; env: Record<string, string>; timeoutMs?: number }
): Promise<TeardownResult> {
  return new Promise((resolve) => {
    let tail = Buffer.alloc(0)
    let settled = false
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: o.cwd, env: o.env, detached: true, stdio: ['ignore', 'pipe', 'pipe']
    })
    const take = (b: Buffer): void => {
      tail = Buffer.concat([tail, b])
      if (tail.length > KEEP_BYTES * 2) tail = tail.subarray(tail.length - KEEP_BYTES)
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    const finish = (r: Omit<TeardownResult, 'output'>, extra = ''): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout?.destroy()
      child.stderr?.destroy()
      const output = Buffer.concat([tail]).subarray(-KEEP_BYTES).toString('utf8') + extra
      resolve({ ...r, output })
    }
    const killGroup = (): void => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
    }
    const timer = setTimeout(() => {
      killGroup()
      finish({ exitCode: null, timedOut: true })
    }, o.timeoutMs ?? TEARDOWN_LIMIT_MS)
    child.on('error', (e) => finish({ exitCode: null, timedOut: false }, `\n${e.message}`))
    // Let the last output chunks arrive before reading the tail.
    child.on('exit', (code, signal) => setTimeout(() => finish({ exitCode: code ?? (signal ? null : 0), timedOut: false }), 50))
  })
}
