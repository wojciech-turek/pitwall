import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { claudeProjectDirName } from '../../src/main/conversations'
import { exec } from '../../src/main/exec'
import { GitClient } from '../../src/main/git'
import { sessionDir } from '../../src/main/paths'
import { archiveSession, type ArchiveDeps } from '../../src/main/sessions/archive'
import { SessionManager } from '../../src/main/sessions/manager'
import { KeyedMutex } from '../../src/main/sessions/mutex'
import { Store } from '../../src/main/store'
import { claudeTmuxName } from '../../src/main/tmux'
import type { Project, Session, StartProgress, StartResult, SubProject } from '../../src/shared/types'
import { makeTestEnv } from '../helpers/env'
import { makeRepo } from '../helpers/repo'
import { waitFor } from '../helpers/wait'

const run = promisify(execFile)
const has = (p: string) => access(p).then(() => true, () => false)

const UPDATE = 'Continuing a conversation from outside Pitwall needs Claude Code 2.1.257 or newer. Update Claude Code (claude update), then try again.'
const IN_PITWALL = 'This conversation is already in Pitwall.'
const gone = (folder: string) => `Pitwall couldn't find that conversation in ${folder} any more.`
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0)
const MIN = 60_000

let t: Awaited<ReturnType<typeof makeTestEnv>>
let repos: Awaited<ReturnType<typeof makeRepo>>[] = []
let store: Store
let manager: SessionManager
let deps: ArchiveDeps
let claudeLog: string
/** The Claude config dir the app and its sessions see (never the user's). */
let cfg: string

const project: Project = {
  id: 'p_1', name: 'P', createdAt: 0, extraEnv: [],
  identity: { sshKeyPath: '', ghAccount: 'dev-work', gitName: 'Jane', gitEmail: 'm@x.io' }
}

beforeEach(async () => {
  t = await makeTestEnv()
  repos = []
  claudeLog = join(t.tmp, 'claude.log')
  t.env.STUB_CLAUDE_LOG = claudeLog
  cfg = join(t.tmp, 'claude-config')
  t.env.CLAUDE_CONFIG_DIR = cfg
  delete t.env.STUB_CLAUDE_VERSION
  store = await Store.open(t.paths.stateFile)
  await store.update((d) => {
    d.projects.push(structuredClone(project))
  })
})
afterEach(async () => {
  manager?.dispose()
  for (const r of repos) await r.cleanup()
  await t.cleanup()
})

function setup(gitEnv: Record<string, string>): void {
  const git = new GitClient(exec, gitEnv)
  manager?.dispose()
  const base = { store, paths: t.paths, git, backend: t.backend, exec, env: t.env, home: t.tmp, mutex: new KeyedMutex() }
  manager = new SessionManager({ ...base, now: () => NOW, firstEventTimeoutMs: 8000, notifier: { notify: () => {}, setBadge: () => {} } })
  deps = { ...base, manager, ptyBridge: { close: () => {}, detach: () => {} } as unknown as ArchiveDeps['ptyBridge'] }
}

async function addRepo() {
  const r = await makeRepo({ dirName: 'tax-service' })
  repos.push(r)
  const sp: SubProject = {
    id: 'sp_1', projectId: 'p_1', name: 'tax-service', kind: 'repo', path: r.root, repoRoot: r.root, relPath: '', createdAt: 0
  }
  await store.update((d) => {
    d.subProjects.push(sp)
  })
  setup(r.env)
  return { r, sp }
}

async function addFolder(name = 'notes') {
  const folder = join(t.tmp, name)
  await mkdir(folder, { recursive: true })
  const sp: SubProject = { id: `sp_${name}`, projectId: 'p_1', name, kind: 'folder', path: folder, createdAt: 0 }
  await store.update((d) => {
    d.subProjects.push(sp)
  })
  setup(t.env)
  return { folder, sp }
}

// ---- transcripts, as Claude writes them -------------------------------------------------------

let counter = 0
const newId = () => `${String(++counter).padStart(8, '0')}-0000-4000-8000-00000000000c`
const at = (cwd: string, gitBranch: string) =>
  ({ cwd, gitBranch, isSidechain: false, sessionId: 's', timestamp: '2026-10-01T10:00:00.000Z', userType: 'external' })
const user = (text: string, extra: object) => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, ...extra })
const assistant = (text: string, extra: object) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra })
const aiTitle = (title: string) => JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: 's' })

/** A conversation run with plain `claude` in `cwd`, kept where Claude keeps it; its mtime `ago` ms before NOW. */
async function convo(o: {
  cwd: string; text?: string; reply?: string; title?: string; branch?: string; ago?: number; configDir?: string; id?: string
}): Promise<{ id: string; path: string }> {
  const id = o.id ?? newId()
  const dir = join(o.configDir ?? cfg, 'projects', claudeProjectDirName(o.cwd))
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${id}.jsonl`)
  const where = at(o.cwd, o.branch ?? 'main')
  const lines = [user(o.text ?? 'Fix the tax rounding', where), assistant(o.reply ?? 'On it.', where)]
  if (o.title) lines.push(aiTitle(o.title))
  await writeFile(path, lines.map((l) => l + '\n').join(''))
  const mtime = new Date(NOW - (o.ago ?? 60 * MIN))
  await utimes(path, mtime, mtime)
  return { id, path }
}

// ---- helpers ----------------------------------------------------------------------------------

const get = (id: string): Session => store.state.sessions.find((s) => s.id === id)!
const logText = () => readFile(claudeLog, 'utf8').catch(() => '')
/** The argument lines the stub logged (each launch's argv). */
const launches = async () => (await logText()).split('\n').filter((l) => l.startsWith('--'))
const notes = async () => (await logText()).split('\n').filter((l) => l.startsWith('NOTE='))
const sha = async (p: string) => createHash('sha256').update(await readFile(p)).digest('hex')
const git = (r: { env: Record<string, string> }, cwd: string, ...args: string[]) => run('git', args, { cwd, env: r.env })

async function continueOne(sp: SubProject, claudeId: string, progress: StartProgress[] = []): Promise<StartResult> {
  return manager.continueConversation(sp.id, claudeId, 'rq', (p) => progress.push(p))
}
async function continued(sp: SubProject, claudeId: string): Promise<Session> {
  const res = await continueOne(sp, claudeId)
  if (!res.ok) throw new Error(res.error)
  const s = get(res.sessionId)
  await waitFor(async () => (await launches()).some((l) => l.startsWith(`--resume ${claudeId}`)), 8000, 'claude resumed')
  return s
}
async function startNormal(sp: SubProject, title = 'A normal one'): Promise<Session> {
  const res = await manager.start({ requestId: 'r', subProjectId: sp.id, title, branchMode: 'new', branch: '' }, () => {})
  if (!res.ok) throw new Error(res.error)
  const s = get(res.sessionId)
  await waitFor(async () => (await logText()).includes(`--session-id ${s.claudeSessionId}`), 8000, 'claude started')
  return s
}
async function archive(s: Session): Promise<void> {
  expect(await archiveSession(s.id, { confirmedDataLoss: true }, deps)).toMatchObject({ ok: true })
}
/** Every file under a folder, with its size and mtime. */
async function tree(root: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(root, { recursive: true, withFileTypes: true })) {
    const p = join(e.parentPath, e.name)
    const st = await stat(p)
    out.push(`${p} ${st.isFile() ? st.size : 'dir'} ${st.mtimeMs}`)
  }
  return out.sort()
}
const repoNote = (from: string, s: Session) =>
  `This conversation began in ${from}. It now continues in a separate git worktree at ${s.cwd}, on branch ${s.branch}. ` +
  `Work only in ${s.cwd}: don't read from or change files under ${from}.\n`

describe('continuing a conversation run outside Pitwall', () => {
  test("continuing an outside conversation starts a session that resumes it: claude-id is the conversation's id, the launcher runs --resume <id>, the title is the conversation's", async () => {
    const { r, sp } = await addRepo()
    const long = 'Make the tax service round every line item half-up instead of half-even, and update the invoice tests to match it'
    const c = await convo({ cwd: r.root, text: long })
    const progress: StartProgress[] = []
    const res = await continueOne(sp, c.id, progress)
    if (!res.ok) throw new Error(res.error)
    const s = get(res.sessionId)
    expect(s.claudeSessionId).toBe(c.id)
    expect(s.title).toHaveLength(80)
    expect(s.title).toBe(long.slice(0, 79).trimEnd() + '…')
    expect(s.branch).toMatch(/^pitwall\/make-the-tax-service/)
    expect(s.worktreePath).toBeDefined()
    expect(s.cwd).not.toBe(r.root)
    expect(await readFile(join(sessionDir(t.paths, s.id), 'claude-id'), 'utf8')).toBe(`${c.id}\n`)
    await waitFor(async () => (await launches()).length > 0, 8000, 'claude launched')
    const argv = await launches()
    expect(argv).toHaveLength(1)
    expect(argv[0]).toMatch(new RegExp(`^--resume ${c.id} --settings `))
    expect(manager.snapshot().sessions.map((x) => x.id)).toEqual([s.id])
    expect(progress.filter((p) => p.state === 'done').map((p) => p.step)).toEqual(['identity', 'worktree', 'files', 'tmux', 'claude'])
    // It's a Pitwall session now: no longer offered (nor found) as one run outside Pitwall.
    expect(await manager.searchConversations(sp.id, 'tax service')).toEqual([])
    expect(await manager.listConversations(sp.id)).toEqual({ items: [], truncated: false })
  })

  test("the new branch starts from the conversation's branch when it exists (even checked out in the main folder), else from main", async () => {
    const { r, sp } = await addRepo()
    await git(r, r.root, 'checkout', '-b', 'feature/rounding')
    await writeFile(join(r.root, 'rounding.ts'), 'export const mode = "half-up"\n')
    await git(r, r.root, 'add', '-A')
    await git(r, r.root, 'commit', '-m', 'rounding')
    const tip = (await git(r, r.root, 'rev-parse', 'HEAD')).stdout.trim()
    const main = (await git(r, r.root, 'rev-parse', 'main')).stdout.trim()
    const onFeature = await convo({ cwd: r.root, branch: 'feature/rounding', text: 'Round half up' })
    const onGone = await convo({ cwd: r.root, branch: 'feature/deleted', text: 'Old idea' })

    const a = await continued(sp, onFeature.id)
    expect(a.baseBranch).toBe('feature/rounding')
    expect(a.baseCommit).toBe(tip)
    expect(a.branch).toBe('pitwall/round-half-up')
    expect((await git(r, a.cwd, 'rev-parse', 'HEAD')).stdout.trim()).toBe(tip)
    // The main folder stays as it was: on its branch, nothing changed.
    expect((await git(r, r.root, 'branch', '--show-current')).stdout.trim()).toBe('feature/rounding')
    expect((await git(r, r.root, 'rev-parse', 'HEAD')).stdout.trim()).toBe(tip)
    expect((await git(r, r.root, 'status', '--porcelain')).stdout).toBe('')

    const b = await continued(sp, onGone.id)
    expect(b.baseBranch).toBe('main')
    expect(b.baseCommit).toBe(main)
    expect((await git(r, b.cwd, 'rev-parse', 'HEAD')).stdout.trim()).toBe(main)
  })

  test("refuses an id that isn't one of the folder's outside conversations, or that a session already has", async () => {
    const { r, sp } = await addRepo()
    const sibling = join(r.root + '-old')
    await mkdir(sibling, { recursive: true })
    const elsewhere = await convo({ cwd: sibling })
    const normal = await startNormal(sp)
    // The running session's own conversation, kept under the main folder as if it had been run there.
    const running = await convo({ cwd: r.root, id: normal.claudeSessionId })
    const old = await convo({ cwd: r.root })
    const archived: Session = {
      id: 's_old', subProjectId: sp.id, title: 'Old', slug: 'old', claudeSessionId: newId(), cwd: r.root,
      branchCreatedByPitwall: false, createdAt: 1, lastViewedAt: 1, archivedAt: 2, pastClaudeIds: [old.id]
    }
    await store.update((d) => {
      d.sessions.push(archived)
    })
    const before = store.state.sessions.length
    const logBefore = await logText()

    const fail = (error: string) => ({ ok: false, step: 'identity', error })
    expect(await continueOne(sp, 'not-a-conversation')).toEqual(fail(gone('tax-service')))
    expect(await continueOne(sp, newId())).toEqual(fail(gone('tax-service')))
    expect(await continueOne(sp, elsewhere.id)).toEqual(fail(gone('tax-service')))
    expect(await continueOne(sp, running.id)).toEqual(fail(IN_PITWALL))
    expect(await continueOne(sp, old.id)).toEqual(fail(IN_PITWALL))
    expect(await continueOne(sp, archived.claudeSessionId)).toEqual(fail(IN_PITWALL))
    expect(await manager.continueConversation('sp_nope', old.id, 'rq', () => {})).toMatchObject({ ok: false })
    // Nothing started.
    expect(store.state.sessions).toHaveLength(before)
    expect(await logText()).toBe(logBefore)
    expect((await readdir(t.paths.sessionsDir)).sort()).toEqual([normal.id])
  })

  test("uses the project's own CLAUDE_CONFIG_DIR when it has one", async () => {
    const own = join(t.tmp, 'work claude')
    await store.update((d) => {
      d.projects[0].extraEnv = [{ key: 'CLAUDE_CONFIG_DIR', value: own }]
    })
    const { r, sp } = await addRepo()
    const inDefault = await convo({ cwd: r.root, title: 'In the app-wide dir' })
    const inOwn = await convo({ cwd: r.root, title: "In the project's dir", configDir: own })
    expect((await manager.listConversations(sp.id)).items.map((i) => i.id)).toEqual([inOwn.id])
    expect(await continueOne(sp, inDefault.id)).toEqual({ ok: false, step: 'identity', error: gone('tax-service') })
    const s = await continued(sp, inOwn.id)
    expect(s.title).toBe("In the project's dir")
  })

  test('listConversations merges archived sessions and outside conversations, newest first, without open sessions', async () => {
    const { r, sp } = await addRepo()
    const sub = join(r.root, 'packages', 'api')
    await mkdir(sub, { recursive: true })
    const recent = await convo({ cwd: r.root, title: 'Recent', branch: 'feature/x', ago: 2 * MIN })
    const older = await convo({ cwd: sub, title: 'In a subfolder', ago: 90 * MIN })
    const detached = await convo({ cwd: r.root, title: 'Detached', branch: 'HEAD', ago: 6 * MIN })
    const open = await startNormal(sp, 'Open now')
    await convo({ cwd: r.root, id: open.claudeSessionId, ago: 1 * MIN }) // the open session's: not listed
    const past = await convo({ cwd: r.root, ago: 3 * MIN }) // an archived session's earlier conversation: not listed
    const archived = (id: string, archivedAt: number | undefined, o: Partial<Session> = {}): Session => ({
      id, subProjectId: sp.id, title: `Archived ${id}`, slug: id, claudeSessionId: newId(), cwd: r.root, branch: 'pitwall/x',
      branchCreatedByPitwall: true, createdAt: NOW - 200 * MIN, lastViewedAt: 0, archivedAt, ...o
    })
    await store.update((d) => {
      d.sessions.push(
        archived('s_a', NOW - 30 * MIN, { pastClaudeIds: [past.id] }),
        archived('s_b', NOW - 120 * MIN, { branch: undefined }),
        { ...archived('s_other', NOW - 10 * MIN), subProjectId: 'sp_elsewhere' }
      )
    })
    const list = await manager.listConversations(sp.id)
    expect(list).toEqual({
      truncated: false,
      items: [
        { kind: 'outside', id: recent.id, title: 'Recent', updatedAt: NOW - 2 * MIN, branch: 'feature/x', recentlyActive: true },
        { kind: 'outside', id: detached.id, title: 'Detached', updatedAt: NOW - 6 * MIN, recentlyActive: false },
        { kind: 'archived', id: 's_a', title: 'Archived s_a', updatedAt: NOW - 30 * MIN, branch: 'pitwall/x' },
        { kind: 'outside', id: older.id, title: 'In a subfolder', updatedAt: NOW - 90 * MIN, branch: 'main', recentlyActive: false },
        { kind: 'archived', id: 's_b', title: 'Archived s_b', updatedAt: NOW - 120 * MIN }
      ]
    })
    await expect(manager.listConversations('sp_nope')).rejects.toThrow('Sub-project not found.')
  })

  test('searchConversations finds an outside conversation by a word only in its text', async () => {
    const { r, sp } = await addRepo()
    const zebraText = await convo({ cwd: r.root, title: 'Invoice totals', text: 'Why does the zebra fixture fail?', ago: 5 * MIN })
    const zebraTitle = await convo({ cwd: r.root, title: 'Zebra stripes', ago: 50 * MIN })
    await convo({ cwd: r.root, title: 'Unrelated', text: 'Nothing to see', ago: 1 * MIN })
    const sibling = r.root + '-old'
    await mkdir(sibling, { recursive: true })
    await convo({ cwd: sibling, title: 'Zebra elsewhere', ago: 1 * MIN })
    await store.update((d) => {
      d.sessions.push({
        id: 's_z', subProjectId: sp.id, title: 'Zebra crossing', slug: 'z', claudeSessionId: newId(), cwd: r.root,
        branchCreatedByPitwall: false, createdAt: 0, lastViewedAt: 0, archivedAt: NOW - 20 * MIN
      })
    })
    const hits = await manager.searchConversations(sp.id, 'zebra')
    expect(hits.map((h) => [h.kind, h.id, h.matchedIn])).toEqual([
      ['archived', 's_z', 'title'],
      ['outside', zebraTitle.id, 'title'],
      ['outside', zebraText.id, 'conversation']
    ])
    expect(hits[2].snippet).toContain('zebra fixture')
    expect(await manager.searchConversations(sp.id, 'fixture invoice')).toMatchObject([{ id: zebraText.id, matchedIn: 'conversation' }])
    expect(await manager.searchConversations(sp.id, '')).toEqual([])
  })

  test("the user's transcript is byte-identical afterwards", async () => {
    const { r, sp } = await addRepo()
    const c = await convo({ cwd: r.root, title: 'Keep me as I am' })
    const hash = await sha(c.path)
    const files = await tree(cfg)
    await manager.listConversations(sp.id)
    await manager.searchConversations(sp.id, 'rounding')
    const s = await continued(sp, c.id)
    await t.backend.sendKeys(claudeTmuxName(s.id), ['hello', 'Enter'])
    await waitFor(async () => get(s.id).lastMessage === 'echo: hello', 8000, 'a reply')
    await archive(s)
    expect(await sha(c.path)).toBe(hash)
    expect(await tree(cfg)).toEqual(files)
  })

  test('a continued session launches with --system-prompt-snapshot off and the continue note, on its first and later launches; a normal session never does', async () => {
    const { r, sp } = await addRepo()
    const c = await convo({ cwd: r.root, title: 'Guarded' })
    const s = await continued(sp, c.id)
    const dir = sessionDir(t.paths, s.id)
    const note = join(dir, 'continue-note.txt')
    expect(await readFile(note, 'utf8')).toBe(repoNote(r.root, s))
    const flags = `--system-prompt-snapshot off --append-system-prompt-file ${note}`
    expect((await launches())[0]).toBe(`--resume ${c.id} --settings ${join(dir, 'hooks.json')} ${flags}`)
    // Claude read the note (its path arrived whole, spaces and all).
    await waitFor(async () => (await notes()).length === 1, 8000, 'the note read')
    expect(await notes()).toEqual([`NOTE=${repoNote(r.root, s).trimEnd()}`])

    // Exit, then Enter: the next launch too.
    await t.backend.sendKeys(claudeTmuxName(s.id), ['exit', 'Enter'])
    await waitFor(async () => (await t.backend.capture(claudeTmuxName(s.id))).includes('Press Enter to resume'), 8000, 'prompt')
    await t.backend.sendKeys(claudeTmuxName(s.id), ['Enter'])
    await waitFor(async () => (await launches()).length === 2, 8000, 'relaunch')
    expect((await launches())[1]).toBe(`--resume ${c.id} --settings ${join(dir, 'hooks.json')} ${flags}`)

    // Archived and resumed later: still, with the note rewritten for where it runs now.
    await archive(s)
    const resumed = await manager.resume(s.id, 'rq2', () => {})
    expect(resumed).toEqual({ ok: true, sessionId: s.id })
    await waitFor(async () => (await launches()).length === 3, 8000, 'resumed launch')
    expect((await launches())[2]).toBe(`--resume ${c.id} --settings ${join(dir, 'hooks.json')} ${flags}`)
    expect(await readFile(note, 'utf8')).toBe(repoNote(r.root, get(s.id)))

    // A session started the usual way: never.
    const normal = await startNormal(sp)
    const own = (await launches()).filter((l) => l.includes(normal.claudeSessionId))
    expect(own).toHaveLength(1)
    expect(own[0]).not.toContain('--system-prompt-snapshot')
    expect(own[0]).not.toContain('--append-system-prompt-file')
    expect(await has(join(sessionDir(t.paths, normal.id), 'continue-note.txt'))).toBe(false)
  })

  test('in a folder without git: it runs in the folder, with no branch, and the note says where it continues', async () => {
    const { folder, sp } = await addFolder('my notes')
    const inside = join(folder, 'drafts')
    await mkdir(inside, { recursive: true })
    const c = await convo({ cwd: inside, title: 'Draft the post' })
    const s = await continued(sp, c.id)
    expect(s.cwd).toBe(folder)
    expect(s.branch).toBeUndefined()
    expect(s.worktreePath).toBeUndefined()
    expect(await readFile(join(sessionDir(t.paths, s.id), 'continue-note.txt'), 'utf8')).toBe(
      `This conversation began in ${inside}. It now continues in ${folder}. Work only in ${folder}.\n`
    )
  })

  test('refuses with the update message when claude --version is older than 2.1.257 or unreadable; starts nothing', async () => {
    const { r, sp } = await addRepo()
    const c = await convo({ cwd: r.root })
    for (const v of ['2.1.256 (Claude Code)', '1.9.999 (Claude Code)', 'Claude Code', '']) {
      t.env.STUB_CLAUDE_VERSION = v || ' '
      expect(await continueOne(sp, c.id)).toEqual({ ok: false, step: 'identity', error: UPDATE })
    }
    expect(store.state.sessions).toEqual([])
    expect(await logText()).toBe('')
    expect(await has(t.paths.sessionsDir) ? await readdir(t.paths.sessionsDir) : []).toEqual([])
    // The oldest that has what continuing needs.
    t.env.STUB_CLAUDE_VERSION = '2.1.257 (Claude Code)'
    expect((await continued(sp, c.id)).claudeSessionId).toBe(c.id)
  })
})
