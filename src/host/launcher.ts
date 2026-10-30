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
 * Beyond the script: what it prints that matters (signed out of GitHub, setup failed, couldn't resume) is also logged
 * as a pitwall:warning event, which the app shows as a banner (a ConPTY repaint can wipe the printed line). And on
 * Windows the PowerShell hook and status line are tried before each start of Claude: if Windows won't run them
 * (an execution policy), Claude gets settings without them, so they can never get in its way, and a warning says so.
 * The Shell tab (`kind: 'shell'`) gets the same identity, then its shell, once.
 * Everything that touches the outside world (the pty, gh, the file system for PATH lookups) is injected.
 */
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
/** Runs a program with no shell, `input` on its stdin; its exit code (non-zero if it couldn't start). Never throws. */
export type RunProbe = (file: string, args: string[], input: string, env: Record<string, string>) => Promise<number>

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
  /** How the PowerShell scripts are tried (a test seam; default execFile). */
  runProbe?: RunProbe
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

/** The same, as banners in the app (pitwall:warning, one per kind), plus what only the host's launcher checks. */
export const WARNINGS = {
  gh: (account: string) => `Couldn't get a GitHub token for ${account}: gh commands run signed out. Check \`gh auth status\`.`,
  setup: (rc: number) => `The setup command failed (exit ${rc}); Claude started anyway.`,
  resume: () => "Couldn't resume the previous conversation, so a new one started.",
  scripts: () => "Windows blocked Pitwall's status scripts (PowerShell execution policy) — status won't update for this session.",
  statusLine: () => "Windows blocked Pitwall's status line script (PowerShell execution policy) — the usage meter won't update for this session."
}

const PROBE_EVENT = 'PitwallProbe'

const execProbe: RunProbe = (file, args, input, env) => new Promise((resolve) => {
  try {
    const child = execFile(file, args, { env, timeout: 20_000, windowsHide: true }, (err) => {
      if (!err) return resolve(0)
      const code = (err as { code?: unknown }).code
      resolve(typeof code === 'number' && code !== 0 ? code : 1)
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  } catch {
    resolve(127)
  }
})

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
  private currentStartedAt: number | null = null
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
  /** This run of Claude's warnings (logged again after each pitwall:launch, which clears the app's banners). */
  private warnings: Array<{ kind: string; msg: string }> = []
  private launched = false
  private probes = 0
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

  /** When that program was started (ms since 1970). */
  get startedAt(): number | null {
    return this.current ? this.currentStartedAt : null
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
    this.warnings = []
    this.launched = false
    const env = await this.launchEnv()
    const setup = envValue(env, 'PITWALL_SETUP_COMMAND', this.o.platform)
    const done = this.file('setup-done')
    if (setup && !existsSync(done) && !this.stopping) {
      this.print(MESSAGES.setup(setup))
      const rc = await this.runShellCommand(setup, env)
      if (this.stopping) return rc // killed during setup: it runs again next time, as with the script
      if (rc !== 0) {
        this.print(MESSAGES.setupFailed(rc))
        this.warn(env, 'setup', WARNINGS.setup(rc))
      }
      writeFileSync(done, '')
    }
    if (this.stopping) return 129
    const settings = await this.settingsFile(env)
    if (this.stopping) return 129
    const id = readFileSync(this.file('claude-id'), 'utf8').trim()
    let rc: number
    if (!existsSync(this.file('started'))) {
      writeFileSync(this.file('started'), '')
      rc = await this.launchNew(id, settings, env)
    } else {
      const before = this.eventLines(env).length
      this.logLaunch(env, 'resume')
      rc = await this.run(this.claudeBin(env), ['--resume', id, '--settings', settings], env)
      if (rc !== 0 && !this.stopping && !this.eventLines(env).slice(before).some(isSessionStart)) {
        this.logEvent(env, { e: 'pitwall:exited', code: rc })
        this.print(MESSAGES.resumeFailed())
        this.warn(env, 'resume', WARNINGS.resume())
        rc = await this.launchNew(id, settings, env)
      }
    }
    // Killed: the script dies with its terminal and logs nothing more.
    if (!this.stopping) this.logEvent(env, { e: 'pitwall:exited', code: rc })
    return rc
  }

  private launchNew(id: string, settings: string, env: Record<string, string>): Promise<number> {
    this.logLaunch(env, 'new')
    const title = envValue(env, 'PITWALL_TITLE', this.o.platform) ?? ''
    return this.run(this.claudeBin(env), ['--session-id', id, '--settings', settings, '--name', title], env)
  }

  /** pitwall:launch, then this run's warnings again (the app clears its banners at each launch). */
  private logLaunch(env: Record<string, string>, mode: 'new' | 'resume'): void {
    this.logEvent(env, { e: 'pitwall:launch', mode })
    this.launched = true
    for (const w of this.warnings) this.logEvent(env, { e: 'pitwall:warning', kind: w.kind, msg: w.msg })
  }

  /** A warning for this run of Claude: shown as a banner from its launch on (the Shell tab logs no events). */
  private warn(env: Record<string, string>, kind: string, msg: string): void {
    if (this.o.spec.kind !== 'claude') return
    this.warnings = [...this.warnings.filter((w) => w.kind !== kind), { kind, msg }]
    if (this.launched) this.logEvent(env, { e: 'pitwall:warning', kind, msg })
  }

  /**
   * The settings Claude starts with: hooks.json, or (when Windows won't run the PowerShell scripts) a copy without
   * them, so an execution policy can never get in the way of Claude's tool calls. Tried at every start, so a policy
   * that changed between runs is noticed. Anything unexpected while trying counts as blocked (fail closed).
   */
  private async settingsFile(env: Record<string, string>): Promise<string> {
    const file = this.file('hooks.json')
    const ok = await this.tryScripts(env).catch(() => ({ hooks: false, statusLine: false }))
    if (ok.hooks && ok.statusLine) return file
    if (!ok.hooks) {
      this.print(`pitwall: ${WARNINGS.scripts()}`)
      this.warn(env, 'scripts', WARNINGS.scripts())
    } else {
      this.print(`pitwall: ${WARNINGS.statusLine()}`)
      this.warn(env, 'statusline', WARNINGS.statusLine())
    }
    let settings: Record<string, unknown> = {}
    try {
      settings = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    } catch {
      // unreadable: start with no settings of ours rather than with scripts that may not run
    }
    if (!ok.hooks) delete settings.hooks
    if (!ok.statusLine) delete settings.statusLine
    const fallback = this.file('hooks-without-scripts.json')
    writeFileSync(fallback, JSON.stringify(settings, null, 2) + '\n')
    return fallback
  }

  /**
   * Runs the PowerShell hook and status line once, as Claude would (exec form, the same flags), on a probe payload
   * into a scratch folder. Only for exec-form hooks (Windows): sh scripts elsewhere need no such check.
   */
  private async tryScripts(env: Record<string, string>): Promise<{ hooks: boolean; statusLine: boolean }> {
    const settings = JSON.parse(readFileSync(this.file('hooks.json'), 'utf8')) as {
      hooks?: { SessionStart?: Array<{ hooks?: Array<{ command?: unknown; args?: unknown }> }> }; statusLine?: unknown
    }
    const hook = settings.hooks?.SessionStart?.[0]?.hooks?.[0]
    const args = hook?.args
    const at = Array.isArray(args) ? args.indexOf('-File') : -1
    if (typeof hook?.command !== 'string' || !Array.isArray(args) || at < 0 || at + 1 >= args.length) return { hooks: true, statusLine: true }
    const run = this.o.runProbe ?? execProbe
    const probeEnv = { ...env }
    deleteEnv(probeEnv, 'PITWALL_USER_STATUSLINE', this.o.platform) // the user's own line isn't ours to try
    // A new folder each time: a leftover one (a scanner holding it) never needs removing first.
    const dir = this.file(`probe-${process.pid}-${++this.probes}`)
    mkdirSync(dir, { recursive: true })
    try {
      const events = join(dir, 'events.jsonl')
      const hookRc = await run(hook.command, [...args.slice(0, at + 2), events, 'probe'],
        JSON.stringify({ hook_event_name: PROBE_EVENT, session_id: 'probe' }), probeEnv)
      const hooks = hookRc === 0 && readIfAny(events).includes(`"e":"${PROBE_EVENT}"`)
      let statusLine = true
      if (settings.statusLine) {
        const script = join(dirname(args[at + 1]), 'pitwall-statusline.ps1')
        const rc = await run(hook.command, [...args.slice(0, at + 1), script, dir], JSON.stringify({ session_id: 'probe' }), probeEnv)
        statusLine = rc === 0 && existsSync(join(dir, 'statusline.json'))
      }
      return { hooks, statusLine }
    } finally {
      // Best effort: tidying up never changes what was found.
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* left for later */ }
    }
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
    const out = mergeEnv(env, { GH_CONFIG_DIR: dir }, platform)
    this.warn(out, 'gh', WARNINGS.gh(account))
    return out
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
    const startedAt = Date.now()
    try {
      p = this.o.spawn(file, args, { cwd: this.o.cwd, env, cols: this.cols, rows: this.rows })
    } catch (e) {
      this.print(`pitwall: couldn't start ${what}: ${msg(e)}`)
      return Promise.resolve(127)
    }
    this.current = p
    this.currentStartedAt = startedAt
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

function readIfAny(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}
