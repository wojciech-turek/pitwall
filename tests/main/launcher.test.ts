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

async function writeEnv(p: Project, setupCommand?: string, userStatusLine?: string, server?: { devCommand?: string; portBase?: number; claudeAccountDir?: string }) {
  const env = buildSessionEnv({
    project: p, session: { id: ID, title: TITLE }, rootPath: cwd, sessionDir: sd, eventsFile: eventsFile(t.paths, ID),
    claudeBin: t.paths.claudeBin, ghBin: t.paths.ghBin, setupCommand, userStatusLine, home: t.tmp, ...server
  })
  await writeFile(join(sd, 'env.sh'), renderEnvFile(env), { mode: 0o600 })
}

async function setup(extra: { setupCommand?: string; silent?: boolean; project?: Project; userStatusLine?: string; dir?: string; server?: { devCommand?: string; portBase?: number; claudeAccountDir?: string } } = {}) {
  sd = extra.dir ?? sessionDir(t.paths, ID)
  cwd = join(t.tmp, 'work dir')
  await mkdir(sd, { recursive: true })
  await mkdir(sessionDir(t.paths, ID), { recursive: true }) // the events file's folder
  await mkdir(cwd, { recursive: true })
  await writeEnv(extra.project ?? project, extra.setupCommand, extra.userStatusLine, extra.server)
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

  describe('a session just moved to another account (moved-from)', () => {
    const relaunchFailing = async (): Promise<void> => {
      const flag = join(t.tmp, 'resume-fail')
      t.env.STUB_CLAUDE_RESUME_FAIL_FILE = flag
      await start()
      await waitCapture('STUB CLAUDE READY')
      await t.tmux.sendKeys('pw-l', ['exit', 'Enter'])
      await waitCapture('Press Enter to resume')
      await writeFile(flag, '')
      await writeFile(join(sd, 'moved-from'), 'default\n')
      await t.tmux.sendKeys('pw-l', ['Enter'])
    }
    /** As Claude keeps a conversation that has been said something in. */
    const withTranscript = async (): Promise<void> => {
      const folder = join(t.env.CLAUDE_CONFIG_DIR || join(t.env.HOME, '.claude'), 'projects', '-some-folder')
      await mkdir(folder, { recursive: true })
      await writeFile(join(folder, `${ID}.jsonl`), '{}\n')
    }

    test('a conversation with nothing in it yet has nothing to lose: a new one starts on the new account', async () => {
      await setup()
      await relaunchFailing()
      await waitFor(async () => (await logLines()).filter((l) => l.includes('--session-id')).length === 2, 8000, 'fresh launch')
      expect((await events()).some((e) => e.e === 'pitwall:move-failed')).toBe(false)
    })

    test('a resume that fails says so and never starts a new conversation', async () => {
      await setup()
      await withTranscript()
      await relaunchFailing()
      await waitFor(async () => (await events()).some((e) => e.e === 'pitwall:move-failed'), 8000, 'move-failed event')
      await waitCapture('Claude exited (code 1). Press Enter to resume.')
      const evs = await events()
      expect(evs.find((e) => e.e === 'pitwall:move-failed')).toMatchObject({ c: ID, code: 1 })
      expect(evs.at(-1)).toMatchObject({ e: 'pitwall:exited', code: 1 })
      const argv = (await logLines()).filter((l) => l.startsWith('--'))
      expect(argv.map((l) => l.split(' ')[0])).toEqual(['--session-id', '--resume'])
      expect(await capture()).not.toContain("Couldn't resume the previous conversation")
      expect(await readFile(join(sd, 'moved-from'), 'utf8')).toBe('default\n') // the app's to remove, never the launcher's
    })

    test('a resume that started and then failed is an ordinary exit', async () => {
      await setup()
      await writeFile(join(sd, 'moved-from'), 'default\n')
      await start()
      await waitCapture('STUB CLAUDE READY')
      await t.tmux.sendKeys('pw-l', ['exit', 'Enter'])
      await waitCapture('Press Enter to resume')
      await t.tmux.sendKeys('pw-l', ['Enter'])
      await waitFor(async () => (await events()).filter((e) => e.e === 'SessionStart').length === 2, 8000, 'resumed')
      expect((await events()).some((e) => e.e === 'pitwall:move-failed')).toBe(false)
    })
  })

  describe('the first prompt (initial-prompt.txt) and the agent note (system-note.txt)', () => {
    test('a new session starts Claude with the prompt as its last argument; a relaunch never repeats it', async () => {
      await setup()
      await writeFile(join(sd, 'initial-prompt.txt'), "Add a README line, don't $HOME it\n")
      await writeFile(join(sd, 'system-note.txt'), 'You are in Pitwall.\n')
      await start()
      await waitCapture('STUB CLAUDE READY')
      const flags = `--append-system-prompt-file ${sd}/system-note.txt`
      expect((await logLines())[0]).toBe(`--session-id ${ID} --settings ${sd}/hooks.json --name ${TITLE} ${flags} -- Add a README line, don't $HOME it`)
      expect(await stat(join(sd, 'initial-prompt.sent')).then(() => true, () => false)).toBe(true)
      expect(await stat(join(sd, 'initial-prompt.txt')).then(() => true, () => false)).toBe(false)
      // The app hears that a prompt is coming, right after the launch and before Claude's SessionStart.
      await waitFor(async () => (await events()).some((e) => e.e === 'SessionStart'), 8000, 'SessionStart')
      const names = (await events()).map((e) => e.e)
      expect(names.filter((n) => n === 'pitwall:prompt-pending')).toHaveLength(1)
      expect(names.indexOf('pitwall:prompt-pending')).toBe(names.indexOf('pitwall:launch') + 1)
      expect(names.indexOf('pitwall:prompt-pending')).toBeLessThan(names.indexOf('SessionStart'))
      await t.tmux.sendKeys('pw-l', ['exit', 'Enter'])
      await waitCapture('Press Enter to resume')
      // Claude started that conversation, so the prompt was given: it stays sent.
      expect(await stat(join(sd, 'initial-prompt.sent')).then(() => true, () => false)).toBe(true)
      expect(await stat(join(sd, 'initial-prompt.txt')).then(() => true, () => false)).toBe(false)
      await t.tmux.sendKeys('pw-l', ['Enter'])
      await waitFor(async () => (await logLines()).some((l) => l.includes('--resume')), 8000, 'resume argv')
      const resume = (await logLines()).find((l) => l.includes('--resume'))!
      expect(resume).toBe(`--resume ${ID} --settings ${sd}/hooks.json ${flags}`)
      await waitFor(async () => (await events()).filter((e) => e.e === 'SessionStart').length === 2, 8000, 'second SessionStart')
      expect((await events()).filter((e) => e.e === 'pitwall:prompt-pending')).toHaveLength(1) // the relaunch has no prompt
    })

    test('Claude exits before its SessionStart (No, exit at the folder-trust prompt): the prompt is kept for the next launch', async () => {
      await setup({ silent: true }) // no SessionStart, as when Claude stops at the trust prompt
      t.env.STUB_CLAUDE_RESUME_FAIL = '1' // that conversation never started, so the next launch is a new one
      await writeFile(join(sd, 'initial-prompt.txt'), 'Do the thing\n')
      await start()
      await waitCapture('STUB CLAUDE READY')
      expect((await logLines())[0]).toBe(`--session-id ${ID} --settings ${sd}/hooks.json --name ${TITLE} -- Do the thing`)
      await t.tmux.sendKeys('pw-l', ['exit', 'Enter'])
      await waitCapture('Press Enter to resume')
      expect(await readFile(join(sd, 'initial-prompt.txt'), 'utf8')).toBe('Do the thing\n')
      expect(await stat(join(sd, 'initial-prompt.sent')).then(() => true, () => false)).toBe(false)
      await t.tmux.sendKeys('pw-l', ['Enter'])
      await waitFor(async () => (await logLines()).filter((l) => l.startsWith('--session-id')).length === 2, 8000, 'new launch')
      expect((await logLines()).filter((l) => l.startsWith('--session-id'))[1]).toContain('-- Do the thing')
    })

    test('a prompt starting with a dash comes after "--", so Claude never reads it as an option', async () => {
      await setup()
      await writeFile(join(sd, 'initial-prompt.txt'), '- item one\n')
      await start()
      await waitCapture('STUB CLAUDE READY')
      expect((await logLines())[0]).toBe(`--session-id ${ID} --settings ${sd}/hooks.json --name ${TITLE} -- - item one`)
    })

    test('the note is read by Claude; without system-note.txt there is no --append-system-prompt-file at all', async () => {
      await setup()
      await writeFile(join(sd, 'system-note.txt'), 'You are in Pitwall.\n')
      await start()
      await waitCapture('STUB CLAUDE READY')
      expect((await logLines()).filter((l) => l.startsWith('NOTE='))).toEqual(['NOTE=You are in Pitwall.'])
      expect((await logLines())[0]).not.toContain('--system-prompt-snapshot')
    })

    test('no note and no prompt: nothing extra', async () => {
      await setup()
      await start()
      await waitCapture('STUB CLAUDE READY')
      expect((await logLines())[0]).toBe(`--session-id ${ID} --settings ${sd}/hooks.json --name ${TITLE}`)
      await waitFor(async () => (await events()).some((e) => e.e === 'SessionStart'), 8000, 'SessionStart')
      expect((await events()).map((e) => e.e)).not.toContain('pitwall:prompt-pending')
    })

    test('a continued session: snapshot off, and the note file (continue note, then agent note)', async () => {
      await setup()
      await writeFile(join(sd, 'continue-note.txt'), 'Work only here.\n')
      await writeFile(join(sd, 'system-note.txt'), 'Work only here.\n\nYou are in Pitwall.\n')
      await start()
      await waitCapture('STUB CLAUDE READY')
      expect((await logLines())[0]).toBe(`--session-id ${ID} --settings ${sd}/hooks.json --name ${TITLE} --system-prompt-snapshot off --append-system-prompt-file ${sd}/system-note.txt`)
      expect(await logLines()).toEqual(expect.arrayContaining(['NOTE=Work only here.', 'You are in Pitwall.']))
    })
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

  describe('Claude credentials inherited from the environment', () => {
    const KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']
    const claudeEnv = async (): Promise<Record<string, string>> => {
      const file = join(t.tmp, 'claude.env')
      t.env.STUB_CLAUDE_ENV_FILE = file
      for (const k of KEYS) t.env[k] = `inherited-${k}`
      await start()
      await waitCapture('STUB CLAUDE READY')
      return Object.fromEntries((await readFile(file, 'utf8')).split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
    }

    test('on an added account they are dropped, so the account shown is the one used', async () => {
      await setup({ server: { claudeAccountDir: join(t.tmp, 'acct') } })
      const env = await claudeEnv()
      expect(env.CLAUDE_CONFIG_DIR).toBe(join(t.tmp, 'acct'))
      for (const k of KEYS) expect(k in env).toBe(false)
    })

    test("on an added account, one the project set itself stays", async () => {
      await setup({
        project: { ...project, extraEnv: [{ key: 'ANTHROPIC_API_KEY', value: 'from-project' }] },
        server: { claudeAccountDir: join(t.tmp, 'acct') }
      })
      const env = await claudeEnv()
      expect(env.ANTHROPIC_API_KEY).toBe('from-project')
      expect('ANTHROPIC_AUTH_TOKEN' in env).toBe(false)
    })

    test('on the default account they pass through, as before', async () => {
      await setup()
      const env = await claudeEnv()
      for (const k of KEYS) expect(env[k]).toBe(`inherited-${k}`)
      expect('CLAUDE_CONFIG_DIR' in env).toBe(false)
    })
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
  describe('server entrypoint', () => {
    const startServer = () => t.tmux.newSession({ name: 'pw-v', cwd, argv: [join(t.paths.binDir, 'pitwall-server'), sd] })
    const serverPane = () => t.tmux.capturePane('pw-v')
    const waitServer = (s: string) => waitFor(async () => (await serverPane()).includes(s), 8000, `"${s}" in server pane`)

    test('runs the dev command with PORT set to PITWALL_PORT, and offers a restart when it exits', async () => {
      await setup({ server: { devCommand: 'printf "port=%s id=%s" "$PORT" "$PITWALL_SESSION_ID"', portBase: 40010 } })
      await startServer()
      await waitServer('port=40010 id=uuid-1')
      await waitServer('Dev server exited (code 0). Press Enter to start it again.')
      expect(await serverPane()).toContain('▸ printf')
    })

    test('a PORT inherited from the tmux server environment never overrides PITWALL_PORT', async () => {
      t.env.PORT = '1234'
      await setup({ server: { devCommand: 'printf "port=%s" "$PORT"', portBase: 40010 } })
      await startServer()
      await waitServer('port=40010')
      expect(await serverPane()).not.toContain('port=1234')
    })

    test('a PORT in the project environment wins over PITWALL_PORT', async () => {
      await setup({
        project: { ...project, extraEnv: [{ key: 'PORT', value: '3999' }] },
        server: { devCommand: 'printf "port=%s" "$PORT"', portBase: 40010 }
      })
      await startServer()
      await waitServer('port=3999')
    })

    test('Enter starts it again with the command re-read from env.sh', async () => {
      await setup({ server: { devCommand: 'printf "first-run"; exit 3', portBase: 40010 } })
      await startServer()
      await waitServer('Dev server exited (code 3)')
      await writeEnv(project, undefined, undefined, { devCommand: 'printf "second-run"', portBase: 40010 })
      await t.tmux.sendKeys('pw-v', ['Enter'])
      await waitServer('second-run')
    })
  })
})
