import { execFile } from 'node:child_process'
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { cliSocketPath, cliToken } from '../../src/main/cli/auth'
import { exec } from '../../src/main/exec'
import { GitClient } from '../../src/main/git'
import { forwardSlashes } from '../../src/main/hooks/settings'
import { sessionDir } from '../../src/main/paths'
import { KeyedMutex } from '../../src/main/sessions/mutex'
import { AGENT_NOTE, prepareNewSession, startSession, writeSessionFiles, type StarterDeps } from '../../src/main/sessions/starter'
import { PortAllocator } from '../../src/main/ports'
import { Store } from '../../src/main/store'
import type { SessionBackend } from '../../src/main/backend'
import { claudeTmuxName } from '../../src/main/tmux'
import type { NewSessionInput, Project, Session, StartProgress, SubProject } from '../../src/shared/types'
import { makeTestEnv } from '../helpers/env'
import { WINDOWS } from '../helpers/processes'
import { makeRepo } from '../helpers/repo'
import { waitFor } from '../helpers/wait'

const run = promisify(execFile)
const has = (p: string) => access(p).then(() => true, () => false)

let t: Awaited<ReturnType<typeof makeTestEnv>>
let repos: Awaited<ReturnType<typeof makeRepo>>[] = []
let store: Store
let deps: StarterDeps
let progress: StartProgress[]

const project: Project = {
  id: 'p_1', name: 'P', createdAt: 0, extraEnv: [],
  identity: { sshKeyPath: '', ghAccount: 'dev-work', gitName: 'Jane', gitEmail: 'm@x.io' }
}

beforeEach(async () => {
  t = await makeTestEnv()
  repos = []
  progress = []
  await mkdir(t.paths.sshDir, { recursive: true })
  project.identity.sshKeyPath = join(t.paths.sshDir, 'id_test')
  await writeFile(project.identity.sshKeyPath, 'fake')
  store = await Store.open(t.paths.stateFile)
  await store.update((d) => {
    d.projects.push(structuredClone(project))
  })
})
afterEach(async () => {
  for (const r of repos) await r.cleanup()
  await t.cleanup()
})

function mkDeps(over: Partial<StarterDeps> = {}, gitEnv: Record<string, string> = t.env): StarterDeps {
  return {
    store, paths: t.paths, git: new GitClient(exec, gitEnv), backend: t.backend, exec, env: t.env, home: t.tmp,
    mutex: new KeyedMutex(),
    ...over
  }
}

async function addRepo(o: { commits?: boolean; dirName?: string; relPath?: string; name?: string } = {}) {
  const r = await makeRepo({ commits: o.commits, dirName: o.dirName })
  repos.push(r)
  if (o.relPath) {
    await mkdir(join(r.root, o.relPath), { recursive: true })
    await writeFile(join(r.root, o.relPath, 'f.txt'), 'x')
    await run('git', ['add', '-A'], { cwd: r.root, env: r.env })
    await run('git', ['commit', '-m', 'sub'], { cwd: r.root, env: r.env })
  }
  const sp: SubProject = {
    id: `sp_${store.state.subProjects.length + 1}`, projectId: 'p_1', name: o.name ?? 'My Repo', kind: 'repo',
    path: o.relPath ? join(r.root, o.relPath) : r.root, repoRoot: r.root, relPath: o.relPath ?? '', createdAt: 0
  }
  await store.update((d) => {
    d.subProjects.push(sp)
  })
  deps = mkDeps({}, r.env)
  return { r, sp }
}

const input = (sp: SubProject, o: Partial<NewSessionInput> = {}): NewSessionInput => ({
  requestId: 'r1', subProjectId: sp.id, title: 'Fix tax rounding', branchMode: 'new', branch: '', ...o
})
const start = (i: NewSessionInput) => startSession(i, deps, (p) => progress.push(p))
const branchesOf = async (root: string, env: Record<string, string>) =>
  (await run('git', ['branch', '--format=%(refname:short)'], { cwd: root, env })).stdout.split('\n').filter(Boolean)

describe('startSession', () => {
  test('repo session happy path', async () => {
    const { r, sp } = await addRepo()
    const res = await start(input(sp))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const s = store.state.sessions[0]
    expect(s.id).toBe(res.sessionId)
    expect(s.branch).toBe('pitwall/fix-tax-rounding')
    expect(s.branchCreatedByPitwall).toBe(true)
    expect(await has(s.worktreePath!)).toBe(true)
    expect(s.baseBranch).toBe('main')
    expect(s.baseCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(await t.backend.hasSession(claudeTmuxName(s.id))).toBe(true)
    const envFile = join(sessionDir(t.paths, s.id), 'env.sh')
    if (!WINDOWS) expect((await stat(envFile)).mode & 0o777).toBe(0o600) // (no POSIX modes on Windows)
    expect(await readFile(envFile, 'utf8')).not.toContain('token-for')
    // The same variables as JSON, for the host's launcher (Windows): owner-only, no token either.
    const envJson = join(sessionDir(t.paths, s.id), 'env.json')
    if (!WINDOWS) expect((await stat(envJson)).mode & 0o777).toBe(0o600)
    const vars = JSON.parse(await readFile(envJson, 'utf8')) as Record<string, string>
    expect(vars).toMatchObject({ PITWALL_SESSION_ID: s.id, GIT_AUTHOR_EMAIL: expect.any(String), PITWALL_GH_ACCOUNT: expect.any(String) })
    expect(JSON.stringify(vars)).not.toContain('token-for')
    expect(await readFile(envFile, 'utf8')).toContain(`export PITWALL_SESSION_ID='${s.id}'`)
    const steps = ['identity', 'worktree', 'files', 'tmux', 'claude']
    expect(progress.map((p) => `${p.step}:${p.state}`)).toEqual(steps.flatMap((x) => [`${x}:running`, `${x}:done`]))
    expect(progress.at(-1)?.message).toBe('Started — answer any prompt in the terminal')
    expect(res).toEqual({ ok: true, sessionId: s.id })
    expect(r.root).toBeTruthy()
  })

  test('createdBy is stored; initialPrompt and the agent note are written for the launcher', async () => {
    const { sp } = await addRepo()
    const res = await start(input(sp, { createdBy: 's_parent', initialPrompt: 'Add a README line' }))
    expect(res.ok).toBe(true)
    const s = store.state.sessions[0]
    expect(s.createdBy).toBe('s_parent')
    const d = sessionDir(t.paths, s.id)
    expect(await readFile(join(d, 'initial-prompt.txt'), 'utf8')).toBe('Add a README line')
    if (!WINDOWS) expect((await stat(join(d, 'initial-prompt.txt'))).mode & 0o777).toBe(0o600) // (no POSIX modes on Windows)
    if (WINDOWS) expect(await has(join(d, 'system-note.txt'))).toBe(false) // no agent note on Windows
    else {
      const note = await readFile(join(d, 'system-note.txt'), 'utf8')
      expect(note).toContain('You are running inside Pitwall')
      expect(note).toContain('`pitwall new "<title>" --prompt "<task>"`')
      expect(note).toBe(AGENT_NOTE + '\n')
    }
    expect(AGENT_NOTE.endsWith(' Run `pitwall --help` for details. `pitwall wait` blocks until the session finishes; give it a `--timeout` shorter than your command timeout and run it again if it times out (exit 124).')).toBe(true)
    expect(await has(join(d, 'continue-note.txt'))).toBe(false)
  })

  describe('the Claude account of a new session', () => {
    const acct = () => ({ id: 'a1', dir: join(t.tmp, 'claude-accounts', 'a1'), addedAt: 1 })
    const envSh = (id: string) => readFile(join(sessionDir(t.paths, id), 'env.sh'), 'utf8')

    test('the default account: no account on the session, no CLAUDE_CONFIG_DIR in its environment', async () => {
      const { sp } = await addRepo()
      await start(input(sp))
      const s = store.state.sessions[0]
      expect('account' in s).toBe(false)
      expect(await envSh(s.id)).not.toContain('CLAUDE_CONFIG_DIR')
      expect(await envSh(s.id)).not.toContain('PITWALL_CLAUDE_ACCOUNT')
    })

    test('the active account, with its folder in the environment', async () => {
      const { sp } = await addRepo()
      await store.update((d) => { d.settings.claudeAccounts = [acct()]; d.settings.activeAccount = 'a1' })
      await start(input(sp))
      const s = store.state.sessions[0]
      expect(s.account).toBe('a1')
      expect(await envSh(s.id)).toContain(`export CLAUDE_CONFIG_DIR='${acct().dir}'`)
      expect(await envSh(s.id)).toContain("export PITWALL_CLAUDE_ACCOUNT='1'")
    })

    test("a helper takes its parent's account, not the active one", async () => {
      const { sp } = await addRepo()
      await store.update((d) => { d.settings.claudeAccounts = [acct()]; d.settings.activeAccount = 'a1' })
      await start(input(sp, { title: 'Parent' }))
      const parent = store.state.sessions[0]
      await store.update((d) => { delete d.settings.activeAccount })
      await start(input(sp, { title: 'Helper', createdBy: parent.id }))
      expect(store.state.sessions[1].account).toBe('a1')
      // And the other way round: a parent on the default account, while another is active.
      await store.update((d) => { delete d.sessions[0].account; d.settings.activeAccount = 'a1' })
      await start(input(sp, { title: 'Helper two', createdBy: parent.id }))
      expect('account' in store.state.sessions[2]).toBe(false)
    })

    test("a project that sets its own CLAUDE_CONFIG_DIR keeps it; the session records no account", async () => {
      const { sp } = await addRepo()
      await store.update((d) => {
        d.settings.claudeAccounts = [acct()]; d.settings.activeAccount = 'a1'
        d.projects[0].extraEnv = [{ key: 'CLAUDE_CONFIG_DIR', value: join(t.tmp, 'pinned') }]
      })
      await start(input(sp))
      const s = store.state.sessions[0]
      expect('account' in s).toBe(false)
      expect(await envSh(s.id)).toContain(`export CLAUDE_CONFIG_DIR='${join(t.tmp, 'pinned')}'`)
      expect(await envSh(s.id)).not.toContain('PITWALL_CLAUDE_ACCOUNT')
    })
  })

  test('no first prompt and no createdBy: neither file nor field', async () => {
    const { sp } = await addRepo()
    await start(input(sp))
    expect(store.state.sessions[0].createdBy).toBeUndefined()
    expect(await has(join(sessionDir(t.paths, store.state.sessions[0].id), 'initial-prompt.txt'))).toBe(false)
  })

  test('agentCli off: no system-note.txt for a fresh session, and a stale one is removed', async () => {
    const { sp } = await addRepo()
    await start(input(sp))
    const s = store.state.sessions[0]
    const f = join(sessionDir(t.paths, s.id), 'system-note.txt')
    expect(await has(f)).toBe(!WINDOWS) // (Windows never writes the agent note)
    await store.update((d) => { d.settings.agentCli = false })
    await writeSessionFiles(s, deps)
    expect(await has(f)).toBe(false)
  })

  test('a continued session: continue note, a blank line, then the agent note; continue-note.txt stays the marker', async () => {
    const { sp } = await addRepo()
    await start(input(sp, { continueClaudeId: '00000001-0000-4000-8000-00000000000a', continuedFrom: '/x/repo' }))
    const d = sessionDir(t.paths, store.state.sessions[0].id)
    const cont = await readFile(join(d, 'continue-note.txt'), 'utf8')
    const note = await readFile(join(d, 'system-note.txt'), 'utf8')
    if (WINDOWS) expect(note).toBe(cont.trimEnd() + '\n') // the continue note alone
    else {
      expect(note.startsWith(cont + '\n')).toBe(true)
      expect(note).toContain('You are running inside Pitwall')
    }
    await store.update((x) => { x.settings.agentCli = false })
    await writeSessionFiles(store.state.sessions[0], deps)
    expect(await readFile(join(d, 'system-note.txt'), 'utf8')).toBe(cont)
  })

  test('Windows gets no agent note and no pitwall command variables', async () => {
    const { sp } = await addRepo()
    deps = { ...deps, platform: 'win32', cliKey: Buffer.alloc(32, 1), cliJs: '/x/cli.js' }
    const s = { id: 's_w', subProjectId: sp.id, title: 'W', slug: 'w', claudeSessionId: 'c', cwd: sp.path, createdAt: 0, lastViewedAt: 0 } as Session
    await mkdir(sessionDir(t.paths, s.id), { recursive: true })
    await writeSessionFiles(s, deps)
    expect(await has(join(sessionDir(t.paths, s.id), 'system-note.txt'))).toBe(false)
    expect(await readFile(join(sessionDir(t.paths, s.id), 'env.json'), 'utf8')).not.toContain('PITWALL_CLI')
  })

  test.skipIf(WINDOWS)('with a CLI key, the session env has the command variables and a token only that session can use', async () => {
    const { sp } = await addRepo()
    const key = Buffer.alloc(32, 7)
    deps = { ...deps, cliKey: key, cliJs: '/app/out/cli/index.js' }
    await start(input(sp))
    const s = store.state.sessions[0]
    const vars = JSON.parse(await readFile(join(sessionDir(t.paths, s.id), 'env.json'), 'utf8')) as Record<string, string>
    expect(vars.PITWALL_CLI_SOCKET).toBe(cliSocketPath(t.paths.dataDir))
    expect(vars.PITWALL_CLI_TOKEN).toBe(cliToken(key, s.id))
    expect(vars.PITWALL_NODE).toBe(process.execPath)
    expect(vars.PITWALL_CLI_JS).toBe('/app/out/cli/index.js')
    expect(vars.PITWALL_CLI_DIR).toBe(t.paths.cliBinDir)
  })

  test('files listed in .worktreeinclude are copied into the new worktree', async () => {
    const { r, sp } = await addRepo()
    await writeFile(join(r.root, '.gitignore'), '.env.local\n')
    await writeFile(join(r.root, '.worktreeinclude'), '.env.local\n')
    await run('git', ['add', '-A'], { cwd: r.root, env: r.env })
    await run('git', ['commit', '-m', 'include'], { cwd: r.root, env: r.env })
    await writeFile(join(r.root, '.env.local'), 'TOKEN=1\n')
    const res = await start(input(sp))
    expect(res.ok).toBe(true)
    expect(await readFile(join(store.state.sessions[0].worktreePath!, '.env.local'), 'utf8')).toBe('TOKEN=1\n')
    expect(progress.find((p) => p.step === 'worktree' && p.state === 'done')?.message).toBe('Copied 1 file listed in .worktreeinclude')
  })

  test('with a port allocator, a new session gets its own block, exported as PITWALL_PORT', async () => {
    const { sp } = await addRepo()
    deps = mkDeps({ ports: new PortAllocator({ isFree: async () => true }) }, deps.env)
    const a = await start(input(sp))
    const b = await start(input(sp, { title: 'Second one' }))
    expect(a.ok && b.ok).toBe(true)
    const [s1, s2] = store.state.sessions
    expect([s1.portBase, s2.portBase]).toEqual([40000, 40010])
    expect(await readFile(join(sessionDir(t.paths, s1.id), 'env.sh'), 'utf8')).toContain("export PITWALL_PORT='40000'")
  })

  test('project with no ssh key and no gh account starts; GH_TOKEN unset', async () => {
    await store.update((d) => { d.projects[0].identity.sshKeyPath = ''; d.projects[0].identity.ghAccount = '' })
    const { sp } = await addRepo()
    const log = join(t.tmp, 'claude-nokey.log')
    t.env.STUB_CLAUDE_LOG = log
    delete t.env.GH_TOKEN
    const res = await start(input(sp))
    expect(res.ok).toBe(true)
    await waitFor(async () => (await readFile(log, 'utf8').catch(() => '')).includes('GH_TOKEN='), 8000, 'claude log')
    expect(await readFile(log, 'utf8')).toMatch(/^GH_TOKEN=$/m)
  })

  test('research folder runs in place', async () => {
    const folder = join(t.tmp, 'research')
    await mkdir(folder)
    const sp: SubProject = { id: 'sp_f', projectId: 'p_1', name: 'R', kind: 'folder', path: folder, createdAt: 0 }
    await store.update((d) => {
      d.subProjects.push(sp)
    })
    deps = mkDeps()
    const res = await start(input(sp))
    expect(res.ok).toBe(true)
    const s = store.state.sessions[0]
    expect(s.cwd).toBe(folder)
    expect(s.branch).toBeUndefined()
    expect(s.worktreePath).toBeUndefined()
    expect(s.branchCreatedByPitwall).toBe(false)
    expect(progress.find((p) => p.step === 'worktree' && p.state === 'done')?.message).toBe('No git — runs in the folder')
  })

  test('missing folder fails the tmux step with a clear message and leaves nothing', async () => {
    const folder = join(t.tmp, 'gone')
    const sp: SubProject = { id: 'sp_g', projectId: 'p_1', name: 'G', kind: 'folder', path: folder, createdAt: 0 }
    await store.update((d) => {
      d.subProjects.push(sp)
    })
    deps = mkDeps()
    const res = await start(input(sp))
    expect(res).toEqual({ ok: false, step: 'tmux', error: `Session folder not found: ${folder}` })
    expect(store.state.sessions).toEqual([])
    expect(await t.backend.listSessions()).toEqual([])
  })

  test('monorepo subfolder starts in matching subfolder', async () => {
    const { sp } = await addRepo({ relPath: 'packages/api' })
    expect((await start(input(sp))).ok).toBe(true)
    const s = store.state.sessions[0]
    expect(s.cwd).toBe(join(s.worktreePath!, 'packages/api'))
    expect(await has(s.cwd)).toBe(true)
  })

  test('missing ssh key fails identity and leaves nothing', async () => {
    const { r, sp } = await addRepo()
    await store.update((d) => {
      d.projects[0].identity.sshKeyPath = join(t.paths.sshDir, 'nope')
    })
    const res = await start(input(sp))
    expect(res).toEqual({ ok: false, step: 'identity', error: `SSH key not found: ${join(t.paths.sshDir, 'nope')}` })
    expect(store.state.sessions).toEqual([])
    expect(await has(t.paths.worktreesRoot)).toBe(false)
    expect(await branchesOf(r.root, r.env)).toEqual(['main'])
    expect(progress.at(-1)).toMatchObject({ step: 'identity', state: 'failed' })
  })

  test('unknown gh account fails identity', async () => {
    const { sp } = await addRepo()
    await store.update((d) => {
      d.projects[0].identity.ghAccount = 'nobody'
    })
    const res = await start(input(sp))
    expect(res).toEqual({
      ok: false, step: 'identity', error: "Couldn't get a GitHub token for nobody. Check `gh auth status`."
    })
  })

  test('tmux failure rolls back', async () => {
    const { r, sp } = await addRepo()
    const broken = {
      newSession: async () => {
        throw new Error('boom')
      },
      killSession: t.backend.killSession.bind(t.backend)
    } as unknown as SessionBackend
    deps = { ...deps, backend: broken }
    const res = await start(input(sp))
    expect(res).toEqual({ ok: false, step: 'tmux', error: 'boom' })
    expect(store.state.sessions).toEqual([])
    expect(await branchesOf(r.root, r.env)).toEqual(['main'])
    expect(await has(join(t.paths.worktreesRoot, 'my-repo', 'fix-tax-rounding'))).toBe(false)
    expect(await readdir(t.paths.sessionsDir).catch(() => [])).toEqual([])
    expect((await run('git', ['worktree', 'list'], { cwd: r.root, env: r.env })).stdout.trim().split('\n')).toHaveLength(1)
  })

  test('repo without commits', async () => {
    const { sp } = await addRepo({ commits: false })
    const res = await start(input(sp))
    expect(res).toEqual({
      ok: false, step: 'worktree', error: 'This repo has no commits yet. Make a first commit, then start a session.'
    })
  })

  test('existing branch checked out elsewhere', async () => {
    const { sp } = await addRepo()
    const res = await start(input(sp, { branchMode: 'existing', branch: 'main' }))
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.step).toBe('worktree')
      expect(res.error.startsWith('Branch main is already checked out in')).toBe(true)
    }
  })

  test('existing branch mode does not mark branch as created', async () => {
    const { r, sp } = await addRepo()
    await run('git', ['branch', 'feature/x'], { cwd: r.root, env: r.env })
    const res = await start(input(sp, { branchMode: 'existing', branch: 'feature/x' }))
    expect(res.ok).toBe(true)
    const s = store.state.sessions[0]
    expect(s.branch).toBe('feature/x')
    expect(s.branchCreatedByPitwall).toBe(false)
    expect(s.baseBranch).toBe('main')
    expect(s.baseCommit).toBe((await run('git', ['rev-parse', 'main'], { cwd: r.root, env: r.env })).stdout.trim())
  })


  test("new sessions start from the repo's main branch, not whatever the repo folder has checked out", async () => {
    const { r, sp } = await addRepo()
    await run('git', ['checkout', '-b', 'feature/wip'], { cwd: r.root, env: r.env })
    await writeFile(join(r.root, 'wip.txt'), 'x')
    await run('git', ['add', '-A'], { cwd: r.root, env: r.env })
    await run('git', ['commit', '-m', 'wip'], { cwd: r.root, env: r.env })
    const d = await prepareNewSession(sp.id, deps)
    expect(d.baseBranch).toBe('main')
    expect(d.defaultBranch).toBe('main')
    const res = await start(input(sp))
    expect(res.ok).toBe(true)
    const s = store.state.sessions[0]
    expect(s.baseBranch).toBe('main')
    expect(s.baseCommit).toBe((await run('git', ['rev-parse', 'main'], { cwd: r.root, env: r.env })).stdout.trim())
  })

  test('existing branch mode refuses the main branch (it would stay locked to the session)', async () => {
    const { r, sp } = await addRepo()
    await run('git', ['checkout', '-b', 'feature/wip'], { cwd: r.root, env: r.env })
    const res = await start(input(sp, { branchMode: 'existing', branch: 'main' }))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/main branch/)
    expect(store.state.sessions).toHaveLength(0)
  })

  test('same title twice at once', async () => {
    const { sp } = await addRepo()
    const [a, b] = await Promise.all([start(input(sp, { title: 'x' })), start(input(sp, { title: 'x', requestId: 'r2' }))])
    expect(a.ok && b.ok).toBe(true)
    const ss = store.state.sessions
    expect(ss.map((s) => s.branch).sort()).toEqual(['pitwall/x', 'pitwall/x-2'])
    expect(new Set(ss.map((s) => s.worktreePath)).size).toBe(2)
  })

  test('special characters', async () => {
    const { sp } = await addRepo({ dirName: "My Repo 'x'" })
    const log = join(t.tmp, 'claude.log')
    t.env.STUB_CLAUDE_LOG = log
    const title = "Fix 'tax' $ rounding 🧾"
    const res = await start(input(sp, { title }))
    expect(res.ok).toBe(true)
    expect(store.state.sessions[0].branch).toBe('pitwall/fix-tax-rounding')
    await waitFor(async () => (await readFile(log, 'utf8').catch(() => '')).includes(`--name ${title}`), 8000, 'claude argv')
  })

  test('detached HEAD repo with no main branch starts from the current commit', async () => {
    const { r, sp } = await addRepo()
    await run('git', ['checkout', '--detach'], { cwd: r.root, env: r.env })
    await run('git', ['branch', '-D', 'main'], { cwd: r.root, env: r.env })
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: r.root, env: r.env })).stdout.trim()
    const res = await start(input(sp))
    expect(res.ok).toBe(true)
    const s = store.state.sessions[0]
    expect(s.baseCommit).toBe(head)
    expect(s.baseBranch).toBeUndefined()
  })

  test('silent claude (e.g. a trust prompt): start returns right after tmux, without waiting', async () => {
    const { sp } = await addRepo()
    t.env.STUB_CLAUDE_SILENT = '1'
    const t0 = Date.now()
    const res = await start(input(sp))
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(res).toEqual({ ok: true, sessionId: store.state.sessions[0].id })
    expect(progress.at(-1)).toEqual({
      requestId: 'r1', step: 'claude', state: 'done', message: 'Started — answer any prompt in the terminal'
    })
  })
})

describe('writeSessionFiles', () => {
  async function folderSession(): Promise<Session> {
    const folder = join(t.tmp, 'research')
    await mkdir(join(folder, '.claude'), { recursive: true })
    const sp: SubProject = { id: 'sp_f', projectId: 'p_1', name: 'R', kind: 'folder', path: folder, createdAt: 0 }
    await store.update((d) => { d.subProjects.push(sp) })
    delete t.env.CLAUDE_CONFIG_DIR
    deps = mkDeps()
    return {
      id: 's_files', subProjectId: 'sp_f', title: 'T', slug: 't', claudeSessionId: 'c-1', cwd: folder,
      branchCreatedByPitwall: false, createdAt: 0, lastViewedAt: 0
    }
  }
  const envSh = (s: Session) => readFile(join(sessionDir(t.paths, s.id), 'env.sh'), 'utf8')

  // macOS's sh hooks (the platform's own; Windows' are below).
  test.skipIf(WINDOWS)('hooks.json runs pitwall-statusline with the session folder', async () => {
    const s = await folderSession()
    await writeSessionFiles(s, deps)
    const settings = JSON.parse(await readFile(join(sessionDir(t.paths, s.id), 'hooks.json'), 'utf8'))
    const bin = join(t.paths.binDir, 'pitwall-statusline')
    expect(settings.statusLine).toEqual({ type: 'command', command: `'${bin}' '${sessionDir(t.paths, s.id)}'`, padding: 0 })
    expect(settings.hooks.Stop[0].hooks[0].command).toContain('pitwall-hook')
    expect(await envSh(s)).not.toContain('PITWALL_USER_STATUSLINE')
  })

  test('Windows: hooks in exec form (PowerShell by its full path, forward slashes), the status line for Git Bash and PowerShell', async () => {
    const s = await folderSession()
    deps = mkDeps({ platform: 'win32', env: { ...t.env, SystemRoot: 'C:\\WINDOWS' } })
    await writeSessionFiles(s, deps)
    const dir = sessionDir(t.paths, s.id)
    const settings = JSON.parse(await readFile(join(dir, 'hooks.json'), 'utf8'))
    for (const e of Object.keys(settings.hooks)) {
      expect(settings.hooks[e]).toEqual([{ hooks: [{
        type: 'command',
        command: 'C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', forwardSlashes(join(t.paths.binDir, 'pitwall-hook.ps1')),
          forwardSlashes(join(dir, 'events.jsonl')), s.id],
        timeout: 30
      }] }])
    }
    expect(settings.statusLine).toEqual({
      type: 'command',
      command: `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '${forwardSlashes(join(t.paths.binDir, 'pitwall-statusline.ps1'))}' '${forwardSlashes(dir)}'`,
      padding: 0
    })
    const vars = JSON.parse(await readFile(join(dir, 'env.json'), 'utf8'))
    expect(vars.PITWALL_GIT_BASH).toBeUndefined() // no user status line to chain
    // A user status line is chained in Git Bash when Claude Code would find one (any program there stands in for it).
    const bash = WINDOWS ? process.execPath : '/bin/sh'
    await writeFile(join(s.cwd, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: '~/sl.sh' } }))
    deps = mkDeps({ platform: 'win32', env: { ...t.env, CLAUDE_CODE_GIT_BASH_PATH: bash } })
    await writeSessionFiles(s, deps)
    expect(JSON.parse(await readFile(join(dir, 'env.json'), 'utf8'))).toMatchObject({
      PITWALL_USER_STATUSLINE: '~/sl.sh', PITWALL_GIT_BASH: bash
    })
  })

  test("the user's own status line (project settings, else the project's CLAUDE_CONFIG_DIR) is chained via env.sh", async () => {
    const s = await folderSession()
    const userConfig = join(t.tmp, '.claude-work')
    await mkdir(userConfig)
    await writeFile(join(userConfig, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: "echo 'mine'" } }))
    await store.update((d) => { d.projects[0].extraEnv = [{ key: 'CLAUDE_CONFIG_DIR', value: '~/.claude-work' }] })
    await writeSessionFiles(s, deps)
    expect(await envSh(s)).toContain(`export PITWALL_USER_STATUSLINE='echo '"'"'mine'"'"''`)

    await writeFile(join(s.cwd, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'project-line' } }))
    await writeSessionFiles(s, deps)
    expect(await envSh(s)).toContain(`export PITWALL_USER_STATUSLINE='project-line'`)
  })

  test('without a project CLAUDE_CONFIG_DIR, ~/.claude/settings.json is read (never written)', async () => {
    const s = await folderSession()
    await mkdir(join(t.tmp, '.claude'))
    const file = join(t.tmp, '.claude', 'settings.json')
    const content = JSON.stringify({ statusLine: { type: 'command', command: 'home-line' } })
    await writeFile(file, content)
    const before = await stat(file)
    await writeSessionFiles(s, deps)
    expect(await envSh(s)).toContain(`export PITWALL_USER_STATUSLINE='home-line'`)
    expect(await readFile(file, 'utf8')).toBe(content)
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs)
  })
})
