import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { exec } from '../../src/main/exec'
import { buildSessionEnv, renderEnvFile } from '../../src/main/identity'
import { buildHookSettings, hookCommandFor, statusLineCommandFor } from '../../src/main/hooks/settings'
import { parseEventLine } from '../../src/main/hooks/events'
import { eventsFile, sessionDir } from '../../src/main/paths'
import type { Project } from '../../src/shared/types'
import { makeTestEnv } from '../helpers/env'
import { waitFor } from '../helpers/wait'

const TITLE = "Fix 'tax' $ rounding 🧾"
const ID = 'uuid-1'
let t: Awaited<ReturnType<typeof makeTestEnv>>
let sd: string
let cwd: string
let claudeLog: string
let ghLog: string

const project: Project = {
  id: 'p', name: 'P', createdAt: 0, extraEnv: [],
  identity: { sshKeyPath: '/k/id', ghAccount: 'dev-work', gitName: 'Jane', gitEmail: 'm@x.io' }
}

async function writeEnv(p: Project, setupCommand?: string, userStatusLine?: string) {
  const env = buildSessionEnv({
    project: p, session: { id: ID, title: TITLE }, rootPath: cwd, sessionDir: sd, eventsFile: eventsFile(t.paths, ID),
    claudeBin: t.paths.claudeBin, ghBin: t.paths.ghBin, setupCommand, userStatusLine, home: t.tmp
  })
  await writeFile(join(sd, 'env.sh'), renderEnvFile(env), { mode: 0o600 })
}

async function setup(extra: { setupCommand?: string; silent?: boolean; project?: Project; userStatusLine?: string; dir?: string } = {}) {
  sd = extra.dir ?? sessionDir(t.paths, ID)
  cwd = join(t.tmp, 'work dir')
  await mkdir(sd, { recursive: true })
  await mkdir(sessionDir(t.paths, ID), { recursive: true }) // the events file's folder
  await mkdir(cwd, { recursive: true })
  await writeEnv(extra.project ?? project, extra.setupCommand, extra.userStatusLine)
  const hook = hookCommandFor(join(t.paths.binDir, 'pitwall-hook'), eventsFile(t.paths, ID), ID)
  const statusLine = statusLineCommandFor(join(t.paths.binDir, 'pitwall-statusline'), sd)
  await writeFile(join(sd, 'hooks.json'), JSON.stringify(buildHookSettings(hook, statusLine)))
  await writeFile(join(sd, 'claude-id'), ID)
  claudeLog = join(t.tmp, 'claude.log')
  ghLog = join(t.tmp, 'gh.log')
  t.env.STUB_CLAUDE_LOG = claudeLog
  t.env.STUB_GH_LOG = ghLog
  if (extra.silent) t.env.STUB_CLAUDE_SILENT = '1'
}

const start = () =>
  t.tmux.newSession({ name: 'pw-l', cwd, argv: [join(t.paths.binDir, 'pitwall-launch'), sd] })
const capture = () => t.tmux.capturePane('pw-l')
const waitCapture = (s: string) => waitFor(async () => (await capture()).includes(s), 8000, `"${s}" in pane`)
const events = async () => {
  const txt = await readFile(eventsFile(t.paths, ID), 'utf8').catch(() => '')
  return txt.split('\n').filter(Boolean).map((l) => parseEventLine(l)!).filter(Boolean)
}
const logLines = async () => (await readFile(claudeLog, 'utf8').catch(() => '')).split('\n').filter(Boolean)

beforeEach(async () => {
  t = await makeTestEnv()
})
afterEach(async () => { await t.cleanup() })

describe('pitwall-launch', () => {
  test('first launch passes session id, settings and name; token via env only', async () => {
    await setup()
    await start()
    await waitCapture('STUB CLAUDE READY')
    const lines = await logLines()
    expect(lines[0]).toContain(`--session-id ${ID}`)
    expect(lines[0]).toContain(`--settings ${sd}/hooks.json`)
    expect(lines[0]).toContain(`--name ${TITLE}`)
    expect(lines[0]).not.toContain('--system-prompt-snapshot') // only a conversation continued from outside Pitwall
    expect(lines).toContain('GH_TOKEN=token-for-dev-work')
    for (let i = 0; i < 3; i++) {
      const ps = (await exec('ps', ['-axww', '-o', 'args'])).stdout
      expect(ps).not.toContain('token-for-dev-work')
      await new Promise((r) => setTimeout(r, 100))
    }
    await waitFor(async () => {
      const ev = await events()
      return ev.some((e) => e.e === 'SessionStart' && e.sid === ID)
    }, 8000, 'SessionStart event')
    const ev = await events()
    const names = ev.map((e) => e.e)
    expect(names.indexOf('pitwall:launch')).toBeGreaterThanOrEqual(0)
    expect(names.indexOf('pitwall:launch')).toBeLessThan(names.indexOf('SessionStart'))
    expect(ev.find((e) => e.e === 'pitwall:launch')).toMatchObject({ mode: 'new' })
  })

  test('exit then Enter resumes with same id and settings', async () => {
    await setup()
    await start()
    await waitCapture('STUB CLAUDE READY')
    await t.tmux.sendKeys('pw-l', ['exit', 'Enter'])
    await waitFor(async () => (await events()).find((e) => e.e === 'pitwall:exited'), 8000, 'pitwall:exited')
    expect((await events()).find((e) => e.e === 'pitwall:exited')).toMatchObject({ code: 0 })
    await waitCapture('Press Enter to resume')
    await t.tmux.sendKeys('pw-l', ['Enter'])
    await waitFor(async () => (await logLines()).filter((l) => l.includes('--resume')).length === 1, 8000, 'resume argv')
    const resume = (await logLines()).find((l) => l.includes('--resume'))!
    expect(resume).toContain(`--resume ${ID}`)
    expect(resume).toContain('--settings')
    expect(resume).not.toContain('--name')
    await waitFor(async () => (await events()).filter((e) => e.e === 'pitwall:launch').length === 2, 8000, 'second launch')
    expect((await events()).filter((e) => e.e === 'pitwall:launch')[1]).toMatchObject({ mode: 'resume' })
  })

  test('failed resume with no SessionStart falls back to a new conversation', async () => {
    await setup()
    const flag = join(t.tmp, 'resume-fail')
    t.env.STUB_CLAUDE_RESUME_FAIL_FILE = flag
    await start()
    await waitCapture('STUB CLAUDE READY')
    await t.tmux.sendKeys('pw-l', ['exit', 'Enter'])
    await waitCapture('Press Enter to resume')
    await writeFile(flag, '')
    await t.tmux.sendKeys('pw-l', ['Enter'])
    await waitCapture("Couldn't resume the previous conversation — starting a new one.")
    await waitFor(async () => (await logLines()).filter((l) => l.includes('--session-id')).length === 2, 8000, 'fresh launch')
    const argv = (await logLines()).filter((l) => l.startsWith('--') )
    expect(argv.map((l) => l.split(' ')[0])).toEqual(['--session-id', '--resume', '--session-id'])
    expect(argv[2]).toContain(`--session-id ${ID}`)
    expect(argv[2]).toContain(`--name ${TITLE}`)
    const modes = (await events()).filter((e) => e.e === 'pitwall:launch').map((e) => (e as { mode?: string }).mode)
    expect(modes).toEqual(['new', 'resume', 'new'])
  })

  describe('a conversation continued from outside Pitwall (continue-note.txt)', () => {
    /** The project's own Claude config dir, which reaches the script through env.sh. */
    const withConfigDir = (dir: string): Project => ({ ...project, extraEnv: [{ key: 'CLAUDE_CONFIG_DIR', value: dir }] })
    /** A transcript as Claude keeps it: `<config dir>/projects/<folder>/<id>.jsonl` (only ever listed, never read). */
    const transcript = async (configDir: string, id: string) => {
      await mkdir(join(configDir, 'projects', '-x-repo'), { recursive: true })
      await writeFile(join(configDir, 'projects', '-x-repo', `${id}.jsonl`), '{}\n')
    }
    /** Starts, exits, then fails the resume (exit 1, no SessionStart). */
    const failResume = async () => {
      const flag = join(t.tmp, 'resume-fail')
      t.env.STUB_CLAUDE_RESUME_FAIL_FILE = flag
      await start()
      await waitCapture('STUB CLAUDE READY')
      await t.tmux.sendKeys('pw-l', ['exit', 'Enter'])
      await waitCapture('Press Enter to resume')
      await writeFile(flag, '')
      await t.tmux.sendKeys('pw-l', ['Enter'])
      return flag
    }

    test("its transcript exists: a failed resume never starts a new conversation over it; Claude's error stands and Enter tries --resume again, every launch with --system-prompt-snapshot off and the note, whose path arrives whole", async () => {
      const config = join(t.tmp, `it's a "claude" config`)
      await setup({ dir: join(t.tmp, `it's a "session" dir`, ID), project: withConfigDir(config) })
      await transcript(config, ID)
      const note = join(sd, 'continue-note.txt')
      await writeFile(note, 'Work only here.\n')
      const flag = await failResume()
      await waitCapture('Claude exited (code 1). Press Enter to resume.')
      expect(await capture()).not.toContain("Couldn't resume the previous conversation")
      await rm(flag)
      await t.tmux.sendKeys('pw-l', ['Enter'])
      await waitFor(async () => (await logLines()).filter((l) => l.startsWith('NOTE=')).length === 3, 8000, 'the second resume read the note')
      const flags = `--system-prompt-snapshot off --append-system-prompt-file ${note}`
      expect((await logLines()).filter((l) => l.startsWith('--'))).toEqual([
        `--session-id ${ID} --settings ${sd}/hooks.json --name ${TITLE} ${flags}`,
        `--resume ${ID} --settings ${sd}/hooks.json ${flags}`,
        `--resume ${ID} --settings ${sd}/hooks.json ${flags}`
      ])
      // The stub read the file at the path it was given: one argument, quotes and spaces kept.
      expect((await logLines()).filter((l) => l.startsWith('NOTE='))).toEqual(Array(3).fill('NOTE=Work only here.'))
      await waitFor(async () => (await events()).filter((e) => e.e === 'pitwall:launch').length === 3, 8000, 'third launch')
      const ev = (await events()).filter((e) => e.e === 'pitwall:launch' || e.e === 'pitwall:exited')
      expect(ev.map((e) => [e.e, (e as { mode?: string }).mode ?? (e as { code?: number }).code])).toEqual([
        ['pitwall:launch', 'new'], ['pitwall:exited', 0], ['pitwall:launch', 'resume'], ['pitwall:exited', 1], ['pitwall:launch', 'resume']
      ])
    })

    test('no transcript of its id (after a /clear, say): a failed resume still starts a new conversation, with the note', async () => {
      const config = join(t.tmp, 'claude config')
      await setup({ project: withConfigDir(config) })
      await transcript(config, 'the-id-before-clear')
      await transcript(join(t.tmp, '.claude'), ID) // in HOME's config dir, not the session's: doesn't count
      const note = join(sd, 'continue-note.txt')
      await writeFile(note, 'Work only here.\n')
      await failResume()
      await waitCapture("Couldn't resume the previous conversation — starting a new one.")
      await waitFor(async () => (await logLines()).filter((l) => l.startsWith('NOTE=')).length === 3, 8000, 'the fresh launch read the note')
      const flags = `--system-prompt-snapshot off --append-system-prompt-file ${note}`
      expect((await logLines()).filter((l) => l.startsWith('--'))).toEqual([
        `--session-id ${ID} --settings ${sd}/hooks.json --name ${TITLE} ${flags}`,
        `--resume ${ID} --settings ${sd}/hooks.json ${flags}`,
        `--session-id ${ID} --settings ${sd}/hooks.json --name ${TITLE} ${flags}`
      ])
    })
  })

  test('relaunch re-reads env.sh and the token: an edited identity applies after exit + Enter', async () => {
    await setup()
    await start()
    await waitCapture('STUB CLAUDE READY')
    expect(await logLines()).toEqual(expect.arrayContaining([
      'GIT_AUTHOR_EMAIL=m@x.io', "GIT_SSH_COMMAND=ssh -i '/k/id' -o IdentitiesOnly=yes", 'GH_TOKEN=token-for-dev-work'
    ]))
    await writeEnv({
      ...project, identity: { sshKeyPath: '', ghAccount: 'dev-personal', gitName: 'W', gitEmail: 'new@x.io' }
    })
    await t.tmux.sendKeys('pw-l', ['exit', 'Enter'])
    await waitCapture('Press Enter to resume')
    await t.tmux.sendKeys('pw-l', ['Enter'])
    await waitFor(async () => (await logLines()).some((l) => l.includes('--resume')), 8000, 'relaunch')
    await waitFor(async () => (await logLines()).length >= 10, 8000, 'relaunch env logged')
    const after = (await logLines()).slice(5)
    expect(after[0]).toContain('--resume')
    expect(after).toEqual(expect.arrayContaining([
      'GIT_AUTHOR_EMAIL=new@x.io', 'GIT_SSH_COMMAND=', 'GH_TOKEN=token-for-dev-personal', 'GH_CONFIG_DIR='
    ]))
  })

  test('token fetch failure fails closed: gh runs signed out, not as the active account', async () => {
    await setup({ project: { ...project, identity: { ...project.identity, ghAccount: 'nobody' } } })
    await start()
    await waitCapture("pitwall: couldn't get a GitHub token for nobody")
    await waitCapture('STUB CLAUDE READY')
    const lines = await logLines()
    expect(lines).toContain('GH_TOKEN=')
    expect(lines).toContain(`GH_CONFIG_DIR=${sd}/gh-unauthenticated`)
    expect((await stat(join(sd, 'gh-unauthenticated'))).isDirectory()).toBe(true)
  })

  test('shell entrypoint fails closed too', async () => {
    await setup({ project: { ...project, identity: { ...project.identity, ghAccount: 'nobody' } } })
    await t.tmux.newSession({ name: 'pw-s', cwd, argv: [join(t.paths.binDir, 'pitwall-shell'), sd] })
    await waitFor(async () => {
      await t.tmux.sendKeys('pw-s', ['echo "G:$GH_CONFIG_DIR:${GH_TOKEN:-none}"', 'Enter'])
      return (await t.tmux.capturePane('pw-s')).includes(`G:${sd}/gh-unauthenticated:none`)
    }, 8000, 'fail-closed gh env in shell')
  })

  test("status line: Claude's JSON is kept in statusline.json; the user's line from env.sh is chained", async () => {
    t.env.STUB_RATE_LIMITS = '{"five_hour":{"used_percentage":64,"resets_at":1900000000}}'
    await setup({ userStatusLine: `jq -r '"five=" + (.rate_limits.five_hour.used_percentage|tostring)'` })
    await start()
    await waitCapture('STUB CLAUDE READY')
    await t.tmux.sendKeys('pw-l', ['hello', 'Enter'])
    await waitCapture('status: five=64')
    const saved = JSON.parse(await readFile(join(sd, 'statusline.json'), 'utf8'))
    expect(saved.rate_limits).toEqual({ five_hour: { used_percentage: 64, resets_at: 1900000000 } })
    expect(saved.session_id).toBe(ID)
  })

  test('status line without a user line of its own shows nothing but still keeps the JSON', async () => {
    await setup()
    await start()
    await waitCapture('STUB CLAUDE READY')
    await t.tmux.sendKeys('pw-l', ['hello', 'Enter'])
    await waitFor(async () => (await readFile(join(sd, 'statusline.json'), 'utf8').catch(() => '')).includes('rate_limits'), 8000, 'statusline.json')
    expect(await capture()).not.toContain('status:')
  })

  test('setup command runs once, failure does not block', async () => {
    await setup({ setupCommand: 'echo ran >> setup.log' })
    await start()
    await waitCapture('STUB CLAUDE READY')
    await t.tmux.sendKeys('pw-l', ['exit', 'Enter'])
    await waitCapture('Press Enter to resume')
    await t.tmux.sendKeys('pw-l', ['Enter'])
    await waitFor(async () => (await logLines()).some((l) => l.includes('--resume')), 8000, 'relaunch')
    expect((await readFile(join(cwd, 'setup.log'), 'utf8')).trim().split('\n')).toEqual(['ran'])
  })

  test('failing setup command is reported and Claude still starts', async () => {
    await setup({ setupCommand: 'exit 7' })
    await start()
    await waitCapture('Setup command failed (exit 7)')
    await waitCapture('STUB CLAUDE READY')
  })

  test('shell entrypoint exports identity', async () => {
    await setup()
    await t.tmux.newSession({ name: 'pw-s', cwd, argv: [join(t.paths.binDir, 'pitwall-shell'), sd] })
    await waitFor(async () => {
      await t.tmux.sendKeys('pw-s', ['echo "S:$GIT_SSH_COMMAND"', 'Enter'])
      return (await t.tmux.capturePane('pw-s')).includes("S:ssh -i '")
    }, 8000, 'identity echoed in shell')
  })
})
