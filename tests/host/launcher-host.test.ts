/**
 * The host's launcher (Windows' pitwall-launch) in a real host, with the stub claude and Pitwall's real hook and
 * status line scripts: the same scenarios as tests/main/launcher.test.ts, for the shell launcher under tmux.
 */
import { execFile } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { parseEventLine } from '../../src/main/hooks/events'
import { buildHookSettings, hookCommandFor, statusLineCommandFor } from '../../src/main/hooks/settings'
import type { HostBackend } from '../../src/main/host-backend'
import { buildSessionEnv, renderEnvFile } from '../../src/main/identity'
import { eventsFile, sessionDir } from '../../src/main/paths'
import type { Project } from '../../src/shared/types'
import { makeTestEnv } from '../helpers/env'
import { makeHostBackend, stopHost } from '../helpers/host'
import { waitFor } from '../helpers/wait'

const run = promisify(execFile)
const fixtures = resolve(__dirname, '..', 'fixtures', 'bin')
/** The stub claude each scenario runs with: the sh one (as on macOS) and the Node one (as on Windows). */
const STUBS: Array<[string, string]> = [['sh stub', join(fixtures, 'claude')], ['Node stub', join(fixtures, 'claude.mjs')]]

const TITLE = "Fix 'tax' $ rounding 🧾"
const ID = 'uuid-1'
const NAME = 'pw-l'

const project: Project = {
  id: 'p', name: 'P', createdAt: 0, extraEnv: [],
  identity: { sshKeyPath: '/k/id', ghAccount: 'dev-work', gitName: 'Jane', gitEmail: 'm@x.io' }
}

describe.each(STUBS)('the host launcher, with the %s', (_label, claudeBin) => {
  let t: Awaited<ReturnType<typeof makeTestEnv>>
  let b: HostBackend
  let dataDir: string
  let sd: string
  let cwd: string
  let claudeLog: string

  async function writeEnv(p: Project, setupCommand?: string, userStatusLine?: string) {
    const env = buildSessionEnv({
      project: p, session: { id: ID, title: TITLE }, rootPath: cwd, sessionDir: sd, eventsFile: eventsFile(t.paths, ID),
      claudeBin, ghBin: t.paths.ghBin, setupCommand, userStatusLine, home: t.tmp
    })
    await writeFile(join(sd, 'env.sh'), renderEnvFile(env), { mode: 0o600 })
    await writeFile(join(sd, 'env.json'), JSON.stringify(env), { mode: 0o600 })
  }

  async function setup(extra: { setupCommand?: string; project?: Project; userStatusLine?: string } = {}) {
    await writeEnv(extra.project ?? project, extra.setupCommand, extra.userStatusLine)
    const hook = hookCommandFor(join(t.paths.binDir, 'pitwall-hook'), eventsFile(t.paths, ID), ID)
    const statusLine = statusLineCommandFor(join(t.paths.binDir, 'pitwall-statusline'), sd)
    await writeFile(join(sd, 'hooks.json'), JSON.stringify(buildHookSettings(hook, statusLine)))
    await writeFile(join(sd, 'claude-id'), ID)
    // The host is started by the first newSession, with this environment (as the app's).
    b = makeHostBackend(dataDir, { env: t.env })
  }

  const start = () => b.newSession({ name: NAME, cwd, argv: [], launcher: { kind: 'claude', sessionDir: sd } })
  const capture = () => b.capture(NAME)
  const waitCapture = (s: string) => waitFor(async () => (await capture()).includes(s), 10_000, `"${s}" in the terminal`)
  const events = async () => {
    const txt = await readFile(eventsFile(t.paths, ID), 'utf8').catch(() => '')
    return txt.split('\n').filter(Boolean).map((l) => parseEventLine(l)!).filter(Boolean)
  }
  const logLines = async () => (await readFile(claudeLog, 'utf8').catch(() => '')).split('\n').filter(Boolean)

  beforeEach(async () => {
    t = await makeTestEnv()
    dataDir = join(t.tmp, 'host data')
    sd = sessionDir(t.paths, ID)
    cwd = join(t.tmp, 'work dir')
    await mkdir(sd, { recursive: true })
    await mkdir(cwd, { recursive: true })
    claudeLog = join(t.tmp, 'claude.log')
    t.env.STUB_CLAUDE_LOG = claudeLog
    t.env.STUB_GH_LOG = join(t.tmp, 'gh.log')
  })
  afterEach(async () => {
    b?.disconnect()
    await stopHost(dataDir)
    await t.cleanup()
  })

  test('first launch passes session id, settings and name; token via env only; Claude is the pane, under the host', async () => {
    await setup()
    await start()
    await waitCapture('STUB CLAUDE READY')
    const lines = await logLines()
    expect(lines[0]).toBe(`--session-id ${ID} --settings ${sd}/hooks.json --name ${TITLE}`)
    expect(lines).toContain('GH_TOKEN=token-for-dev-work')
    for (let i = 0; i < 3; i++) {
      expect((await run('ps', ['-axww', '-o', 'args'])).stdout).not.toContain('token-for-dev-work')
      await new Promise((r) => setTimeout(r, 100))
    }
    await waitFor(async () => (await events()).some((e) => e.e === 'SessionStart' && e.sid === ID), 10_000, 'SessionStart')
    const names = (await events()).map((e) => e.e)
    expect(names.indexOf('pitwall:launch')).toBeGreaterThanOrEqual(0)
    expect(names.indexOf('pitwall:launch')).toBeLessThan(names.indexOf('SessionStart'))
    expect((await events()).find((e) => e.e === 'pitwall:launch')).toMatchObject({ mode: 'new' })
    // Leftover cleanup counts on this: the pane's process is Claude itself, a child of the host.
    const roots = await b.processRoots(NAME)
    expect(roots.serverPid).toBe(b.hostPid)
    const [pane] = roots.panePids
    // When the host started it (Windows tells a reused pane pid apart by this).
    expect(roots.paneStarts).toHaveLength(1)
    expect(Date.now() - roots.paneStarts![0]).toBeLessThan(30_000)
    const ppid = Number((await run('ps', ['-o', 'ppid=', '-p', String(pane)])).stdout.trim())
    expect(ppid).toBe(roots.serverPid)
  })

  test('exit then Enter resumes with the same id and settings', async () => {
    await setup()
    await start()
    await waitCapture('STUB CLAUDE READY')
    await b.sendKeys(NAME, ['exit', 'Enter'])
    await waitFor(async () => (await events()).find((e) => e.e === 'pitwall:exited'), 10_000, 'pitwall:exited')
    expect((await events()).find((e) => e.e === 'pitwall:exited')).toMatchObject({ code: 0 })
    await waitCapture('Claude exited (code 0). Press Enter to resume.')
    expect((await b.processRoots(NAME)).panePids).toEqual([]) // nothing runs while it waits
    await b.sendKeys(NAME, ['Enter'])
    await waitFor(async () => (await logLines()).filter((l) => l.includes('--resume')).length === 1, 10_000, 'resume argv')
    const resume = (await logLines()).find((l) => l.includes('--resume'))!
    expect(resume).toBe(`--resume ${ID} --settings ${sd}/hooks.json`)
    await waitFor(async () => (await events()).filter((e) => e.e === 'pitwall:launch').length === 2, 10_000, 'second launch')
    expect((await events()).filter((e) => e.e === 'pitwall:launch')[1]).toMatchObject({ mode: 'resume' })
  })

  test('failed resume with no SessionStart falls back to a new conversation', async () => {
    await setup()
    const flag = join(t.tmp, 'resume-fail')
    t.env.STUB_CLAUDE_RESUME_FAIL_FILE = flag
    b = makeHostBackend(dataDir, { env: t.env })
    await start()
    await waitCapture('STUB CLAUDE READY')
    await b.sendKeys(NAME, ['exit', 'Enter'])
    await waitCapture('Press Enter to resume')
    await writeFile(flag, '')
    await b.sendKeys(NAME, ['Enter'])
    await waitCapture("Couldn't resume the previous conversation — starting a new one.")
    await waitFor(async () => (await logLines()).filter((l) => l.includes('--session-id')).length === 2, 10_000, 'fresh launch')
    const argv = (await logLines()).filter((l) => l.startsWith('--'))
    expect(argv.map((l) => l.split(' ')[0])).toEqual(['--session-id', '--resume', '--session-id'])
    expect(argv[2]).toContain(`--name ${TITLE}`)
    const modes = (await events()).filter((e) => e.e === 'pitwall:launch').map((e) => (e as { mode?: string }).mode)
    expect(modes).toEqual(['new', 'resume', 'new'])
  })

  test('relaunch re-reads the session env and the token: an edited identity applies after exit + Enter', async () => {
    await setup()
    await start()
    await waitCapture('STUB CLAUDE READY')
    expect(await logLines()).toEqual(expect.arrayContaining([
      'GIT_AUTHOR_EMAIL=m@x.io', "GIT_SSH_COMMAND=ssh -i '/k/id' -o IdentitiesOnly=yes", 'GH_TOKEN=token-for-dev-work'
    ]))
    await writeEnv({ ...project, identity: { sshKeyPath: '', ghAccount: 'dev-personal', gitName: 'W', gitEmail: 'new@x.io' } })
    await b.sendKeys(NAME, ['exit', 'Enter'])
    await waitCapture('Press Enter to resume')
    await b.sendKeys(NAME, ['Enter'])
    await waitFor(async () => (await logLines()).length >= 10, 10_000, 'relaunch env logged')
    const after = (await logLines()).slice(5)
    expect(after[0]).toContain('--resume')
    expect(after).toEqual(expect.arrayContaining([
      'GIT_AUTHOR_EMAIL=new@x.io', 'GIT_SSH_COMMAND=', 'GH_TOKEN=token-for-dev-personal', 'GH_CONFIG_DIR='
    ]))
  })

  test('token fetch failure fails closed, and inherited tokens never stand in', async () => {
    t.env.GH_TOKEN = 'inherited-token'
    t.env.GITHUB_TOKEN = 'inherited-token-2'
    await setup({ project: { ...project, identity: { ...project.identity, ghAccount: 'nobody' } } })
    await start()
    await waitCapture("pitwall: couldn't get a GitHub token for nobody")
    await waitCapture('STUB CLAUDE READY')
    const lines = await logLines()
    expect(lines).toContain('GH_TOKEN=')
    expect(lines).toContain(`GH_CONFIG_DIR=${sd}/gh-unauthenticated`)
    expect((await stat(join(sd, 'gh-unauthenticated'))).isDirectory()).toBe(true)
    // gh itself was asked with no token in its environment.
    expect(await readFile(t.env.STUB_GH_LOG, 'utf8')).toMatch(/auth token --hostname github.com --user nobody\nGH_TOKEN=unset\nGITHUB_TOKEN=unset/)
  })

  test("status line: Claude's JSON is kept in statusline.json; the user's line is chained", async () => {
    t.env.STUB_RATE_LIMITS = '{"five_hour":{"used_percentage":64,"resets_at":1900000000}}'
    await setup({ userStatusLine: `jq -r '"five=" + (.rate_limits.five_hour.used_percentage|tostring)'` })
    await start()
    await waitCapture('STUB CLAUDE READY')
    await b.sendKeys(NAME, ['hello', 'Enter'])
    await waitCapture('status: five=64')
    const saved = JSON.parse(await readFile(join(sd, 'statusline.json'), 'utf8'))
    expect(saved.rate_limits).toEqual({ five_hour: { used_percentage: 64, resets_at: 1900000000 } })
  })

  test('setup command runs once, before Claude; a failing one is reported and Claude still starts', async () => {
    await setup({ setupCommand: 'echo ran >> setup.log; exit 7' })
    await start()
    await waitCapture('▸ Running setup: echo ran >> setup.log; exit 7')
    await waitCapture('Setup command failed (exit 7)')
    await waitCapture('STUB CLAUDE READY')
    await b.sendKeys(NAME, ['exit', 'Enter'])
    await waitCapture('Press Enter to resume')
    await b.sendKeys(NAME, ['Enter'])
    await waitFor(async () => (await logLines()).some((l) => l.includes('--resume')), 10_000, 'relaunch')
    expect((await readFile(join(cwd, 'setup.log'), 'utf8')).trim().split('\n')).toEqual(['ran'])
  })

  test('killing the session ends Claude and nothing relaunches', async () => {
    await setup()
    await start()
    await waitCapture('STUB CLAUDE READY')
    const [pid] = (await b.processRoots(NAME)).panePids
    await b.killSession(NAME)
    expect(await b.hasSession(NAME)).toBe(false)
    await waitFor(async () => { try { process.kill(pid, 0); return false } catch { return true } }, 10_000, 'claude ended')
    await new Promise((r) => setTimeout(r, 300))
    expect((await logLines()).filter((l) => l.startsWith('--'))).toHaveLength(1)
    expect((await events()).filter((e) => e.e === 'pitwall:exited')).toEqual([])
  })

  test('the Shell tab: the session identity (failing closed too), then the shell', async () => {
    await setup({ project: { ...project, identity: { ...project.identity, ghAccount: 'nobody' } } })
    await b.newSession({ name: 'pw-s', cwd, argv: ['/bin/sh'], launcher: { kind: 'shell', sessionDir: sd } })
    await waitFor(async () => {
      await b.sendKeys('pw-s', ['echo "G:$GH_CONFIG_DIR:${GH_TOKEN:-none}:$GIT_SSH_COMMAND"', 'Enter'])
      return (await b.capture('pw-s')).includes(`G:${sd}/gh-unauthenticated:none:ssh -i '/k/id'`)
    }, 10_000, 'identity and fail-closed gh env in the shell')
    await b.sendKeys('pw-s', ['exit 4', 'Enter'])
    await waitFor(async () => !(await b.hasSession('pw-s')), 10_000, 'the shell ends the terminal')
  })
})
