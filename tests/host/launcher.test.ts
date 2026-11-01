import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { Launcher, MESSAGES, SCRIPT_TROUBLE, WARNINGS, type FetchToken, type LauncherOptions, type ProbeRun, type PtyLike, type RunProbe } from '../../src/host/launcher'
import { windowsCommand } from '../../src/host/win-command'

class FakePty implements PtyLike {
  static next = 1000
  readonly pid = FakePty.next++
  written: string[] = []
  size: [number, number]
  killed: string[] = []
  private dataCb: (d: string) => void = () => {}
  private exitCb: (e: { exitCode: number; signal?: number }) => void = () => {}
  constructor(readonly file: string, readonly args: string[] | string, readonly env: Record<string, string>, cols: number, rows: number) {
    this.size = [cols, rows]
  }
  onData(cb: (d: string) => void): void { this.dataCb = cb }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void { this.exitCb = cb }
  write(d: string | Buffer): void { this.written.push(d.toString()) }
  resize(c: number, r: number): void { this.size = [c, r] }
  out(d: string): void { this.dataCb(d) }
  exit(exitCode: number, signal?: number): void { this.exitCb({ exitCode, signal }) }
}

const tick = () => new Promise((r) => setTimeout(r, 5))
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return
    await tick()
  }
  throw new Error(`timed out: ${what}`)
}

const ID = 'uuid-1'
const TITLE = "Fix 'tax' $ rounding 🧾"
let dir: string
let sd: string
let events: string
let spawned: FakePty[]
let screen: string
let exits: number[]
let tokens: Array<{ account: string; env: Record<string, string> }>
let fetchToken: FetchToken

function writeEnv(vars: Record<string, string>): void {
  writeFileSync(join(sd, 'env.json'), JSON.stringify(vars))
}

const baseVars = (): Record<string, string> => ({
  GIT_AUTHOR_EMAIL: 'm@x.io', PITWALL_GH_ACCOUNT: 'dev-work', PITWALL_GH_BIN: '/bin/gh', PITWALL_SESSION_ID: 's_1',
  PITWALL_TITLE: TITLE, PITWALL_SESSION_DIR: sd, PITWALL_EVENTS_FILE: events, PITWALL_CLAUDE_BIN: '/bin/claude'
})

function launcher(o: Partial<LauncherOptions> = {}): Launcher {
  const l = new Launcher({
    spec: { kind: 'claude', sessionDir: sd }, cwd: dir, argv: [], cols: 80, rows: 24, platform: 'darwin',
    env: { PATH: '/usr/bin', HOME: dir, GH_TOKEN: 'inherited', GITHUB_TOKEN: 'inherited2' },
    spawn: (file, args, so) => {
      const p = new FakePty(file, args, so.env, so.cols, so.rows)
      spawned.push(p)
      return p
    },
    kill: (p, sig) => { (p as FakePty).killed.push(sig) },
    fetchToken: (bin, account, env) => fetchToken(bin, account, env),
    now: () => 42,
    ...o
  })
  l.onData((d) => { screen += d })
  l.onExit((c) => { exits.push(c) })
  return l
}

const lastPty = () => spawned.at(-1)!
const eventList = () => (existsSync(events) ? readFileSync(events, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pitwall-launcher-'))
  sd = join(dir, 'sessions', 's_1')
  mkdirSync(sd, { recursive: true })
  events = join(sd, 'events.jsonl')
  writeEnv(baseVars())
  writeFileSync(join(sd, 'claude-id'), `${ID}\n`)
  // As writeSessionFiles leaves it on macOS (sh hooks: nothing to try first).
  writeFileSync(join(sd, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: "'/b/pitwall-hook' 'e' 's_1'", timeout: 10 }] }] } }))
  spawned = []
  screen = ''
  exits = []
  tokens = []
  fetchToken = async (_bin, account, env) => {
    tokens.push({ account, env })
    return account === 'dev-work' || account === 'dev-personal' ? `token-for-${account}` : null
  }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the host launcher', () => {
  test('first launch: session id, settings and name; the token only in the environment; inherited tokens never used', async () => {
    const l = launcher()
    l.start()
    await until(() => spawned.length === 1, 'claude started')
    const p = lastPty()
    expect(p.file).toBe('/bin/claude')
    expect(p.args).toEqual(['--session-id', ID, '--settings', join(sd, 'hooks.json'), '--name', TITLE])
    expect(p.env).toMatchObject({ GH_TOKEN: 'token-for-dev-work', GIT_AUTHOR_EMAIL: 'm@x.io', PATH: '/usr/bin' })
    expect(p.env.GITHUB_TOKEN).toBeUndefined() // inherited: dropped, never stands in
    expect(JSON.stringify(p.args)).not.toContain('token-for')
    // gh was asked without any token variable in its environment.
    expect(tokens).toHaveLength(1)
    expect(tokens[0].account).toBe('dev-work')
    for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) expect(tokens[0].env[k]).toBeUndefined()
    expect(existsSync(join(sd, 'started'))).toBe(true)
    expect(eventList()).toEqual([{ c: 's_1', t: 42, e: 'pitwall:launch', mode: 'new' }])
    expect(l.pid).toBe(p.pid)
    // Output, input and size go to and from Claude.
    p.out('STUB READY\r\n')
    expect(screen).toBe('STUB READY\r\n')
    l.write('hi\r')
    l.resize(120, 40)
    expect(p.written).toEqual(['hi\r'])
    expect(p.size).toEqual([120, 40])
  })

  test('Claude exits: the prompt, then Enter resumes with the same id and settings (no name), the size kept', async () => {
    const l = launcher()
    l.start()
    await until(() => spawned.length === 1, 'claude started')
    l.resize(100, 30)
    lastPty().exit(0)
    await until(() => screen.includes('Press Enter'), 'prompt')
    expect(screen).toBe(`${MESSAGES.exited(0)}\r\n`)
    expect(l.pid).toBeNull()
    l.write('\x1b[I') // a terminal report is not an answer
    await tick()
    expect(spawned).toHaveLength(1)
    l.write('\r')
    await until(() => spawned.length === 2, 'resumed')
    expect(lastPty().args).toEqual(['--resume', ID, '--settings', join(sd, 'hooks.json')])
    expect(lastPty().size).toEqual([100, 30])
    expect(eventList().map((e) => [e.e, e.mode ?? e.code])).toEqual([
      ['pitwall:launch', 'new'], ['pitwall:exited', 0], ['pitwall:launch', 'resume']
    ])
    expect(tokens).toHaveLength(2) // fetched again for the new launch
    expect(exits).toEqual([])
  })

  test('a failed resume with no SessionStart falls back to a new conversation; one that started does not', async () => {
    writeFileSync(join(sd, 'started'), '')
    const l = launcher()
    l.start()
    await until(() => spawned.length === 1, 'resume')
    lastPty().exit(1)
    await until(() => spawned.length === 2, 'fresh launch')
    expect(screen).toContain(MESSAGES.resumeFailed())
    expect(lastPty().args).toEqual(['--session-id', ID, '--settings', join(sd, 'hooks.json'), '--name', TITLE])
    expect(eventList().filter((e) => e.e !== 'pitwall:warning').map((e) => [e.e, e.mode ?? e.code])).toEqual([
      ['pitwall:launch', 'resume'], ['pitwall:exited', 1], ['pitwall:launch', 'new']
    ])
    lastPty().exit(0)
    await until(() => screen.includes(MESSAGES.exited(0)), 'prompt')
    l.write('\r')
    await until(() => spawned.length === 3, 'resume again')
    // This time Claude reported in before failing: its error stands, no new conversation.
    appendFileSync(events, JSON.stringify({ c: 's_1', t: 1, e: 'SessionStart', sid: ID }) + '\n')
    lastPty().exit(2)
    await until(() => screen.includes(MESSAGES.exited(2)), 'prompt after a real failure')
    expect(spawned).toHaveLength(3)
  })

  test('every launch reads env.json again: an edited identity applies after exit + Enter', async () => {
    const l = launcher()
    l.start()
    await until(() => spawned.length === 1, 'claude')
    writeEnv({ ...baseVars(), GIT_AUTHOR_EMAIL: 'new@x.io', PITWALL_GH_ACCOUNT: 'dev-personal' })
    lastPty().exit(0)
    await until(() => screen.includes('Press Enter'), 'prompt')
    l.write('\r')
    await until(() => spawned.length === 2, 'relaunch')
    expect(lastPty().env).toMatchObject({ GIT_AUTHOR_EMAIL: 'new@x.io', GH_TOKEN: 'token-for-dev-personal' })
  })

  test('no token: fails closed (no token of any kind, an empty gh config dir) and says so', async () => {
    writeEnv({ ...baseVars(), PITWALL_GH_ACCOUNT: 'nobody' })
    const l = launcher()
    l.start()
    await until(() => spawned.length === 1, 'claude')
    expect(screen).toContain(MESSAGES.noToken('nobody'))
    const env = lastPty().env
    for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) expect(env[k]).toBeUndefined()
    expect(env.GH_CONFIG_DIR).toBe(join(sd, 'gh-unauthenticated'))
    expect(statSync(env.GH_CONFIG_DIR).isDirectory()).toBe(true)
  })

  test("a project's own token variables stay when the account's token is found; no account: nothing fetched", async () => {
    writeEnv({ ...baseVars(), GITHUB_TOKEN: 'project-own' })
    const l = launcher()
    l.start()
    await until(() => spawned.length === 1, 'claude')
    expect(lastPty().env).toMatchObject({ GH_TOKEN: 'token-for-dev-work', GITHUB_TOKEN: 'project-own' })
    expect(tokens[0].env.GITHUB_TOKEN).toBeUndefined()

    spawned = []
    tokens = []
    writeEnv({ ...baseVars(), PITWALL_GH_ACCOUNT: '' })
    rmSync(join(sd, 'started'))
    launcher().start()
    await until(() => spawned.length === 1, 'claude without an account')
    expect(tokens).toEqual([])
    expect(lastPty().env.GH_TOKEN).toBe('inherited') // no account: the user's environment as it is
  })

  test('the setup command runs once, before Claude, in sh; a failure is reported and Claude starts anyway', async () => {
    writeEnv({ ...baseVars(), PITWALL_SETUP_COMMAND: 'pnpm install' })
    const l = launcher()
    l.start()
    await until(() => spawned.length === 1, 'setup')
    expect([lastPty().file, lastPty().args]).toEqual(['/bin/sh', ['-c', 'pnpm install']])
    expect(lastPty().env.GH_TOKEN).toBe('token-for-dev-work')
    expect(screen).toBe(`${MESSAGES.setup('pnpm install')}\r\n`)
    lastPty().exit(7)
    await until(() => spawned.length === 2, 'claude after setup')
    expect(screen).toContain(MESSAGES.setupFailed(7))
    expect(lastPty().file).toBe('/bin/claude')
    expect(existsSync(join(sd, 'setup-done'))).toBe(true)
    lastPty().exit(0)
    await until(() => screen.includes('Press Enter'), 'prompt')
    l.write('\r')
    await until(() => spawned.length === 3, 'relaunch')
    expect(lastPty().file).toBe('/bin/claude') // no second setup
  })

  test('at the prompt, end of input (Ctrl+D) or Ctrl+C ends the terminal, as they end the script\'s read', async () => {
    for (const [key, code] of [['\x04', 0], ['\x03', 130]] as const) {
      spawned = []
      exits = []
      screen = ''
      const l = launcher()
      l.start()
      await until(() => spawned.length === 1, 'claude')
      lastPty().exit(0)
      await until(() => exits.length === 0 && screen.endsWith('resume.\r\n'), 'prompt')
      l.write(key)
      await until(() => exits.length === 1, 'ended')
      expect(exits).toEqual([code])
      expect(spawned).toHaveLength(1)
    }
  })

  test('killed while Claude runs: Claude is hung up, nothing relaunches and nothing more is logged', async () => {
    const l = launcher()
    l.start()
    await until(() => spawned.length === 1, 'claude')
    l.signal('SIGHUP')
    expect(lastPty().killed).toEqual(['SIGHUP'])
    l.signal('SIGKILL')
    expect(lastPty().killed).toEqual(['SIGHUP', 'SIGKILL'])
    lastPty().exit(0, 1)
    await until(() => exits.length === 1, 'ended')
    expect(exits).toEqual([129])
    expect(eventList().map((e) => e.e)).toEqual(['pitwall:launch'])
    expect(screen).not.toContain('Press Enter')
  })

  test('killed at the prompt: ends at once', async () => {
    const l = launcher()
    l.start()
    await until(() => spawned.length === 1, 'claude')
    lastPty().exit(0)
    await until(() => screen.includes('Press Enter'), 'prompt')
    l.signal('SIGHUP')
    await until(() => exits.length === 1, 'ended')
    expect(spawned).toHaveLength(1)
  })

  test('killed while the token is fetched: nothing starts', async () => {
    let release!: (t: string | null) => void
    fetchToken = () => new Promise((r) => { release = r })
    const l = launcher()
    l.start()
    await until(() => !!release, 'fetching')
    l.signal('SIGHUP')
    release('token')
    await until(() => exits.length === 1, 'ended')
    expect(spawned).toHaveLength(0)
    expect(existsSync(join(sd, 'started'))).toBe(false)
  })

  test('keys typed while nothing runs reach the next program; keys typed before the prompt don\'t answer it', async () => {
    let release!: (t: string | null) => void
    fetchToken = () => new Promise((r) => { release = r })
    const l = launcher()
    l.start()
    await until(() => !!release, 'fetching')
    l.write('early')
    release('t')
    await until(() => spawned.length === 1, 'claude')
    expect(lastPty().written).toEqual(['early'])
    lastPty().exit(0)
    await until(() => screen.includes('Press Enter'), 'prompt')
    await tick()
    expect(spawned).toHaveLength(1)
  })

  test("a program that can't start is reported, and the prompt follows", async () => {
    const l = launcher({ spawn: () => { throw new Error('File not found: claude') } })
    l.start()
    await until(() => screen.includes('Press Enter'), 'prompt')
    expect(screen).toBe(`pitwall: couldn't start /bin/claude: File not found: claude\r\n${MESSAGES.exited(127)}\r\n`)
  })

  test('a broken session folder is reported and ends the terminal', async () => {
    rmSync(join(sd, 'env.json'))
    launcher().start()
    await until(() => exits.length === 1, 'ended')
    expect(exits).toEqual([1])
    expect(screen).toMatch(/^pitwall: .*env\.json/)
  })

  test('the Shell tab: the same identity, then the shell once; its exit ends the terminal', async () => {
    writeEnv({ ...baseVars(), PITWALL_GH_ACCOUNT: 'nobody' })
    const l = launcher({ spec: { kind: 'shell', sessionDir: sd }, argv: ['/bin/zsh', '-l'] })
    l.start()
    await until(() => spawned.length === 1, 'shell')
    expect([lastPty().file, lastPty().args]).toEqual(['/bin/zsh', ['-l']])
    expect(lastPty().env).toMatchObject({ GH_CONFIG_DIR: join(sd, 'gh-unauthenticated'), GIT_AUTHOR_EMAIL: 'm@x.io' })
    expect(lastPty().env.GH_TOKEN).toBeUndefined()
    expect(screen).toContain(MESSAGES.noToken('nobody'))
    lastPty().exit(3)
    await until(() => exits.length === 1, 'ended')
    expect(exits).toEqual([3])
    expect(existsSync(join(sd, 'started'))).toBe(false)
    expect(eventList()).toEqual([])
  })

  test('Windows: Claude found on PATH (a .cmd through cmd.exe), setup in cmd.exe, variables matched whatever their case', async () => {
    const vars = { ...baseVars(), PITWALL_CLAUDE_BIN: 'claude', PITWALL_SETUP_COMMAND: 'pnpm install', PATH: 'C:\\stub' }
    writeEnv(vars)
    const l = launcher({
      platform: 'win32',
      env: { Path: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe', Gh_Token: 'inherited' },
      isFile: (p) => p.toLowerCase() === 'c:\\stub\\claude.cmd'
    })
    l.start()
    await until(() => spawned.length === 1, 'setup')
    expect([lastPty().file, lastPty().args]).toEqual(['C:\\Windows\\system32\\cmd.exe', '/d /s /c "pnpm install"'])
    expect(lastPty().env.Gh_Token).toBeUndefined()
    // The project's PATH replaced the host's Path (one variable on Windows), and Claude is looked up on it.
    expect(lastPty().env.Path).toBeUndefined()
    expect(lastPty().env.PATH).toBe('C:\\stub')
    lastPty().exit(0)
    await until(() => spawned.length === 2, 'claude')
    const p = lastPty()
    expect(p.file).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(typeof p.args).toBe('string')
    expect(p.args).toMatch(/^\/d \/s \/c "C:\\stub\\claude\.cmd \^\^\^"--session-id\^\^\^" /)
    expect(p.env.GH_TOKEN).toBe('token-for-dev-work')
  })
})

describe('a conversation continued from outside Pitwall (continue-note.txt)', () => {
  const note = () => join(sd, 'continue-note.txt')
  /** Claude rebuilds its system prompt for this folder, with the note, rather than reuse the recorded one. */
  const flags = () => ['--system-prompt-snapshot', 'off', '--append-system-prompt-file', note()]

  test('every launch gets --system-prompt-snapshot off and the note: the first, a resume and the fallback after a failed one', async () => {
    writeFileSync(note(), 'Work only here.\n')
    const settings = join(sd, 'hooks.json')
    const l = launcher()
    l.start()
    await until(() => spawned.length === 1, 'claude started')
    expect(lastPty().args).toEqual(['--session-id', ID, '--settings', settings, '--name', TITLE, ...flags()])
    lastPty().exit(0)
    await until(() => screen.includes('Press Enter'), 'prompt')
    l.write('\r')
    await until(() => spawned.length === 2, 'resumed')
    expect(lastPty().args).toEqual(['--resume', ID, '--settings', settings, ...flags()])
    lastPty().exit(1) // before any SessionStart: a new conversation over the same id
    await until(() => spawned.length === 3, 'fresh launch')
    expect(screen).toContain(MESSAGES.resumeFailed())
    expect(lastPty().args).toEqual(['--session-id', ID, '--settings', settings, '--name', TITLE, ...flags()])
  })

  test('a session that already started resumes with them too', async () => {
    writeFileSync(note(), 'Work only here.\n')
    writeFileSync(join(sd, 'started'), '')
    launcher().start()
    await until(() => spawned.length === 1, 'resume')
    expect(lastPty().args).toEqual(['--resume', ID, '--settings', join(sd, 'hooks.json'), ...flags()])
  })

  test("Windows: the flags and the note's path reach Claude through cmd.exe as arguments of their own", async () => {
    writeFileSync(note(), 'Work only here.\n')
    writeEnv({ ...baseVars(), PITWALL_CLAUDE_BIN: 'claude', PATH: 'C:\\stub' })
    const isFile = (p: string) => p.toLowerCase() === 'c:\\stub\\claude.cmd'
    const env = { Path: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe' }
    launcher({ platform: 'win32', env, isFile }).start()
    await until(() => spawned.length === 1, 'claude')
    const args = ['--session-id', ID, '--settings', join(sd, 'hooks.json'), '--name', TITLE, ...flags()]
    expect(lastPty().args).toBe(windowsCommand('claude', args, { PATH: 'C:\\stub', ComSpec: env.ComSpec }, isFile).commandLine)
  })
})

describe('warnings as banners (pitwall:warning, logged after each launch)', () => {
  const kinds = () => eventList().map((e) => (e.e === 'pitwall:warning' ? `warning:${e.kind}` : e.e === 'pitwall:launch' ? `launch:${e.mode}` : e.e))

  test('signed out and a failed setup: printed, and logged right after the launch', async () => {
    writeEnv({ ...baseVars(), PITWALL_GH_ACCOUNT: 'nobody', PITWALL_SETUP_COMMAND: 'false' })
    launcher().start()
    await until(() => spawned.length === 1, 'setup')
    lastPty().exit(1)
    await until(() => spawned.length === 2, 'claude')
    expect(kinds()).toEqual(['launch:new', 'warning:gh', 'warning:setup'])
    expect(eventList().filter((e) => e.e === 'pitwall:warning').map((e) => e.msg)).toEqual([WARNINGS.gh('nobody'), WARNINGS.setup(1)])
  })

  test("a resume that falls back says so after the new conversation's launch too", async () => {
    writeFileSync(join(sd, 'started'), '')
    launcher().start()
    await until(() => spawned.length === 1, 'resume')
    lastPty().exit(1)
    await until(() => spawned.length === 2, 'fresh launch')
    expect(kinds()).toEqual(['launch:resume', 'pitwall:exited', 'warning:resume', 'launch:new', 'warning:resume'])
  })

  test('the Shell tab logs nothing', async () => {
    writeEnv({ ...baseVars(), PITWALL_GH_ACCOUNT: 'nobody' })
    launcher({ spec: { kind: 'shell', sessionDir: sd }, argv: ['/bin/sh'] }).start()
    await until(() => spawned.length === 1, 'shell')
    expect(eventList()).toEqual([])
  })
})

describe('the PowerShell scripts are tried before each start of Claude (exec-form hooks: Windows)', () => {
  const PS = 'C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe'
  const FLAGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']
  let probes: Array<{ file: string; args: string[]; input: string; env: Record<string, string> }>
  let bin: string
  const ran = (rc: number): ProbeRun => ({ rc })

  function writeHooks(o: { statusLine?: boolean; hookScript?: string } = {}): void {
    const hook = { type: 'command', command: PS, args: [...FLAGS, o.hookScript ?? join(bin, 'pitwall-hook.ps1'), events, 's_1'], timeout: 10 }
    writeFileSync(join(sd, 'hooks.json'), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [hook] }], Stop: [{ hooks: [hook] }] },
      ...(o.statusLine === false ? {} : { statusLine: { type: 'command', command: 'powershell -File x', padding: 0 } })
    }))
  }
  /** A fake PowerShell: the hook and status line work, unless blocked. */
  const probe = (blocked: { hook?: boolean | 'silent'; statusLine?: boolean } = {}): RunProbe => async (file, args, input, env) => {
    probes.push({ file, args, input, env })
    const script = args[FLAGS.length]
    if (script.endsWith('pitwall-hook.ps1')) {
      if (blocked.hook === true) return ran(1)
      if (blocked.hook !== 'silent') appendFileSync(args[FLAGS.length + 1], `{"c":"probe","t":1,"e":"${JSON.parse(input).hook_event_name}"}\n`)
      return ran(0)
    }
    if (blocked.statusLine) return ran(1)
    writeFileSync(join(args[FLAGS.length + 1], 'statusline.json'), input)
    return ran(0)
  }
  const settingsArg = () => { const a = lastPty().args as string[]; return a[a.indexOf('--settings') + 1] }

  beforeEach(() => {
    probes = []
    bin = join(dir, 'bin')
    mkdirSync(bin)
    for (const f of ['pitwall-hook.ps1', 'pitwall-statusline.ps1']) writeFileSync(join(bin, f), '')
  })

  test('both run: Claude gets hooks.json; each script was tried with the same flags, outside the real files', async () => {
    writeHooks()
    writeEnv({ ...baseVars(), PITWALL_USER_STATUSLINE: 'my-line' })
    launcher({ runProbe: probe() }).start()
    await until(() => spawned.length === 1, 'claude')
    expect(settingsArg()).toBe(join(sd, 'hooks.json'))
    expect(probes.map((p) => [p.file, p.args.slice(0, FLAGS.length + 1)])).toEqual([
      [PS, [...FLAGS, join(bin, 'pitwall-hook.ps1')]], [PS, [...FLAGS, join(bin, 'pitwall-statusline.ps1')]]
    ])
    const scratch = dirname(probes[0].args[FLAGS.length + 1])
    expect(dirname(scratch)).toBe(sd)
    expect(probes[0].args.slice(FLAGS.length + 1)).toEqual([join(scratch, 'events.jsonl'), 'probe'])
    expect(probes[1].args[FLAGS.length + 1]).toBe(scratch)
    expect(probes[1].env.PITWALL_USER_STATUSLINE).toBeUndefined() // the user's line isn't run by the check
    expect(existsSync(scratch)).toBe(false)
    expect(existsSync(events)).toBe(true)
    expect(readFileSync(events, 'utf8')).not.toContain('PitwallProbe') // never in the session's own log
    expect(eventList().some((e) => e.e === 'pitwall:warning')).toBe(false)
  })

  test("blocked: Claude starts without the hooks and status line; it's printed and shown; checked again at each launch", async () => {
    writeHooks()
    const l = launcher({ runProbe: probe({ hook: true, statusLine: true }) })
    l.start()
    await until(() => spawned.length === 1, 'claude')
    expect(settingsArg()).toBe(join(sd, 'hooks-without-scripts.json'))
    expect(JSON.parse(readFileSync(join(sd, 'hooks-without-scripts.json'), 'utf8'))).toEqual({})
    expect(screen).toContain(`pitwall: ${WARNINGS.scripts()}`)
    expect(eventList().filter((e) => e.e === 'pitwall:warning')).toEqual([{ c: 's_1', t: 42, e: 'pitwall:warning', kind: 'scripts', msg: WARNINGS.scripts() }])
    lastPty().exit(0)
    await until(() => screen.includes('Press Enter'), 'prompt')
    l.write('\r')
    await until(() => spawned.length === 2, 'relaunch')
    expect(settingsArg()).toBe(join(sd, 'hooks-without-scripts.json'))
    expect(probes).toHaveLength(4) // hook + status line, at each launch (a policy may change between runs)
    expect(eventList().filter((e) => e.e === 'pitwall:warning')).toHaveLength(2) // again after the relaunch
  })

  test('a policy lifted between runs is noticed at the next launch', async () => {
    writeHooks()
    let blocked = true
    const l = launcher({ runProbe: (...a) => probe(blocked ? { hook: true, statusLine: true } : {})(...a) })
    l.start()
    await until(() => spawned.length === 1, 'claude')
    expect(settingsArg()).toBe(join(sd, 'hooks-without-scripts.json'))
    blocked = false
    lastPty().exit(0)
    await until(() => screen.includes('Press Enter'), 'prompt')
    l.write('\r')
    await until(() => spawned.length === 2, 'relaunch')
    expect(settingsArg()).toBe(join(sd, 'hooks.json'))
  })

  test('anything unexpected while trying counts as blocked (fail closed)', async () => {
    writeHooks()
    launcher({ runProbe: async () => { throw new Error('EPERM: spawn') } }).start()
    await until(() => spawned.length === 1, 'claude')
    expect(settingsArg()).toBe(join(sd, 'hooks-without-scripts.json'))
    expect(JSON.parse(readFileSync(settingsArg(), 'utf8'))).toEqual({})
    expect(eventList().filter((e) => e.e === 'pitwall:warning').map((e) => e.kind)).toEqual(['scripts'])
  })

  test("a scratch folder that can't be removed (a scanner holding it) changes nothing either way", async () => {
    for (const blocked of [true, false]) {
      spawned = []
      probes = []
      rmSync(join(sd, 'started'), { force: true })
      writeHooks()
      const run = probe(blocked ? { hook: true, statusLine: true } : {})
      // Leave something in the scratch folder and take away the right to delete it, as a scanner's lock would.
      launcher({ runProbe: async (file, args, input, env) => {
        const r = await run(file, args, input, env)
        if (args[FLAGS.length].endsWith('pitwall-statusline.ps1')) {
          writeFileSync(join(args[FLAGS.length + 1], 'locked'), '')
          chmodSync(args[FLAGS.length + 1], 0o500)
        }
        return r
      } }).start()
      await until(() => spawned.length === 1, 'claude')
      expect(settingsArg()).toBe(join(sd, blocked ? 'hooks-without-scripts.json' : 'hooks.json'))
      for (const d of readdirSync(sd).filter((n) => n.startsWith('probe-'))) {
        chmodSync(join(sd, d), 0o700)
        rmSync(join(sd, d), { recursive: true, force: true })
      }
    }
  })

  test("a slow script check is noted in the host's log (it held up Claude's start); a quick one isn't", async () => {
    writeHooks()
    for (const [step, expected] of [[6000, ['PowerShell scripts checked in 6.0 s before Claude started (slow)']], [1000, []]] as const) {
      const logged: string[] = []
      let t = 0
      launcher({ log: (m) => { logged.push(m) }, now: () => (t += step), runProbe: probe() }).start()
      await until(() => spawned.length > 0 && spawned.at(-1)?.file !== undefined, 'claude')
      expect(logged).toEqual(expected)
      spawned.length = 0
    }
  })

  test("why the scripts failed goes to the host's log (the scripts write it only when the check asks)", async () => {
    writeHooks()
    const logged: string[] = []
    launcher({
      log: (m) => { logged.push(m) },
      runProbe: async (file, args, input, env) => {
        probes.push({ file, args, input, env })
        if (args[FLAGS.length].endsWith('pitwall-hook.ps1')) {
          appendFileSync(env.PITWALL_SCRIPT_ERRORS, 'Cannot find an overload for "Contains"')
          return ran(0) // as a hook that swallowed its error does
        }
        writeFileSync(join(args[FLAGS.length + 1], 'statusline.json'), input)
        return ran(0)
      }
    }).start()
    await until(() => spawned.length === 1, 'claude')
    expect(logged).toEqual(['PowerShell scripts blocked (hook exit 0, status line ok): Cannot find an overload for "Contains"'])
    expect(probes.every((p) => dirname(p.env.PITWALL_SCRIPT_ERRORS) === dirname(probes[0].args[FLAGS.length + 1]))).toBe(true)
    expect(lastPty().env.PITWALL_SCRIPT_ERRORS).toBeUndefined() // never in Claude's (or the real hooks') environment
    expect(eventList().find((e) => e.e === 'pitwall:warning')?.msg).toBe(WARNINGS.scripts()) // no known reason: see host.log
  })

  describe('the banner says why, when that is known', () => {
    const POLICY_ERROR = [
      'File C:\\pw\\pitwall-hook.ps1 cannot be loaded because running scripts is disabled on this system. For more information, see',
      'about_Execution_Policies at https:/go.microsoft.com/fwlink/?LinkID=135170.',
      '    + CategoryInfo          : SecurityError: (:) [], ParentContainsErrorRecordException',
      '    + FullyQualifiedErrorId : UnauthorizedAccess'
    ].join('\r\n')
    const banner = () => eventList().filter((e) => e.e === 'pitwall:warning').map((e) => e.msg)

    test('an execution policy (from what PowerShell said, which also goes to the log)', async () => {
      writeHooks()
      const logged: string[] = []
      launcher({ log: (m) => { logged.push(m) }, runProbe: async (...a) => { probes.push({ file: a[0], args: a[1], input: a[2], env: a[3] }); return { rc: 1, stderr: POLICY_ERROR } } }).start()
      await until(() => spawned.length === 1, 'claude')
      expect(banner()).toEqual([WARNINGS.scripts(SCRIPT_TROUBLE.policy)])
      expect(screen).toContain(`pitwall: ${WARNINGS.scripts(SCRIPT_TROUBLE.policy)}`)
      expect(WARNINGS.scripts(SCRIPT_TROUBLE.policy)).toContain('execution policy')
      expect(logged).toHaveLength(1)
      expect(logged[0]).toContain('FullyQualifiedErrorId : UnauthorizedAccess')
      expect(settingsArg()).toBe(join(sd, 'hooks-without-scripts.json'))
    })

    test('the same, translated: the error id is not', async () => {
      writeHooks()
      launcher({ runProbe: async () => ({ rc: 1, stderr: 'Die Datei kann nicht geladen werden.\r\n    + FullyQualifiedErrorId : UnauthorizedAccess' }) }).start()
      await until(() => spawned.length === 1, 'claude')
      expect(banner()).toEqual([WARNINGS.scripts(SCRIPT_TROUBLE.policy)])
    })

    test('the probe never gets a token, so its logged stderr cannot hold one', async () => {
      writeHooks()
      launcher({ env: { PATH: '/usr/bin', HOME: dir, GH_TOKEN: 'secret1', GITHUB_TOKEN: 'secret2', GH_ENTERPRISE_TOKEN: 'secret3', GITHUB_ENTERPRISE_TOKEN: 'secret4' }, runProbe: probe() }).start()
      await until(() => spawned.length === 1, 'claude')
      expect(probes.length).toBeGreaterThan(0)
      for (const p of probes) {
        for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) expect(p.env[k]).toBeUndefined()
        expect(JSON.stringify(p.env)).not.toContain('secret')
      }
    })

    test.each([
      ['UnauthorizedAccessException: Access to the path is denied.', undefined],
      ['    + FullyQualifiedErrorId : UnauthorizedAccessException', undefined],
      ['    + FullyQualifiedErrorId : UnauthorizedAccess', SCRIPT_TROUBLE.policy]
    ])('the error id %j: banner reason %j', async (stderr, why) => {
      writeHooks()
      launcher({ runProbe: async () => ({ rc: 1, stderr }) }).start()
      await until(() => spawned.length === 1, 'claude')
      expect(banner()).toEqual([WARNINGS.scripts(why)])
    })

    test('a try that times out is made once more; one that works then keeps the scripts', async () => {
      writeHooks()
      const run = probe()
      let first = true
      launcher({ runProbe: async (...a) => {
        if (first) { first = false; probes.push({ file: a[0], args: a[1], input: a[2], env: a[3] }); return { rc: 1, timedOut: true } }
        return run(...a)
      } }).start()
      await until(() => spawned.length === 1, 'claude')
      expect(settingsArg()).toBe(join(sd, 'hooks.json'))
      expect(probes.map((p) => basename(p.args[FLAGS.length]))).toEqual(['pitwall-hook.ps1', 'pitwall-hook.ps1', 'pitwall-statusline.ps1'])
      expect(banner()).toEqual([])
    })

    test('timing out twice: both go, the status line is not tried too, and the banner says so', async () => {
      writeHooks()
      const logged: string[] = []
      launcher({ log: (m) => { logged.push(m) }, runProbe: async (...a) => { probes.push({ file: a[0], args: a[1], input: a[2], env: a[3] }); return { rc: 1, timedOut: true } } }).start()
      await until(() => spawned.length === 1, 'claude')
      expect(probes).toHaveLength(2)
      expect(JSON.parse(readFileSync(settingsArg(), 'utf8'))).toEqual({})
      expect(banner()).toEqual([WARNINGS.scripts(SCRIPT_TROUBLE.slow)])
      expect(logged).toEqual(['PowerShell scripts blocked (hook timed out twice, status line not tried)'])
    })

    test("PowerShell that can't be started", async () => {
      writeHooks()
      launcher({ runProbe: async () => ({ rc: 127, stderr: 'spawn powershell.exe ENOENT' }) }).start()
      await until(() => spawned.length === 1, 'claude')
      expect(banner()).toEqual([WARNINGS.scripts(SCRIPT_TROUBLE.noPowerShell)])
    })

    test('a script file that is missing', async () => {
      writeHooks({ hookScript: join(bin, 'gone', 'pitwall-hook.ps1') })
      launcher({ runProbe: async () => ({ rc: -196608, stderr: "The argument '...' to the -File parameter does not exist." }) }).start()
      await until(() => spawned.length === 1, 'claude')
      expect(banner()).toEqual([WARNINGS.scripts(SCRIPT_TROUBLE.missing)])
    })

    test('only the status line, timed out twice: its own banner says so', async () => {
      writeHooks()
      const run = probe()
      launcher({ runProbe: async (...a) => (a[1][FLAGS.length].endsWith('pitwall-statusline.ps1') ? { rc: 1, timedOut: true } : run(...a)) }).start()
      await until(() => spawned.length === 1, 'claude')
      expect(banner()).toEqual([WARNINGS.statusLine(SCRIPT_TROUBLE.slow)])
    })
  })

  describe('with the hooks off, a failed resume is told apart by whether Claude has a transcript (no SessionStart comes)', () => {
    const blockedResume = async (vars: Record<string, string> = {}): Promise<void> => {
      writeHooks()
      writeEnv({ ...baseVars(), ...vars })
      writeFileSync(join(sd, 'started'), '')
      launcher({ runProbe: probe({ hook: true, statusLine: true }) }).start()
      await until(() => spawned.length === 1, 'resume')
      expect(lastPty().args.slice(0, 2)).toEqual(['--resume', ID])
      lastPty().exit(1)
    }
    const transcript = (configDir: string) => {
      mkdirSync(join(configDir, 'projects', '-work-repo'), { recursive: true })
      writeFileSync(join(configDir, 'projects', '-work-repo', `${ID}.jsonl`), '{}\n')
    }

    test('no transcript: the conversation never started, so a new one does', async () => {
      mkdirSync(join(dir, '.claude', 'projects', '-work-repo'), { recursive: true }) // others' transcripts, not this one
      writeFileSync(join(dir, '.claude', 'projects', '-work-repo', 'other-id.jsonl'), '{}\n')
      await blockedResume()
      await until(() => spawned.length === 2, 'fresh launch')
      expect(lastPty().args.slice(0, 2)).toEqual(['--session-id', ID])
      expect(screen).toContain(MESSAGES.resumeFailed())
    })

    test("a transcript (in HOME's .claude): Claude's error stands, no new conversation over the same id", async () => {
      transcript(join(dir, '.claude'))
      await blockedResume()
      await until(() => screen.includes(MESSAGES.exited(1)), 'prompt')
      expect(spawned).toHaveLength(1)
      expect(screen).not.toContain(MESSAGES.resumeFailed())
    })

    test("the project's CLAUDE_CONFIG_DIR is where the transcript is looked for", async () => {
      transcript(join(dir, 'work-claude'))
      await blockedResume({ CLAUDE_CONFIG_DIR: join(dir, 'work-claude') })
      await until(() => screen.includes(MESSAGES.exited(1)), 'prompt')
      expect(spawned).toHaveLength(1)
    })
  })

  test('a hook that exits 0 but writes nothing counts as blocked', async () => {
    writeHooks({ statusLine: false })
    launcher({ runProbe: probe({ hook: 'silent' }) }).start()
    await until(() => spawned.length === 1, 'claude')
    expect(settingsArg()).toBe(join(sd, 'hooks-without-scripts.json'))
    expect(probes).toHaveLength(1) // no status line to try
  })

  test('only the status line blocked: the hooks stay, the status line goes, and that is what the banner says', async () => {
    writeHooks()
    launcher({ runProbe: probe({ statusLine: true }) }).start()
    await until(() => spawned.length === 1, 'claude')
    const settings = JSON.parse(readFileSync(settingsArg(), 'utf8'))
    expect(Object.keys(settings.hooks)).toEqual(['SessionStart', 'Stop'])
    expect(settings.statusLine).toBeUndefined()
    expect(eventList().filter((e) => e.e === 'pitwall:warning').map((e) => e.kind)).toEqual(['statusline'])
  })

  test('sh hooks (macOS) are not tried', async () => {
    writeFileSync(join(sd, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: "'/b/pitwall-hook' 'e' 's'" }] }] } }))
    launcher({ runProbe: probe({ hook: true }) }).start()
    await until(() => spawned.length === 1, 'claude')
    expect(probes).toEqual([])
    expect(settingsArg()).toBe(join(sd, 'hooks.json'))
  })
})

test('the words match the shell launcher (resources/bin/pitwall-launch), so both platforms say the same', () => {
  const script = readFileSync(resolve(__dirname, '../../resources/bin/pitwall-launch'), 'utf8')
  expect(script).toContain(`echo "${MESSAGES.setup('$PITWALL_SETUP_COMMAND')}"`)
  expect(script).toContain(`echo "${MESSAGES.setupFailed('$rc' as unknown as number)}"`)
  expect(script).toContain(`echo "${MESSAGES.resumeFailed()}"`)
  expect(script).toContain(`echo "${MESSAGES.exited('$rc' as unknown as number)}"`)
  expect(script).toContain(`echo "${MESSAGES.noToken('$PITWALL_GH_ACCOUNT').replace(/`/g, '\\`')}"`)
})
