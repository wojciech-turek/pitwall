/**
 * The launcher, run by the host itself (Windows has no sh for resources/bin/pitwall-launch). It does what that script
 * does, in the same terminal and with the same words:
 * - every launch reads the session's variables afresh (env.json, written beside env.sh), so an edited project
 *   identity applies from the next relaunch;
 * - with a GitHub account, the token is fetched per launch with inherited token variables removed, and lives only in
 *   Claude's environment (never argv or disk). No token: fail closed with an empty GH_CONFIG_DIR;
 * - the setup command runs once (`setup-done`), in sh (cmd.exe on Windows);
 * - Claude starts with `--session-id` the first time (`started`), then `--resume`; a resume that fails before Claude
 *   reported SessionStart falls back to a new conversation (with the hooks off, one that has no transcript does);
 * - when Claude exits: "Press Enter to resume.", and Enter relaunches it. End of input (Ctrl+D) or Ctrl+C at that
 *   prompt ends the terminal, as they end the script's `read`.
 * Beyond the script: what it prints that matters (signed out of GitHub, setup failed, couldn't resume) is also logged
 * as a pitwall:warning event, which the app shows as a banner (a ConPTY repaint can wipe the printed line). And on
 * Windows the PowerShell hook and status line are tried before each start of Claude: if they don't run (an execution
 * policy, a scanner that makes them time out, a missing file), Claude gets settings without them, so they can never get
 * in its way, and a warning says so, and why when that's known.
 * The Shell tab (`kind: 'shell'`) gets the same identity, then its shell, once.
 * Everything that touches the outside world (the pty, gh, the file system for PATH lookups) is injected.
 */
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
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
/** One run of a script, tried as Claude would run it: its exit code, whether it ran out of time, what it said on stderr. */
export interface ProbeRun { rc: number; timedOut?: boolean; stderr?: string }
export type RunProbe = (file: string, args: string[], input: string, env: Record<string, string>) => Promise<ProbeRun>

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
  /** The host's log (why the PowerShell scripts were found blocked). */
  log?: (msg: string) => void
}

/** How long one try of a script may take (Claude's own hook timeout is longer; this only decides whether to keep it). */
const PROBE_SECONDS = 20

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
  scripts: (why?: string) => `Pitwall's status scripts didn't run (${why ?? 'see host.log'}) — status won't update for this session.`,
  statusLine: (why?: string) =>
    `Pitwall's status line script didn't run (${why ?? 'see host.log'}) — the usage meter won't update for this session.`
}

/** Why the scripts didn't run, in the banner's words, when that's known (anything else: host.log has what they said). */
export const SCRIPT_TROUBLE = {
  policy: 'a PowerShell execution policy blocks them',
  slow: `PowerShell took over ${PROBE_SECONDS} s, twice`,
  noPowerShell: "PowerShell couldn't be started",
  missing: "a script file is missing; reinstall Pitwall"
}

const PROBE_EVENT = 'PitwallProbe'

const execProbe: RunProbe = (file, args, input, env) => new Promise((resolve) => {
  try {
    const child = execFile(file, args, { env, timeout: PROBE_SECONDS * 1000, windowsHide: true, encoding: 'utf8' }, (err, _out, stderr) => {
      const said = String(stderr ?? '').slice(0, 4000)
      if (!err) return resolve({ rc: 0, stderr: said })
      const { code, killed } = err as { code?: unknown; killed?: boolean }
      if (code === 'ENOENT') return resolve({ rc: 127, stderr: said || err.message })
      // Killed with no exit code of its own: execFile's timeout (too much output has a code: ERR_CHILD_PROCESS_…).
      resolve({ rc: typeof code === 'number' && code !== 0 ? code : 1, timedOut: killed === true && code == null, stderr: said })
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  } catch (e) {
    resolve({ rc: 127, stderr: msg(e) })
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
    const { file: settings, hooks } = await this.settingsFile(env)
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
      // Did that conversation start? SessionStart says so; with the hooks off there's none, so its transcript does.
      const started = async (): Promise<boolean> =>
        hooks ? this.eventLines(env).slice(before).some(isSessionStart) : this.hasTranscript(env, id)
      if (rc !== 0 && !this.stopping && !(await started())) {
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
  private async settingsFile(env: Record<string, string>): Promise<{ file: string; hooks: boolean }> {
    const file = this.file('hooks.json')
    const ok: Tried = await this.tryScripts(env).catch((e: unknown) => {
      this.o.log?.(`PowerShell scripts couldn't be tried: ${msg(e)}`)
      return { hooks: false, statusLine: false }
    })
    if (ok.hooks && ok.statusLine) return { file, hooks: true }
    if (!ok.hooks) {
      this.print(`pitwall: ${WARNINGS.scripts(ok.why)}`)
      this.warn(env, 'scripts', WARNINGS.scripts(ok.why))
    } else {
      this.print(`pitwall: ${WARNINGS.statusLine(ok.why)}`)
      this.warn(env, 'statusline', WARNINGS.statusLine(ok.why))
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
    return { file: fallback, hooks: ok.hooks }
  }

  /**
   * Runs the PowerShell hook and status line once, as Claude would (exec form, the same flags), on a probe payload
   * into a scratch folder. Only for exec-form hooks (Windows): sh scripts elsewhere need no such check. A try that
   * times out is made once more (the first PowerShell after a restart, or under a busy scanner, can be slow).
   */
  private async tryScripts(env: Record<string, string>): Promise<Tried> {
    const settings = JSON.parse(readFileSync(this.file('hooks.json'), 'utf8')) as {
      hooks?: { SessionStart?: Array<{ hooks?: Array<{ command?: unknown; args?: unknown }> }> }; statusLine?: unknown
    }
    const hook = settings.hooks?.SessionStart?.[0]?.hooks?.[0]
    const args = hook?.args
    const at = Array.isArray(args) ? args.indexOf('-File') : -1
    if (typeof hook?.command !== 'string' || !Array.isArray(args) || at < 0 || at + 1 >= args.length) return { hooks: true, statusLine: true }
    const powershell = hook.command
    const probeEnv = { ...env }
    deleteEnv(probeEnv, 'PITWALL_USER_STATUSLINE', this.o.platform) // the user's own line isn't ours to try
    for (const k of TOKENS) deleteEnv(probeEnv, k, this.o.platform) // the scripts need none, and the probe's stderr is logged
    const runOnce = this.o.runProbe ?? execProbe
    const run = async (a: string[], input: string): Promise<ProbeRun> => {
      const r = await runOnce(powershell, a, input, probeEnv)
      return r.timedOut && !this.stopping ? runOnce(powershell, a, input, probeEnv) : r
    }
    // A new folder each time: a leftover one (a scanner holding it) never needs removing first.
    const dir = this.file(`probe-${process.pid}-${++this.probes}`)
    mkdirSync(dir, { recursive: true })
    const errors = join(dir, 'errors.txt') // where the scripts say what went wrong (only when asked, as here)
    probeEnv.PITWALL_SCRIPT_ERRORS = errors
    try {
      const events = join(dir, 'events.jsonl')
      const hookRun = await run([...args.slice(0, at + 2), events, 'probe'], JSON.stringify({ hook_event_name: PROBE_EVENT, session_id: 'probe' }))
      const hooks = hookRun.rc === 0 && readIfAny(events).includes(`"e":"${PROBE_EVENT}"`)
      let statusLine = true
      let lineRun: ProbeRun | null = null
      const script = join(dirname(args[at + 1]), 'pitwall-statusline.ps1')
      if (settings.statusLine && hookRun.timedOut) {
        statusLine = false // the same PowerShell, just as slow: not another 40 s before Claude starts
      } else if (settings.statusLine) {
        lineRun = await run([...args.slice(0, at + 1), script, dir], JSON.stringify({ session_id: 'probe' }))
        statusLine = lineRun.rc === 0 && existsSync(join(dir, 'statusline.json'))
      }
      if (hooks && statusLine) return { hooks, statusLine }
      const [failed, failedScript] = hooks && lineRun ? [lineRun, script] : [hookRun, String(args[at + 1])]
      const said = [readIfAny(errors).trim(), failed.stderr?.trim() ?? ''].filter(Boolean).join('\n').slice(0, 2000)
      const why = scriptTrouble(failed, said, !existsSync(failedScript))
      const result = (r: ProbeRun | null, ok: boolean) => (ok ? 'ok' : r ? (r.timedOut ? 'timed out twice' : `exit ${r.rc}`) : 'not tried')
      this.o.log?.(`PowerShell scripts blocked (hook ${result(hookRun, hooks)}, status line ${result(lineRun, statusLine)})${said ? `: ${said}` : ''}`)
      return { hooks, statusLine, why }
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

  /**
   * Whether Claude has a transcript of this conversation (`<config dir>/projects/<any folder>/<id>.jsonl`), looked up
   * read-only as the app's history does. Only asked when the hooks are off: then no SessionStart says it started.
   */
  private async hasTranscript(env: Record<string, string>, id: string): Promise<boolean> {
    const { platform } = this.o
    const home = envValue(env, platform === 'win32' ? 'USERPROFILE' : 'HOME', platform) || homedir()
    const root = join(envValue(env, 'CLAUDE_CONFIG_DIR', platform) || join(home, '.claude'), 'projects')
    const folders = await readdir(root, { withFileTypes: true }).catch(() => [])
    return folders.some((f) => f.isDirectory() && existsSync(join(root, f.name, `${id}.jsonl`)))
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

/** What trying the scripts found; `why` is the banner's reason, when it's known. */
interface Tried { hooks: boolean; statusLine: boolean; why?: string }

/** The reason for the banner, from how the script failed and what it (or PowerShell) said; undefined: see host.log. */
function scriptTrouble(r: ProbeRun, said: string, missing: boolean): string | undefined {
  if (missing) return SCRIPT_TROUBLE.missing
  if (r.timedOut) return SCRIPT_TROUBLE.slow
  if (r.rc === 127) return SCRIPT_TROUBLE.noPowerShell
  // PowerShell's words are translated, but not the help topic's name or the error id it prints with them.
  if (/about_Execution_Policies|\bUnauthorizedAccess\b|PSSecurityException/i.test(said)) return SCRIPT_TROUBLE.policy
  return undefined
}

function readIfAny(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}
