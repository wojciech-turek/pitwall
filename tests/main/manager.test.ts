import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { exec } from '../../src/main/exec'
import { GitClient } from '../../src/main/git'
import { appendEvent } from '../../src/main/hooks/events'
import { eventsFile, sessionDir } from '../../src/main/paths'
import { SessionManager } from '../../src/main/sessions/manager'
import { KeyedMutex } from '../../src/main/sessions/mutex'
import { Store } from '../../src/main/store'
import { claudeTmuxName, shellTmuxName } from '../../src/main/tmux'
import type { Notifier } from '../../src/main/notifier'
import type { HookEvent, Project, Session, SubProject } from '../../src/shared/types'
import { makeTestEnv } from '../helpers/env'
import { waitFor } from '../helpers/wait'

let t: Awaited<ReturnType<typeof makeTestEnv>>
let store: Store
let managers: SessionManager[]
let notes: { sessionId: string; title: string; body: string }[]
let badges: number[]
let notifier: Notifier

const project: Project = {
  id: 'p_1', name: 'Proj', createdAt: 0, extraEnv: [],
  identity: { sshKeyPath: '', ghAccount: 'dev-work', gitName: 'Jane', gitEmail: 'm@x.io' }
}

beforeEach(async () => {
  t = await makeTestEnv()
  managers = []
  notes = []
  badges = []
  notifier = { notify: (n) => notes.push(n), setBadge: (c) => badges.push(c) }
  await mkdir(t.paths.sshDir, { recursive: true })
  project.identity.sshKeyPath = join(t.paths.sshDir, 'id_test')
  await writeFile(project.identity.sshKeyPath, 'fake')
  store = await Store.open(t.paths.stateFile)
  const folder = join(t.tmp, 'folder')
  await mkdir(folder)
  const sp: SubProject = { id: 'sp_1', projectId: 'p_1', name: 'Folder', kind: 'folder', path: folder, createdAt: 0 }
  await store.update((d) => {
    d.projects.push(structuredClone(project))
    d.subProjects.push(sp)
  })
})
afterEach(async () => {
  for (const m of managers) m.dispose()
  await t.cleanup()
})

function mkManager(firstEventTimeoutMs = 8000): SessionManager {
  const m = new SessionManager({
    store, paths: t.paths, git: new GitClient(exec, t.env), tmux: t.tmux, exec, env: t.env, home: t.tmp,
    mutex: new KeyedMutex(), firstEventTimeoutMs, notifier
  })
  managers.push(m)
  return m
}

async function addSession(id: string, o: Partial<Session> = {}, events: Partial<HookEvent>[] = []): Promise<Session> {
  const s: Session = {
    id, subProjectId: 'sp_1', title: `Title ${id}`, slug: id, claudeSessionId: `claude-${id}`, cwd: join(t.tmp, 'folder'),
    branchCreatedByPitwall: false, createdAt: 0, lastViewedAt: 1000, ...o
  }
  await store.update((d) => {
    d.sessions.push(s)
  })
  // An inert tmux session so reconcile leaves it alone (a relaunched stub would race the events these tests append).
  if (o.archivedAt === undefined) await t.tmux.newSession({ name: claudeTmuxName(id), cwd: s.cwd, argv: ['sleep', '600'] })
  for (const e of events) await ev(id, e)
  return s
}
const ev = (id: string, e: Partial<HookEvent>) =>
  appendEvent(eventsFile(t.paths, id), { c: id, t: Date.now(), e: 'Notification', ...e })
const status = (m: SessionManager, id: string) => m.snapshot().sessions.find((s) => s.id === id)?.status
const waitStatus = (m: SessionManager, id: string, want: string) =>
  waitFor(async () => status(m, id) === want, 8000, `status ${want} (now ${status(m, id)})`)
async function ready(firstEventTimeoutMs?: number): Promise<SessionManager> {
  const m = mkManager(firstEventTimeoutMs)
  await m.init()
  return m
}

describe('SessionManager', () => {
  test('replay derives status without notifying', async () => {
    await addSession('a', {}, [{ e: 'UserPromptSubmit', t: 2000 }, { e: 'Stop', t: 3000, msg: 'done' }])
    const m = await ready()
    expect(status(m, 'a')).toBe('unread')
    expect(notes).toEqual([])
    expect(badges.at(-1)).toBe(1)
  })

  test('live permission request notifies once', async () => {
    const s = await addSession('a')
    const m = await ready()
    await ev('a', { e: 'PermissionRequest', tool: 'Bash' })
    await waitStatus(m, 'a', 'needs_you')
    await ev('a', { e: 'Notification', nt: 'permission_prompt' })
    await waitFor(async () => m.snapshot().sessions[0].lastError === undefined && badges.at(-1) === 1)
    await new Promise((r) => setTimeout(r, 300))
    expect(notes).toEqual([{ sessionId: 'a', title: `${s.title} · Proj`, body: 'Needs your permission' }])
    expect(badges.at(-1)).toBe(1)
  })

  test('question and other bodies', async () => {
    await addSession('a')
    await addSession('b')
    const m = await ready()
    await ev('a', { e: 'PermissionRequest', tool: 'AskUserQuestion' })
    await ev('b', { e: 'Notification', nt: 'elicitation_dialog' })
    await waitFor(async () => notes.length === 2)
    expect(notes.find((n) => n.sessionId === 'a')?.body).toBe('Has a question for you')
    expect(notes.find((n) => n.sessionId === 'b')?.body).toBe('Needs you')
    expect(m).toBeTruthy()
  })

  test('finish notifies with truncated last message', async () => {
    await addSession('a')
    const m = await ready()
    await ev('a', { e: 'UserPromptSubmit' })
    await waitStatus(m, 'a', 'working')
    await new Promise((r) => setTimeout(r, 5))
    await ev('a', { e: 'Stop', msg: 'x'.repeat(300) })
    await waitStatus(m, 'a', 'unread')
    expect(notes).toHaveLength(1)
    expect(notes[0].body).toBe('x'.repeat(120))
    await waitFor(async () => store.state.sessions[0].lastMessage === 'x'.repeat(300), 8000, 'lastMessage persisted')
  })

  test('viewing + focused: finish is read, no notification', async () => {
    await addSession('a')
    const m = await ready()
    m.setViewing(['a'], true)
    await ev('a', { e: 'UserPromptSubmit' })
    await waitStatus(m, 'a', 'working')
    await ev('a', { e: 'Stop', msg: 'ok' })
    await waitFor(async () => store.state.sessions[0].lastMessage === 'ok', 8000, 'Stop processed')
    expect(status(m, 'a')).toBe('read')
    expect(notes).toEqual([])
  })

  test('viewing but window unfocused: finish is unread and notifies', async () => {
    await addSession('a')
    const m = await ready()
    m.setViewing(['a'], false)
    await ev('a', { e: 'UserPromptSubmit' })
    await waitStatus(m, 'a', 'working')
    await ev('a', { e: 'Stop', msg: 'ok' })
    await waitStatus(m, 'a', 'unread')
    expect(notes).toHaveLength(1)
    expect(notes[0].body).toBe('ok')
  })

  test('multiple visible sessions + focused: both finish read, no notifications', async () => {
    await addSession('a')
    await addSession('b')
    const m = await ready()
    m.setViewing(['a', 'b'], true)
    for (const id of ['a', 'b']) {
      await ev(id, { e: 'UserPromptSubmit' })
      await waitStatus(m, id, 'working')
      await ev(id, { e: 'Stop', msg: 'ok' })
    }
    await waitFor(async () => store.state.sessions.every((x) => x.lastMessage === 'ok'), 8000, 'Stops processed')
    expect(status(m, 'a')).toBe('read')
    expect(status(m, 'b')).toBe('read')
    expect(notes).toEqual([])
  })

  test('multiple visible sessions but unfocused: both unread, two notifications', async () => {
    await addSession('a')
    await addSession('b')
    const m = await ready()
    m.setViewing(['a', 'b'], false)
    for (const id of ['a', 'b']) {
      await ev(id, { e: 'UserPromptSubmit' })
      await waitStatus(m, id, 'working')
      await ev(id, { e: 'Stop', msg: 'ok' })
      await waitStatus(m, id, 'unread')
    }
    expect(notes).toHaveLength(2)
  })

  test('nothing visible: finish is unread and notifies', async () => {
    await addSession('a')
    const m = await ready()
    m.setViewing([], true)
    await ev('a', { e: 'UserPromptSubmit' })
    await waitStatus(m, 'a', 'working')
    await ev('a', { e: 'Stop', msg: 'ok' })
    await waitStatus(m, 'a', 'unread')
    expect(notes).toHaveLength(1)
  })

  test('Esc while working stops showing Working', async () => {
    await addSession('a')
    const m = await ready()
    await ev('a', { e: 'UserPromptSubmit' })
    await waitStatus(m, 'a', 'working')
    m.userInput('a', 'claude', '\x1b')
    await waitFor(async () => status(m, 'a') !== 'working')
    expect(await readFile(eventsFile(t.paths, 'a'), 'utf8')).toContain('pitwall:user-esc')
  })

  test('answering a prompt shows Working, once per episode; shell input ignored', async () => {
    await addSession('a')
    const m = await ready()
    await ev('a', { e: 'PermissionRequest', tool: 'Bash' })
    await waitStatus(m, 'a', 'needs_you')
    m.userInput('a', 'shell', '1')
    m.userInput('a', 'claude', '1')
    m.userInput('a', 'claude', '2')
    await waitStatus(m, 'a', 'working')
    const text = await readFile(eventsFile(t.paths, 'a'), 'utf8')
    expect(text.match(/pitwall:user-input/g)).toHaveLength(1)
  })

  test('terminal-generated input does not count as answering', async () => {
    await addSession('a')
    const m = await ready()
    await ev('a', { e: 'PermissionRequest', tool: 'Bash' })
    await waitStatus(m, 'a', 'needs_you')
    m.userInput('a', 'claude', '\x1b[I')
    await new Promise((r) => setTimeout(r, 500))
    expect(status(m, 'a')).toBe('needs_you')
    expect(await readFile(eventsFile(t.paths, 'a'), 'utf8')).not.toContain('pitwall:user-input')
  })

  test('/clear updates claude session id and claude-id file', async () => {
    const m = await ready()
    const res = await m.start(
      { requestId: 'r', subProjectId: 'sp_1', title: 'Clearing', branchMode: 'new', branch: '' },
      () => {}
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const s = store.state.sessions[0]
    await t.tmux.sendKeys(claudeTmuxName(s.id), ['clear', 'Enter'])
    const want = `${s.claudeSessionId}-cleared`
    await waitFor(async () => store.state.sessions[0].claudeSessionId === want, 8000, 'sid update')
    await waitFor(async () => (await readFile(join(sessionDir(t.paths, s.id), 'claude-id'), 'utf8')).trim() === want)
  })

  test('start tracks the session live and clears the warning after the first event', async () => {
    const m = await ready()
    const res = await m.start(
      { requestId: 'r', subProjectId: 'sp_1', title: 'Live', branchMode: 'new', branch: '' }, () => {}
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    await t.tmux.sendKeys(claudeTmuxName(res.sessionId), ['hello', 'Enter'])
    await waitFor(async () => store.state.sessions[0].lastMessage === 'echo: hello', 8000, 'live message')
    expect(m.snapshot().sessions[0].startWarning).toBeUndefined()
  })

  test('silent claude: start returns at once; the trust-prompt warning shows after the timeout and clears on the first event', async () => {
    t.env.STUB_CLAUDE_SILENT = '1'
    const m = await ready(500)
    const t0 = Date.now()
    const res = await m.start(
      { requestId: 'r', subProjectId: 'sp_1', title: 'Quiet', branchMode: 'new', branch: '' }, () => {}
    )
    expect(Date.now() - t0).toBeLessThan(5000)
    if (!res.ok) throw new Error(res.error)
    expect(res).toEqual({ ok: true, sessionId: res.sessionId })
    expect(m.snapshot().sessions[0].startWarning).toBeUndefined()
    const warning = 'Claude hasn\'t reported in yet. If it\'s asking whether to trust this folder, ' +
      'choose "Yes, I trust this folder" — the default is "No, exit".'
    await waitFor(async () => m.snapshot().sessions[0].startWarning === warning, 8000, 'start warning')
    await ev(res.sessionId, { e: 'SessionStart', sid: 'x' })
    await waitFor(async () => m.snapshot().sessions[0].startWarning === undefined, 8000, 'warning cleared')
  })

  test('no warning when Claude reports in before the timeout', async () => {
    const m = await ready(1500)
    const res = await m.start(
      { requestId: 'r', subProjectId: 'sp_1', title: 'Loud', branchMode: 'new', branch: '' }, () => {}
    )
    if (!res.ok) throw new Error(res.error)
    await new Promise((r) => setTimeout(r, 2500))
    expect(m.snapshot().sessions[0].startWarning).toBeUndefined()
  })

  test('reconcile relaunches a missing tmux session with resume', async () => {
    t.env.STUB_CLAUDE_LOG = join(t.tmp, 'claude.log')
    const m1 = await ready()
    const res = await m1.start(
      { requestId: 'r', subProjectId: 'sp_1', title: 'Resume me', branchMode: 'new', branch: '' }, () => {}
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // start no longer waits for Claude; let the first launch happen before pulling the rug.
    await waitFor(async () => (await readFile(t.env.STUB_CLAUDE_LOG, 'utf8').catch(() => '')).includes('--session-id'), 8000, 'first launch')
    m1.dispose()
    await t.tmux.killSession(claudeTmuxName(res.sessionId))
    expect(await t.tmux.hasSession(claudeTmuxName(res.sessionId))).toBe(false)
    const m2 = await ready()
    expect(await t.tmux.hasSession(claudeTmuxName(res.sessionId))).toBe(true)
    await waitFor(async () => (await readFile(t.env.STUB_CLAUDE_LOG, 'utf8')).includes('--resume'), 8000, '--resume')
    expect(m2.snapshot().sessions).toHaveLength(1)
  })

  test('ensureTerminalTarget creates shell session lazily', async () => {
    await addSession('a')
    const m = await ready()
    expect(await t.tmux.hasSession(shellTmuxName('a'))).toBe(false)
    await m.ensureTerminalTarget('a', 'shell')
    expect(await t.tmux.hasSession(shellTmuxName('a'))).toBe(true)
    await m.ensureTerminalTarget('a', 'shell')
    await t.tmux.killSession(claudeTmuxName('a'))
    expect(await t.tmux.hasSession(claudeTmuxName('a'))).toBe(false)
    await m.ensureTerminalTarget('a', 'claude')
    expect(await t.tmux.hasSession(claudeTmuxName('a'))).toBe(true)
  })

  test('rewriteProjectSessionFiles rewrites env.sh for that project\'s active sessions only', async () => {
    await store.update((d) => {
      d.projects.push({ ...structuredClone(project), id: 'p_2', name: 'Other' })
      d.subProjects.push({ id: 'sp_2', projectId: 'p_2', name: 'F2', kind: 'folder', path: join(t.tmp, 'folder'), createdAt: 0 })
    })
    await addSession('a')
    await addSession('b', { subProjectId: 'sp_2' })
    await addSession('c', { archivedAt: 5 })
    const m = await ready()
    await mkdir(sessionDir(t.paths, 'b'), { recursive: true })
    await writeFile(join(sessionDir(t.paths, 'b'), 'env.sh'), 'untouched')
    await store.update((d) => { d.projects[0].identity.gitEmail = 'new@x.io' })
    await m.rewriteProjectSessionFiles('p_1')
    expect(await readFile(join(sessionDir(t.paths, 'a'), 'env.sh'), 'utf8')).toContain("GIT_AUTHOR_EMAIL='new@x.io'")
    expect(await readFile(join(sessionDir(t.paths, 'b'), 'env.sh'), 'utf8')).toBe('untouched')
    await expect(readFile(join(sessionDir(t.paths, 'c'), 'env.sh'), 'utf8')).rejects.toThrow()
  })

  test('rename persists', async () => {
    await addSession('a')
    const m = await ready()
    await m.rename('a', 'New name')
    expect(store.state.sessions[0].title).toBe('New name')
    expect(m.snapshot().sessions[0].title).toBe('New name')
  })

  test('snapshot separates archived sessions; extras and subscriptions', async () => {
    await addSession('a')
    await addSession('b', { archivedAt: 5 })
    const m = await ready()
    const snaps: number[] = []
    const off = m.onSnapshot((s) => snaps.push(s.sessions.length))
    expect(m.snapshot().sessions.map((s) => s.id)).toEqual(['a'])
    expect(m.snapshot().archived.map((s) => s.id)).toEqual(['b'])
    m.updateSessionExtras('a', { diffStat: { additions: 1, deletions: 2 }, liveBranch: 'x' })
    expect(m.snapshot().sessions[0]).toMatchObject({ diffStat: { additions: 1, deletions: 2 }, liveBranch: 'x' })
    await waitFor(async () => snaps.length > 0)
    off()
    m.dropSession('a')
    await ev('a', { e: 'PermissionRequest', tool: 'Bash' })
    await new Promise((r) => setTimeout(r, 700))
    expect(notes).toEqual([])
  })

  test("init refreshes running sessions' files (e.g. hooks.json from an older pitwall) without relaunching them", async () => {
    await addSession('a', {}, [{ e: 'SessionStart', sid: 'claude-a-cleared' }])
    await addSession('b')
    await store.update((d) => { d.sessions.find((x) => x.id === 'b')!.subProjectId = 'sp_missing' })
    const dir = sessionDir(t.paths, 'a')
    await writeFile(join(dir, 'hooks.json'), '{"hooks":{}}')
    await writeFile(join(dir, 'claude-id'), 'claude-a\n')
    const m = await ready()
    const settings = JSON.parse(await readFile(join(dir, 'hooks.json'), 'utf8'))
    expect(settings.statusLine.command).toContain('pitwall-statusline')
    expect(await readFile(join(dir, 'env.sh'), 'utf8')).toContain("PITWALL_SESSION_ID='a'")
    // the conversation id replayed from events wins over the stale one
    expect((await readFile(join(dir, 'claude-id'), 'utf8')).trim()).toBe('claude-a-cleared')
    expect(await t.tmux.hasSession(claudeTmuxName('a'))).toBe(true)
    // a session whose files can't be written is left alone: it's running, so no error is shown
    expect(m.snapshot().sessions.find((x) => x.id === 'b')?.lastError).toBeUndefined()
  })

  test('ensureTerminalTarget rejects when relaunch fails; init records the error and continues', async () => {
    await addSession('a')
    await addSession('b')
    await addSession('c')
    await t.tmux.killSession(claudeTmuxName('b'))
    await t.tmux.killSession(claudeTmuxName('c'))
    // 'b' points at a sub-project that does not exist, so writeSessionFiles throws.
    await store.update((d) => {
      d.sessions.find((x) => x.id === 'b')!.subProjectId = 'sp_missing'
    })
    const m = await ready()
    expect(await t.tmux.hasSession(claudeTmuxName('c'))).toBe(true)
    expect(m.snapshot().sessions.find((x) => x.id === 'b')?.lastError).toMatch(/Sub-project not found/)
    expect(m.snapshot().sessions.find((x) => x.id === 'c')?.lastError).toBeUndefined()
    await expect(m.ensureTerminalTarget('b', 'claude')).rejects.toThrow(/Sub-project not found/)
  })

  test('a session whose folder is gone: reconcile records the error, the shell tab refuses', async () => {
    const gone = join(t.tmp, 'gone')
    await addSession('a', { cwd: gone })
    await t.tmux.killSession(claudeTmuxName('a'))
    const m = await ready()
    expect(m.snapshot().sessions[0].lastError).toBe(`Session folder not found: ${gone}`)
    expect(await t.tmux.hasSession(claudeTmuxName('a'))).toBe(false)
    await expect(m.ensureTerminalTarget('a', 'shell')).rejects.toThrow(`Session folder not found: ${gone}`)
    expect(await t.tmux.hasSession(shellTmuxName('a'))).toBe(false)
  })

  test('replay folds the last message into the snapshot', async () => {
    await addSession('a', {}, [{ e: 'UserPromptSubmit', t: 2000 }, { e: 'Stop', t: 3000, msg: 'done X' }])
    const m = await ready()
    expect(m.snapshot().sessions[0].lastMessage).toBe('done X')
  })

  test('an unreadable events file does not block other sessions, and tracking retries', async () => {
    await addSession('a')
    await addSession('b', {}, [{ e: 'Stop', t: 3000, msg: 'ok' }])
    await rm(eventsFile(t.paths, 'a'), { force: true })
    await mkdir(eventsFile(t.paths, 'a'), { recursive: true }) // a directory where the file should be
    const m = await ready()
    expect(m.snapshot().sessions.find((x) => x.id === 'a')?.lastError).toBeTruthy()
    expect(status(m, 'b')).toBe('unread')
    await rm(eventsFile(t.paths, 'a'), { recursive: true })
    await ev('a', { e: 'Stop', t: 4000, msg: 'later' })
    await m.waitForFirstEvent('a', 3000)
    expect(status(m, 'a')).toBe('unread')
  })

  test('track before the session exists is retried once it does', async () => {
    const m = await ready()
    expect(await m.waitForFirstEvent('late', 50)).toBe(false)
    await addSession('late', {}, [{ e: 'Stop', t: 3000, msg: 'hi' }])
    expect(await m.waitForFirstEvent('late', 3000)).toBe(true)
  })
})

describe('muted projects and mark as unread', () => {
  const mute = (muted: boolean) => store.update((d) => { d.projects[0].muted = muted })
  const readSession = (id: string) =>
    addSession(id, {}, [{ e: 'UserPromptSubmit', t: 2000 }, { e: 'Stop', t: 3000, msg: 'done' }])

  test('a muted project sends no notification and adds nothing to the badge', async () => {
    await addSession('a')
    const m = await ready()
    await mute(true)
    await ev('a', { e: 'PermissionRequest', tool: 'Bash' })
    await waitStatus(m, 'a', 'needs_you')
    await new Promise((r) => setTimeout(r, 300))
    expect(notes).toEqual([])
    expect(badges.at(-1)).toBe(0)
    expect(status(m, 'a')).toBe('needs_you') // the sidebar and title-bar counts still show it
  })

  test('unmuting brings the badge back', async () => {
    await addSession('a')
    await mute(true)
    const m = await ready()
    await ev('a', { e: 'PermissionRequest', tool: 'Bash' })
    await waitStatus(m, 'a', 'needs_you')
    expect(badges.at(-1)).toBe(0)
    await mute(false)
    await waitFor(async () => badges.at(-1) === 1)
    await ev('a', { e: 'PermissionRequest', tool: 'Bash' })
  })

  test('mark as unread: unread, counted, stays while merely visible, clears when opened', async () => {
    await readSession('a')
    const m = await ready()
    expect(status(m, 'a')).toBe('unread') // lastViewedAt 1000 < finished
    m.setViewing(['a'], true)
    expect(status(m, 'a')).toBe('read')
    await m.markUnread('a')
    expect(status(m, 'a')).toBe('unread')
    expect(badges.at(-1)).toBe(1)
    m.setViewing(['a'], true)
    expect(status(m, 'a')).toBe('unread')
    m.sessionOpened('a')
    await waitStatus(m, 'a', 'read')
    expect(badges.at(-1)).toBe(0)
    expect(store.state.sessions[0].markedUnread).toBeFalsy()
  })

  test('typing into the Claude terminal clears it; shell input does not', async () => {
    await readSession('a')
    const m = await ready()
    m.setViewing(['a'], true)
    await m.markUnread('a')
    m.userInput('a', 'shell', 'ls')
    expect(status(m, 'a')).toBe('unread')
    m.userInput('a', 'claude', 'h')
    await waitStatus(m, 'a', 'read')
  })

  test('a muted project does not count a marked session in the badge', async () => {
    await readSession('a')
    await mute(true)
    const m = await ready()
    m.setViewing(['a'], true)
    await m.markUnread('a')
    expect(status(m, 'a')).toBe('unread')
    expect(badges.at(-1)).toBe(0)
  })

  test('marking a session that is not read is a no-op', async () => {
    await addSession('a', {}, [{ e: 'UserPromptSubmit', t: 2000 }])
    const m = await ready()
    await m.markUnread('a')
    expect(status(m, 'a')).toBe('working')
    expect(store.state.sessions[0].markedUnread).toBeFalsy()
  })

  test('state without the new fields loads', async () => {
    await addSession('a')
    const m = await ready()
    expect(m.snapshot().projects[0].muted).toBeUndefined()
    expect(status(m, 'a')).toBe('starting')
  })
})
