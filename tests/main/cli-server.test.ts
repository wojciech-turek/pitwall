import { createConnection } from 'node:net'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { SessionBackend } from '../../src/main/backend'
import { cliSocketPath, cliToken, loadCliKey } from '../../src/main/cli/auth'
import { CliServer, type CliManager } from '../../src/main/cli/server'
import { exec } from '../../src/main/exec'
import { GitClient } from '../../src/main/git'
import { appendEvent } from '../../src/main/hooks/events'
import { eventsFile, resolvePaths, sessionDir, type AppPaths } from '../../src/main/paths'
import { SessionManager } from '../../src/main/sessions/manager'
import { KeyedMutex } from '../../src/main/sessions/mutex'
import { Store } from '../../src/main/store'
import type { AppSnapshot, DisplayStatus, HookEvent, NewSessionInput, Session, SessionView, StartResult } from '../../src/shared/types'

const KEY = Buffer.alloc(32, 7)

function view(id: string, o: Partial<SessionView> = {}): SessionView {
  return {
    id, subProjectId: 'sp_1', title: `Title ${id}`, slug: id, claudeSessionId: `c-${id}`, cwd: '/w', branchCreatedByPitwall: true,
    createdAt: 0, lastViewedAt: 0, status: 'read', branch: `br-${id}`, worktreePath: `/wt/${id}`, ...o
  } as SessionView
}

class FakeManager implements CliManager {
  sessions: SessionView[] = []
  archived: { id: string; title: string }[] = []
  cbs = new Set<(s: AppSnapshot) => void>()
  started: NewSessionInput[] = []
  startResult: StartResult | null = null
  sent: { id: string; text: string }[] = []
  settings: { agentCli?: boolean } = {}
  replies = new Map<string, string>()
  snapshot(): AppSnapshot {
    return { sessions: this.sessions, archived: this.archived, projects: [], subProjects: [], settings: this.settings } as unknown as AppSnapshot
  }
  async lastReply(id: string): Promise<string | undefined> { return this.replies.get(id) }
  onSnapshot(cb: (s: AppSnapshot) => void): () => void {
    this.cbs.add(cb)
    return () => { this.cbs.delete(cb) }
  }
  emit(): void { for (const cb of [...this.cbs]) cb(this.snapshot()) }
  setStatus(id: string, status: DisplayStatus): void {
    this.sessions = this.sessions.map((s) => (s.id === id ? { ...s, status } : s))
    this.emit()
  }
  async start(input: NewSessionInput): Promise<StartResult> {
    this.started.push(input)
    if (this.startResult) return this.startResult
    this.sessions.push(view('s_new', { title: input.title, subProjectId: input.subProjectId, branch: 'feat-x', worktreePath: '/wt/new' }))
    return { ok: true, sessionId: 's_new' }
  }
  async sendText(id: string, text: string): Promise<void> { this.sent.push({ id, text }) }
}

let dir: string
let mgr: FakeManager
let server: CliServer
let sock: string

async function boot(o: { idleMs?: number } = {}): Promise<void> {
  server = new CliServer({ key: KEY, socketPath: sock, manager: mgr, ...o })
  await server.start()
}

/** Sends raw bytes, then reads the reply line (and checks the server ends the connection). */
function raw(payload: string, o: { end?: boolean } = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const c = createConnection(sock)
    let buf = ''
    c.on('data', (d) => { buf += d.toString() })
    c.on('error', reject)
    c.on('close', () => {
      try { resolve(buf.trim() ? JSON.parse(buf.trim().split('\n')[0]) : null) } catch (e) { reject(e) }
    })
    c.on('connect', () => { if (payload) c.write(payload); if (o.end) c.end() })
  })
}

function call(session: string, cmd: string, args: object = {}, token = cliToken(KEY, session)): Promise<any> {
  return raw(JSON.stringify({ v: 1, session, token, cmd, args }) + '\n')
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pwcli-'))
  sock = join(dir, 'cli.sock')
  mgr = new FakeManager()
  mgr.sessions = [view('me'), view('kid', { createdBy: 'me', status: 'read', lastMessage: 'done it' }), view('other', { subProjectId: 'sp_2' })]
})
afterEach(async () => {
  await server?.stop()
  await rm(dir, { recursive: true, force: true })
})

describe('auth', () => {
  test('cliToken is a stable hex HMAC per session', () => {
    expect(cliToken(KEY, 'a')).toMatch(/^[0-9a-f]{64}$/)
    expect(cliToken(KEY, 'a')).toBe(cliToken(KEY, 'a'))
    expect(cliToken(KEY, 'a')).not.toBe(cliToken(KEY, 'b'))
  })
  test('loadCliKey makes a 0600 key once, reads it back, and replaces a corrupt one', async () => {
    const f = join(dir, 'cli.key')
    const k = await loadCliKey(f)
    expect(k.length).toBe(32)
    if (process.platform !== 'win32') expect((await stat(f)).mode & 0o777).toBe(0o600)
    expect((await loadCliKey(f)).equals(k)).toBe(true)
    await writeFile(f, 'junk')
    const k2 = await loadCliKey(f)
    expect(k2.length).toBe(32)
    expect(k2.equals(k)).toBe(false)
    expect((await loadCliKey(f)).equals(k2)).toBe(true)
  })
  test('cliSocketPath is in the data dir, or a short temp path when that is too long', () => {
    expect(cliSocketPath('/a/b')).toBe('/a/b/cli.sock')
    const long = '/' + 'x'.repeat(120)
    const p = cliSocketPath(long)
    expect(p).toBe(cliSocketPath(long))
    expect(p).not.toContain('xxxx')
    expect(Buffer.byteLength(p)).toBeLessThan(100)
    expect(p).toMatch(/pitwall-[0-9a-f]{12}\.sock$/)
  })
})

describe('server', () => {
  test('a stale socket is replaced, and the new socket is 0600', async () => {
    // A process that listens and dies without closing leaves the socket file behind, like a crash.
    execFileSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(sock)}, () => process.exit(0))`])
    expect((await stat(sock)).isSocket()).toBe(true)
    await boot()
    if (process.platform !== 'win32') expect((await stat(sock)).mode & 0o777).toBe(0o600)
    expect(await call('me', 'list')).toMatchObject({ ok: true })
  })

  test('a regular file in the way survives and start rejects', async () => {
    await writeFile(sock, 'precious')
    server = new CliServer({ key: KEY, socketPath: sock, manager: mgr })
    await expect(server.start()).rejects.toThrow(`Something that isn't a socket is in the way at ${sock}.`)
    expect(await readFile(sock, 'utf8')).toBe('precious')
  })

  test('a symlink in the way is left alone', async () => {
    const target = join(dir, 'target.txt')
    await writeFile(target, 'keep')
    await symlink(target, sock)
    server = new CliServer({ key: KEY, socketPath: sock, manager: mgr })
    await expect(server.start()).rejects.toThrow(/isn't a socket/)
    expect((await stat(target)).isFile()).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('keep')
  })

  test('bad, wrong-length and missing tokens, and unknown or archived callers', async () => {
    await boot()
    const bad = { ok: false, error: 'Not a Pitwall session.' }
    expect(await call('me', 'list', {}, cliToken(KEY, 'someone-else'))).toEqual(bad)
    expect(await call('me', 'list', {}, 'abc')).toEqual(bad)
    expect(await call('me', 'list', {}, '')).toEqual(bad)
    expect(await call('ghost', 'list')).toEqual(bad)
    mgr.sessions = mgr.sessions.filter((s) => s.id !== 'me')
    mgr.archived = [{ id: 'me', title: 'x' }]
    expect(await call('me', 'list')).toEqual(bad)
  })

  test('unknown command, malformed JSON, wrong version', async () => {
    await boot()
    expect(await call('me', 'dance')).toEqual({ ok: false, error: 'Unknown command dance.' })
    expect(await raw('not json\n')).toMatchObject({ ok: false })
    expect(await raw(JSON.stringify({ v: 2, session: 'me', token: cliToken(KEY, 'me'), cmd: 'list', args: {} }) + '\n')).toMatchObject({ ok: false })
  })

  test('list returns the caller\'s folder only', async () => {
    await boot()
    const r = await call('me', 'list')
    expect(r.sessions.map((s: any) => s.id)).toEqual(['me', 'kid'])
    expect(r.sessions[1]).toEqual({ id: 'kid', title: 'Title kid', status: 'read', branch: 'br-kid', createdBy: 'me' })
  })

  test('new forwards the caller\'s folder, createdBy and the prompt, and returns the session', async () => {
    await boot()
    const r = await call('me', 'new', { title: 'Helper', prompt: 'do it', branch: 'b1', base: 'main' })
    expect(r).toEqual({ ok: true, id: 's_new', title: 'Helper', branch: 'feat-x', worktree: '/wt/new' })
    expect(mgr.started[0]).toMatchObject({
      subProjectId: 'sp_1', title: 'Helper', branchMode: 'new', branch: 'b1', baseBranch: 'main', createdBy: 'me', initialPrompt: 'do it'
    })
    expect(typeof mgr.started[0].requestId).toBe('string')
    await call('me', 'new', { title: 'Plain' })
    expect(mgr.started[1]).toMatchObject({ branch: '', baseBranch: undefined, initialPrompt: undefined })
  })

  test('new refuses a bad title and passes a start failure through', async () => {
    await boot()
    for (const title of ['', 5, undefined, 'x'.repeat(201)]) {
      expect(await call('me', 'new', { title })).toMatchObject({ ok: false })
    }
    expect(mgr.started).toHaveLength(0)
    mgr.startResult = { ok: false, step: 'worktree', error: 'no such base' }
    expect(await call('me', 'new', { title: 'T' })).toEqual({ ok: false, error: 'no such base' })
  })

  test('a throwing manager becomes an error reply', async () => {
    await boot()
    mgr.start = async () => { throw new Error('boom') }
    expect(await call('me', 'new', { title: 'T' })).toEqual({ ok: false, error: 'boom' })
    expect(await call('me', 'list')).toMatchObject({ ok: true })
  })

  test('status returns the target, and refuses another project or an unknown id', async () => {
    await boot()
    expect(await call('me', 'status', { id: 'kid' })).toEqual({ ok: true, id: 'kid', title: 'Title kid', status: 'read', lastMessage: 'done it' })
    expect(await call('me', 'status', { id: 'other' })).toEqual({ ok: false, error: "other isn't in this project." })
    expect(await call('me', 'status', { id: 'nope' })).toEqual({ ok: false, error: "nope isn't in this project." })
  })

  test('send pastes into a child that is read or unread, and refuses others', async () => {
    await boot()
    expect(await call('me', 'send', { id: 'kid', text: 'hi' })).toEqual({ ok: true })
    expect(mgr.sent).toEqual([{ id: 'kid', text: 'hi' }])
    mgr.setStatus('kid', 'unread')
    expect(await call('me', 'send', { id: 'kid', text: 'again' })).toEqual({ ok: true })
    mgr.setStatus('kid', 'working')
    expect(await call('me', 'send', { id: 'kid', text: 'x' })).toEqual({ ok: false, error: 'Title kid is busy (working); wait for it first.' })
    expect(await call('me', 'send', { id: 'me', text: 'x' })).toEqual({ ok: false, error: 'You can only send to sessions you started.' })
    expect(await call('me', 'send', { id: 'other', text: 'x' })).toEqual({ ok: false, error: 'You can only send to sessions you started.' })
    mgr.setStatus('kid', 'read')
    expect(await call('me', 'send', { id: 'kid', text: '' })).toMatchObject({ ok: false })
    expect(mgr.sent).toHaveLength(2)
  })

  test('wait answers at once when the target is already done', async () => {
    await boot()
    expect(await call('me', 'wait', { id: 'kid' })).toEqual({ ok: true, status: 'read', lastMessage: 'done it' })
  })

  test('status and wait give the whole reply when there is one; a reply cut at 300 characters says so with "…"', async () => {
    await boot()
    const cut = 'z'.repeat(300)
    mgr.sessions = mgr.sessions.map((s) => (s.id === 'kid' ? { ...s, lastMessage: cut } : s))
    expect((await call('me', 'status', { id: 'kid' })).lastMessage).toBe(cut + '…')
    expect((await call('me', 'wait', { id: 'kid' })).lastMessage).toBe(cut + '…')
    mgr.replies.set('kid', 'z'.repeat(5000))
    expect((await call('me', 'status', { id: 'kid' })).lastMessage).toBe('z'.repeat(5000))
    expect((await call('me', 'wait', { id: 'kid' })).lastMessage).toBe('z'.repeat(5000))
  })

  test("with the command off in Settings, new and send are refused; list, status and wait still answer", async () => {
    await boot()
    mgr.settings = { agentCli: false }
    const off = { ok: false, error: "The pitwall command is off in Pitwall's Settings." }
    expect(await call('me', 'new', { title: 'Helper', prompt: 'do it' })).toEqual(off)
    expect(await call('me', 'send', { id: 'kid', text: 'hi' })).toEqual(off)
    expect(mgr.started).toHaveLength(0)
    expect(mgr.sent).toHaveLength(0)
    expect(await call('me', 'list')).toMatchObject({ ok: true })
    expect(await call('me', 'status', { id: 'kid' })).toMatchObject({ ok: true, status: 'read' })
    expect(await call('me', 'wait', { id: 'kid' })).toMatchObject({ ok: true, status: 'read' })
    mgr.settings = { agentCli: true }
    expect(await call('me', 'send', { id: 'kid', text: 'hi' })).toEqual({ ok: true })
  })

  test('wait resolves when a snapshot shows the target finished, and unsubscribes', async () => {
    await boot()
    mgr.setStatus('kid', 'working')
    const p = call('me', 'wait', { id: 'kid' })
    await new Promise((r) => setTimeout(r, 100))
    expect(mgr.cbs.size).toBe(1)
    mgr.setStatus('kid', 'unread')
    expect(await p).toEqual({ ok: true, status: 'unread', lastMessage: 'done it' })
    expect(mgr.cbs.size).toBe(0)
  })

  test('wait times out with the message, and unsubscribes', async () => {
    await boot()
    mgr.setStatus('kid', 'working')
    const r = await call('me', 'wait', { id: 'kid', timeoutSec: 0.2 })
    expect(r).toEqual({ ok: false, error: 'Title kid is still working' })
    expect(mgr.cbs.size).toBe(0)
    mgr.setStatus('kid', 'starting')
    expect(await call('me', 'wait', { id: 'kid', timeoutSec: 0.1 })).toEqual({
      ok: false, error: 'Title kid is still starting (it may be asking whether to trust the folder; the user can answer in Pitwall)'
    })
  })

  test('wait reports a target archived meanwhile, and refuses another project', async () => {
    await boot()
    mgr.setStatus('kid', 'working')
    const p = call('me', 'wait', { id: 'kid' })
    await new Promise((r) => setTimeout(r, 100))
    mgr.sessions = mgr.sessions.filter((s) => s.id !== 'kid')
    mgr.archived = [{ id: 'kid', title: 'Title kid' }]
    mgr.emit()
    expect(await p).toEqual({ ok: false, error: 'Title kid was archived.' })
    expect(await call('me', 'wait', { id: 'other' })).toEqual({ ok: false, error: "other isn't in this project." })
  })

  test('wait drops its subscription when the client disconnects', async () => {
    await boot()
    mgr.setStatus('kid', 'working')
    const c = createConnection(sock)
    await new Promise((r) => c.on('connect', r))
    c.write(JSON.stringify({ v: 1, session: 'me', token: cliToken(KEY, 'me'), cmd: 'wait', args: { id: 'kid' } }) + '\n')
    await new Promise((r) => setTimeout(r, 100))
    expect(mgr.cbs.size).toBe(1)
    c.destroy()
    await new Promise((r) => setTimeout(r, 100))
    expect(mgr.cbs.size).toBe(0)
  })

  test('a request over 1 MB is refused and the connection closed', async () => {
    await boot()
    const r = await raw('x'.repeat(1024 * 1024 + 10))
    expect(r).toEqual({ ok: false, error: 'Request too large.' })
  })

  test('a connection that sends nothing is closed after the idle time', async () => {
    await boot({ idleMs: 150 })
    const t0 = Date.now()
    expect(await raw('')).toBeNull()
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  test('one request per connection: the server ends it after replying', async () => {
    await boot()
    const r = await raw(JSON.stringify({ v: 1, session: 'me', token: cliToken(KEY, 'me'), cmd: 'list', args: {} }) + '\n' + 'junk\n')
    expect(r).toMatchObject({ ok: true })
  })
})

/** The same server over a real SessionManager: what `wait` sees comes from the session's events file, as in the app. */
describe('with the real session manager', () => {
  let root: string
  let paths: AppPaths
  let real: SessionManager
  const pasted: string[] = []
  const backend = {
    hasSession: async () => true,
    pasteText: async (_n: string, x: string) => { pasted.push(x) },
    sendKeys: async () => {}
  } as unknown as SessionBackend
  const ev = (id: string, e: string, x: Partial<HookEvent> = {}) => appendEvent(eventsFile(paths, id), { c: id, t: Date.now(), e, ...x })
  const session = (id: string, o: Partial<Session> = {}): Session => ({
    id, subProjectId: 'sp_1', title: `Title ${id}`, slug: id, claudeSessionId: `c-${id}`, cwd: root, branchCreatedByPitwall: false,
    createdAt: 0, lastViewedAt: 0, ...o
  })

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pwcli-real-'))
    paths = resolvePaths({ PITWALL_DATA_DIR: join(root, 'data'), PITWALL_WORKTREES_DIR: join(root, 'wt'), PITWALL_SSH_DIR: join(root, 'ssh') }, root)
    const store = await Store.open(paths.stateFile)
    await store.update((d) => {
      d.projects.push({ id: 'p_1', name: 'P', createdAt: 0, extraEnv: [], identity: { sshKeyPath: '', ghAccount: '', gitName: 'J', gitEmail: 'j@x.io' } })
      d.subProjects.push({ id: 'sp_1', projectId: 'p_1', name: 'F', kind: 'folder', path: root, createdAt: 0 })
      d.sessions.push(session('me'), session('kid', { createdBy: 'me' }))
    })
    for (const id of ['me', 'kid']) {
      await mkdir(sessionDir(paths, id), { recursive: true })
      await ev(id, 'SessionStart', { src: 'startup' })
    }
    await ev('kid', 'UserPromptSubmit')
    await ev('kid', 'Stop', { msg: 'first reply' })
    real = new SessionManager({
      store, paths, git: new GitClient(exec, {}), backend, exec, env: {}, home: root, mutex: new KeyedMutex(),
      notifier: { notify: () => {}, setBadge: () => {} }
    })
    await real.init()
    server = new CliServer({ key: KEY, socketPath: sock, manager: real })
    await server.start()
  })
  afterEach(async () => {
    real.dispose()
    await rm(root, { recursive: true, force: true })
  })

  test('wait straight after send waits for the reply to that message, not the one before', async () => {
    expect(await call('me', 'wait', { id: 'kid' })).toMatchObject({ ok: true, status: 'unread', lastMessage: 'first reply' })
    expect(await call('me', 'send', { id: 'kid', text: 'and now this' })).toEqual({ ok: true })
    expect(pasted).toContain('and now this')
    let answer: unknown = null
    const p = call('me', 'wait', { id: 'kid' }).then((r) => { answer = r; return r })
    await new Promise((r) => setTimeout(r, 1200)) // the tailer has had time to read anything there is
    expect(answer).toBeNull()
    await ev('kid', 'UserPromptSubmit')
    await ev('kid', 'Stop', { msg: 'second reply' })
    expect(await p).toMatchObject({ ok: true, status: 'unread', lastMessage: 'second reply' })
  })

  test('wait gives the whole reply the hook kept in last-reply.txt; an older file is never taken for a newer turn', async () => {
    const long = 'Here is the plan. '.repeat(400) // 7200 characters: the event keeps only the first 300
    expect(await call('me', 'send', { id: 'kid', text: 'plan it' })).toEqual({ ok: true })
    await ev('kid', 'UserPromptSubmit')
    await new Promise((r) => setTimeout(r, 20))
    await writeFile(join(sessionDir(paths, 'kid'), 'last-reply.txt'), long)
    await ev('kid', 'Stop', { msg: long.slice(0, 300) })
    expect((await call('me', 'wait', { id: 'kid' })).lastMessage).toBe(long)
    expect((await call('me', 'status', { id: 'kid' })).lastMessage).toBe(long)
    // The next turn's reply has no file (yet): its event's text, marked as cut.
    expect(await call('me', 'send', { id: 'kid', text: 'more' })).toEqual({ ok: true })
    await new Promise((r) => setTimeout(r, 20))
    await ev('kid', 'UserPromptSubmit')
    await ev('kid', 'Stop', { msg: 'y'.repeat(300) })
    expect((await call('me', 'wait', { id: 'kid' })).lastMessage).toBe('y'.repeat(300) + '…')
  })
})
