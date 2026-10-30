/**
 * The launcher, run by the host itself (Windows has no sh for resources/bin/pitwall-launch). It does what that script
 * does, in the same terminal and with the same words:
 * - every launch reads the session's variables afresh (env.json, written beside env.sh), so an edited project
 *   identity applies from the next relaunch;
 * - with a GitHub account, the token is fetched per launch with inherited token variables removed, and lives only in
 *   Claude's environment (never argv or disk). No token: fail closed with an empty GH_CONFIG_DIR;
 * - the setup command runs once (`setup-done`), in sh (cmd.exe on Windows);
 * - Claude starts with `--session-id` the first time (`started`), then `--resume`; a resume that fails before Claude
 *   reported SessionStart falls back to a new conversation;
 * - when Claude exits: "Press Enter to resume.", and Enter relaunches it. End of input (Ctrl+D) or Ctrl+C at that
 *   prompt ends the terminal, as they end the script's `read`.
 * The Shell tab (`kind: 'shell'`) gets the same identity, then its shell, once.
 * Everything that touches the outside world (the pty, gh, the file system for PATH lookups) is injected.
 */
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deleteEnv, envValue, mergeEnv, windowsCommand, windowsShellCommand, type IsFile } from './win-command'

export type LauncherKind = 'claude' | 'shell'
/** What the app asks for: run this session's Claude (or its Shell tab) from its session folder. */
export interface LauncherSpec { kind: LauncherKind; sessionDir: string }

export interface PtyLike {
  readonly pid: number
  onData(cb: (data: string) => void): unknown
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown
  write(data: string | Buffer): void
  resize(cols: number, rows: number): void
}

/** `args` is a ready command line on Windows (node-pty takes one there), a list elsewhere. */
export type SpawnPty = (
  file: string, args: string[] | string, o: { cwd: string; env: Record<string, string>; cols: number; rows: number }
) => PtyLike
export type KillPty = (p: PtyLike, sig: 'SIGHUP' | 'SIGKILL') => void
/** The account's token, or null. Never throws. */
export type FetchToken = (ghBin: string, account: string, env: Record<string, string>) => Promise<string | null>

export interface LauncherOptions {
  spec: LauncherSpec
  cwd: string
  /** The Shell tab's program and its arguments (ignored for Claude). */
  argv: string[]
  /** What the host gives every session: its own environment and the request's. */
  env: Record<string, string>
  cols: number
  rows: number
  platform: NodeJS.Platform
  spawn: SpawnPty
  kill: KillPty
  fetchToken?: FetchToken
  isFile?: IsFile
  now?: () => number
}

/** Token variables gh reads before its own store; inherited ones must never stand in for a project's account. */
const TOKENS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']

/** The words the shell launcher uses (resources/bin/pitwall-launch); a test keeps the two in step. */
export const MESSAGES = {
  setup: (cmd: string) => `▸ Running setup: ${cmd}`,
  setupFailed: (rc: number) => `▸ Setup command failed (exit ${rc}). Starting Claude anyway.`,
  resumeFailed: () => "Couldn't resume the previous conversation — starting a new one.",
  exited: (rc: number) => `Claude exited (code ${rc}). Press Enter to resume.`,
  noToken: (account: string) =>
    `pitwall: couldn't get a GitHub token for ${account} — gh commands will run signed out. Check \`gh auth status\`.`
}

const isFileDefault: IsFile = (p) => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** `gh auth token` for the account, by execFile (the token only ever travels in a pipe). */
export function execFetchToken(platform: NodeJS.Platform, isFile: IsFile = isFileDefault): FetchToken {
  return (ghBin, account, env) => new Promise((resolve) => {
    const args = ['auth', 'token', '--hostname', 'github.com', '--user', account]
    const plan = platform === 'win32' ? windowsCommand(ghBin, args, env, isFile) : { file: ghBin, args, verbatim: false }
    try {
      execFile(plan.file, plan.args, {
        env, timeout: 15_000, windowsHide: true, windowsVerbatimArguments: plan.verbatim, encoding: 'utf8'
      }, (err, stdout) => resolve(!err && stdout.trim() ? stdout.trim() : null))
    } catch {
      resolve(null)
    }
  })
}

type Key = 'enter' | 'eof' | 'interrupt' | 'stopped'

export class Launcher {
  private current: PtyLike | null = null
  private stopping = false
  private finished = false
  private waiting: ((k: Key) => void) | null = null
  /** Keys typed while nothing runs (a terminal would keep them for the next program). */
  private pending: Array<string | Buffer> = []
  private pendingBytes = 0
  private cols: number
  private rows: number
  private dataCbs: Array<(d: string) => void> = []
  private exitCbs: Array<(code: number) => void> = []
  private readonly isFile: IsFile
  private readonly fetchToken: FetchToken
  private readonly now: () => number

  constructor(private readonly o: LauncherOptions) {
    this.cols = o.cols
    this.rows = o.rows
    this.isFile = o.isFile ?? isFileDefault
    this.fetchToken = o.fetchToken ?? execFetchToken(o.platform, this.isFile)
    this.now = o.now ?? Date.now
  }

  /** The program running now (Claude, setup or the shell); null while waiting for Enter. */
  get pid(): number | null {
    return this.current?.pid ?? null
  }

  onData(cb: (d: string) => void): void {
    this.dataCbs.push(cb)
  }

  onExit(cb: (code: number) => void): void {
    this.exitCbs.push(cb)
  }

  start(): void {
    void this.main().catch((e) => {
      this.print(`pitwall: ${msg(e)}`)
      this.finish(1)
    })
  }

  write(data: string | Buffer): void {
    if (this.current) return this.current.write(data)
    if (this.waiting) {
      const s = data.toString()
      // Only these answer the prompt (as `read` would end): terminal reports and other keys are dropped.
      const key: Key | null = /[\r\n]/.test(s) ? 'enter' : s.includes('\x04') ? 'eof' : s.includes('\x03') ? 'interrupt' : null
      if (key) this.answer(key)
      return
    }
    if (this.pendingBytes > 64 * 1024) return
    this.pending.push(data)
    this.pendingBytes += data.length
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.current?.resize(cols, rows)
  }

  /** Hangs up (or kills) what runs and ends the terminal; nothing is relaunched. */
  signal(sig: 'SIGHUP' | 'SIGKILL'): void {
    this.stopping = true
    if (this.current) return this.o.kill(this.current, sig)
    if (this.waiting) return this.answer('stopped')
    // Between programs (fetching the token, say): main() notices and ends.
  }

  // ---- the loop ---------------------------------------------------------------------

  private async main(): Promise<void> {
    if (this.o.spec.kind === 'shell') {
      const env = await this.launchEnv()
      if (this.stopping) return this.finish(129)
      const [file, ...args] = this.o.argv
      return this.finish(await this.run(file, args, env))
    }
    for (;;) {
      const rc = await this.runClaude()
      if (this.stopping) return this.finish(rc)
      this.print(MESSAGES.exited(rc))
      const key = await this.waitForKey()
      if (key === 'eof' || key === 'stopped') return this.finish(0)
      if (key === 'interrupt') return this.finish(130)
    }
  }

  /** One launch or resume, like the script's run_claude; returns Claude's exit code. */
  private async runClaude(): Promise<number> {
    const env = await this.launchEnv()
    const setup = envValue(env, 'PITWALL_SETUP_COMMAND', this.o.platform)
    const done = this.file('setup-done')
    if (setup && !existsSync(done) && !this.stopping) {
      this.print(MESSAGES.setup(setup))
      const rc = await this.runShellCommand(setup, env)
      if (this.stopping) return rc // killed during setup: it runs again next time, as with the script
      if (rc !== 0) this.print(MESSAGES.setupFailed(rc))
      writeFileSync(done, '')
    }
    if (this.stopping) return 129
    const id = readFileSync(this.file('claude-id'), 'utf8').trim()
    let rc: number
    if (!existsSync(this.file('started'))) {
      writeFileSync(this.file('started'), '')
      rc = await this.launchNew(id, env)
    } else {
      const before = this.eventLines(env).length
      this.logEvent(env, { e: 'pitwall:launch', mode: 'resume' })
      rc = await this.run(this.claudeBin(env), ['--resume', id, '--settings', this.file('hooks.json')], env)
      if (rc !== 0 && !this.stopping && !this.eventLines(env).slice(before).some(isSessionStart)) {
        this.logEvent(env, { e: 'pitwall:exited', code: rc })
        this.print(MESSAGES.resumeFailed())
        rc = await this.launchNew(id, env)
      }
    }
    // Killed: the script dies with its terminal and logs nothing more.
    if (!this.stopping) this.logEvent(env, { e: 'pitwall:exited', code: rc })
    return rc
  }

  private launchNew(id: string, env: Record<string, string>): Promise<number> {
    this.logEvent(env, { e: 'pitwall:launch', mode: 'new' })
    const title = envValue(env, 'PITWALL_TITLE', this.o.platform) ?? ''
    return this.run(this.claudeBin(env), ['--session-id', id, '--settings', this.file('hooks.json'), '--name', title], env)
  }

  /**
   * The environment for one launch: the host's, the session's variables (read now), and the GitHub token. Inherited
   * token variables never stand in for the project's account (gh prefers them, even for `gh auth token`).
   */
  private async launchEnv(): Promise<Record<string, string>> {
    const { platform } = this.o
    const session = this.readSessionEnv()
    const account = session.PITWALL_GH_ACCOUNT
    if (!account) return mergeEnv(this.o.env, session, platform)
    const base = { ...this.o.env }
    for (const k of TOKENS) deleteEnv(base, k, platform)
    // The session's own variables go on top again, so a project's extra variables stay.
    const env = mergeEnv(base, session, platform)
    const forGh = { ...env }
    for (const k of TOKENS) deleteEnv(forGh, k, platform)
    const token = await this.fetchToken(envValue(env, 'PITWALL_GH_BIN', platform) || 'gh', account, forGh).catch(() => null)
    if (token) return mergeEnv(env, { GH_TOKEN: token }, platform)
    // Fail closed: signed-out gh beats gh silently acting as whichever account is active.
    for (const k of TOKENS) deleteEnv(env, k, platform)
    const dir = join(envValue(env, 'PITWALL_SESSION_DIR', platform) || this.o.spec.sessionDir, 'gh-unauthenticated')
    mkdirSync(dir, { recursive: true })
    this.print(MESSAGES.noToken(account))
    return mergeEnv(env, { GH_CONFIG_DIR: dir }, platform)
  }

  private readSessionEnv(): Record<string, string> {
    const raw = JSON.parse(readFileSync(this.file('env.json'), 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('env.json is not an object')
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v
    return out
  }

  private claudeBin(env: Record<string, string>): string {
    return envValue(env, 'PITWALL_CLAUDE_BIN', this.o.platform) || 'claude'
  }

  private file(name: string): string {
    return join(this.o.spec.sessionDir, name)
  }

  // ---- programs ----------------------------------------------------------------------

  private run(file: string, args: string[], env: Record<string, string>): Promise<number> {
    if (this.o.platform === 'win32') {
      const c = windowsCommand(file, args, env, this.isFile)
      return this.runPty(file, c.file, c.commandLine, env)
    }
    return this.runPty(file, file, args, env)
  }

  /** The setup command, in sh (cmd.exe on Windows), as the script's `sh -c`. */
  private runShellCommand(command: string, env: Record<string, string>): Promise<number> {
    if (this.o.platform === 'win32') {
      const c = windowsShellCommand(command, env)
      return this.runPty(command, c.file, c.commandLine, env)
    }
    return this.runPty(command, '/bin/sh', ['-c', command], env)
  }

  private runPty(what: string, file: string, args: string[] | string, env: Record<string, string>): Promise<number> {
    if (this.stopping) return Promise.resolve(129)
    let p: PtyLike
    try {
      p = this.o.spawn(file, args, { cwd: this.o.cwd, env, cols: this.cols, rows: this.rows })
    } catch (e) {
      this.print(`pitwall: couldn't start ${what}: ${msg(e)}`)
      return Promise.resolve(127)
    }
    this.current = p
    return new Promise((resolve) => {
      p.onData((d) => this.emit(d))
      p.onExit(({ exitCode, signal }) => {
        if (this.current === p) this.current = null
        resolve(signal ? 128 + signal : exitCode)
      })
      const typed = this.pending
      this.pending = []
      this.pendingBytes = 0
      for (const d of typed) p.write(d)
    })
  }

  private waitForKey(): Promise<Key> {
    if (this.stopping) return Promise.resolve('stopped')
    this.pending = [] // typed before the prompt: not an answer to it
    this.pendingBytes = 0
    return new Promise((resolve) => { this.waiting = resolve })
  }

  private answer(k: Key): void {
    const w = this.waiting
    this.waiting = null
    w?.(k)
  }

  // ---- output and events ----------------------------------------------------------------

  /** A line of our own in the terminal (a terminal's own newline is CR LF). */
  private print(line: string): void {
    this.emit(`${line}\r\n`)
  }

  private emit(d: string): void {
    for (const cb of this.dataCbs) cb(d)
  }

  private finish(code: number): void {
    if (this.finished) return
    this.finished = true
    this.waiting = null
    for (const cb of this.exitCbs) cb(code)
  }

  private eventsFile(env: Record<string, string>): string | undefined {
    return envValue(env, 'PITWALL_EVENTS_FILE', this.o.platform)
  }

  private eventLines(env: Record<string, string>): string[] {
    const f = this.eventsFile(env)
    if (!f) return []
    try {
      return readFileSync(f, 'utf8').split('\n').slice(0, -1) // complete lines only
    } catch {
      return []
    }
  }

  private logEvent(env: Record<string, string>, ev: Record<string, string | number>): void {
    const f = this.eventsFile(env)
    if (!f) return
    const line = JSON.stringify({ c: envValue(env, 'PITWALL_SESSION_ID', this.o.platform) ?? '', t: this.now(), ...ev }) + '\n'
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        mkdirSync(dirname(f), { recursive: true })
        appendFileSync(f, line)
        return
      } catch {
        // Windows: a hook may hold the file for a moment.
      }
    }
  }
}

function isSessionStart(line: string): boolean {
  try {
    return (JSON.parse(line) as { e?: unknown }).e === 'SessionStart'
  } catch {
    return false
  }
}
