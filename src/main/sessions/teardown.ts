import { spawn } from 'node:child_process'
import { comSpec } from '../../host/win-command'
import { stopProcessTree } from './leftovers'

export const TEARDOWN_LIMIT_MS = 120_000
const KEEP_BYTES = 4096

export interface TeardownResult { exitCode: number | null; timedOut: boolean; output: string }

/** The variable the teardown command reaches the inner cmd.exe in (Windows). */
export const TEARDOWN_COMMAND_VAR = 'PITWALL_TEARDOWN_CMD'

/** How the teardown command starts. Pure, for tests. */
export function teardownSpawn(
  command: string, env: Record<string, string>, platform: NodeJS.Platform
): { file: string; args: string[]; verbatim: boolean; detached: boolean; env?: Record<string, string> } {
  if (platform === 'win32') {
    // The command runs in cmd.exe exactly as Node's `shell: true` runs one (`cmd /d /s /c "<command>"`), inside an
    // outer cmd that first switches its console to UTF-8: cmd's built-ins (echo, cd, its own errors) write the
    // console's OEM code page, and the output is read as UTF-8. (The console is the command's own, hidden: stdio
    // isn't inherited.) The command never passes through the outer cmd's parsing: it arrives in a variable, which the
    // outer cmd's delayed expansion (/v:on) puts on the inner cmd's command line after the outer line is parsed, so
    // the inner cmd gets it byte for byte (its own %-expansion, quotes, &&: as before). Checked on Windows against the
    // plain form: quoted %VAR% values with & | < > ^, && chains, a value holding %OTHER%, literal !: all identical.
    // No process groups on Windows: on timeout the command's tree is walked.
    const cs = comSpec(env)
    return {
      file: cs,
      args: ['/d', '/v:on', '/s', '/c', `"chcp 65001>nul & "${cs}" /d /s /c "!${TEARDOWN_COMMAND_VAR}!""`],
      verbatim: true, detached: false, env: { [TEARDOWN_COMMAND_VAR]: command }
    }
  }
  return { file: '/bin/sh', args: ['-c', command], verbatim: false, detached: true }
}

/**
 * Runs a shell command (sh; cmd.exe on Windows) in its own process group. Keeps only the last 4 KB of combined
 * output. On timeout the whole group is killed (Windows: the command and what it started, each checked by creation
 * time). Resolves as soon as the shell exits or the limit hits, even if a background child still holds the output
 * pipes.
 */
export function runTeardown(
  command: string,
  o: {
    cwd: string; env: Record<string, string>; timeoutMs?: number; platform?: NodeJS.Platform
    /** Windows: ends the command's process tree, started at `startedAt` ms (a test seam; default stopProcessTree). */
    stopTree?: (pid: number, startedAt: number) => Promise<void>
  }
): Promise<TeardownResult> {
  return new Promise((resolve) => {
    let tail = Buffer.alloc(0)
    let settled = false
    const platform = o.platform ?? process.platform
    const plan = teardownSpawn(command, o.env, platform)
    const startedAt = Date.now() // Windows: the tree's root is checked against this before anything is ended
    const child = spawn(plan.file, plan.args, {
      cwd: o.cwd, env: plan.env ? { ...o.env, ...plan.env } : o.env, detached: plan.detached, stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true, windowsVerbatimArguments: plan.verbatim
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
      if (!child.pid) return
      if (platform === 'win32') return void (o.stopTree ?? stopProcessTree)(child.pid, startedAt)
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
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
