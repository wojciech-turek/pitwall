import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { AccountMover, WAIT_MS } from '../../src/main/sessions/mover'
import { Store } from '../../src/main/store'
import type { AppSnapshot, DisplayStatus, HookEvent, Project, Session, SessionView, SubProject } from '../../src/shared/types'

let tmp: string
let home: string
let store: Store
let mover: AccountMover
let acctDir: string
let status: Map<string, DisplayStatus>
let limitHit: Set<string>
let busySubagent: Set<string>
let restarts: string[]
let restartFails: boolean
let sent: Array<[string, string]>
let cancelled: string[]
let errors: Array<[string, string]>
let extras: Array<[string, object]>
let restarted: string[]
let snapCbs: Array<(s: AppSnapshot) => void>
let eventCbs: Array<(id: string, e: HookEvent) => void>
let timers: Array<{ fn: () => void; ms: number; cleared: boolean }>

const project = (id: string, extraEnv: Project['extraEnv'] = []): Project =>
  ({ id, name: id, createdAt: 0, extraEnv, identity: { sshKeyPath: '', ghAccount: '', gitName: '', gitEmail: '' } })
const sub = (id: string, projectId: string): SubProject => ({ id, projectId, name: id, kind: 'folder', path: '/w', createdAt: 0 })
const mkSession = (id: string, o: Partial<Session> = {}): Session =>
  ({ id, subProjectId: 'sp', title: id, slug: id, claudeSessionId: `c-${id}`, cwd: `/w/${id}`, branchCreatedByPitwall: false, createdAt: 0, lastViewedAt: 0, ...o })
const get = (id: string): Session => store.state.sessions.find((s) => s.id === id)!
const sessionDirOf = (id: string): string => join(tmp, 'data', 'sessions', id)
const marker = (id: string): string => join(sessionDirOf(id), 'moved-from')

function snapshot(): AppSnapshot {
  const st = store.state
  const sessions = st.sessions.filter((s) => s.archivedAt === undefined).map((s): SessionView => ({
    ...s, status: status.get(s.id) ?? 'read',
    ...(limitHit.has(s.id) ? { limitHit: true } : {}),
    ...(busySubagent.has(s.id) ? { subagents: [{ id: 'x', type: 't', state: 'running' as const, startedAt: 0 }] } : {})
  }))
  return { projects: st.projects, subProjects: st.subProjects, sessions, archived: [], settings: st.settings }
}
const publish = (): void => { for (const cb of [...snapCbs]) cb(snapshot()) }
const emit = (id: string, e: string, extra: Partial<HookEvent> = {}): void => {
  for (const cb of [...eventCbs]) cb(id, { c: id, t: 1, e, ...extra })
}
const setStatus = (id: string, s: DisplayStatus): void => { status.set(id, s); publish() }
/** Lets the mover's chained promises run. */
const settle = (): Promise<void> => mover.idle()
const fireTimers = (): void => { for (const t of timers.filter((x) => !x.cleared)) { t.cleared = true; t.fn() } }
async function add(...sessions: Session[]): Promise<void> {
  await store.update((d) => { d.sessions.push(...sessions) })
  for (const s of sessions) mkdirSync(sessionDirOf(s.id), { recursive: true })
}

beforeEach(async () => {
  tmp = realpathSync(await mkdtemp(join(tmpdir(), 'pitwall-mover-')))
  home = join(tmp, 'home')
  acctDir = join(tmp, 'data', 'claude-accounts', 'a1')
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(acctDir, { recursive: true })
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@x.com' }, projects: { '/w/s1': { hasTrustDialogAccepted: true } } }))
  writeFileSync(join(acctDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'b@x.com' } }))
  store = await Store.open(join(tmp, 'state.json'))
  await store.update((d) => {
    d.projects.push(project('p'), project('pp', [{ key: 'CLAUDE_CONFIG_DIR', value: join(tmp, 'pinned') }]))
    d.subProjects.push(sub('sp', 'p'), sub('spp', 'pp'))
    d.settings.claudeAccounts = [{ id: 'a1', dir: acctDir, addedAt: 1 }, { id: 'a2', dir: join(tmp, 'data', 'claude-accounts', 'a2'), addedAt: 2 }]
  })
  status = new Map(); limitHit = new Set(); busySubagent = new Set()
  restarts = []; restartFails = false; sent = []; cancelled = []; errors = []; extras = []; restarted = []
  snapCbs = []; eventCbs = []; timers = []
  mover = make()
  mover.start()
})
afterEach(async () => { mover.stop(); await rm(tmp, { recursive: true, force: true }) })

function make(): AccountMover {
  return new AccountMover({
    store, home, env: {}, sessionDir: sessionDirOf,
    manager: {
      snapshot,
      onSnapshot: (cb) => { snapCbs.push(cb); return () => { snapCbs = snapCbs.filter((x) => x !== cb) } },
      onSessionEvent: (cb) => { eventCbs.push(cb); return () => { eventCbs = eventCbs.filter((x) => x !== cb) } },
      restartClaude: async (id) => { restarts.push(id); if (restartFails) throw new Error('no tmux') },
      sendText: async (id, text) => {
        const s = status.get(id) ?? 'read'
        if (s !== 'read' && s !== 'unread') throw new Error('busy')
        sent.push([id, text])
      },
      reportError: (id, message) => { errors.push([id, message]) },
      updateSessionExtras: (id, patch) => { extras.push([id, patch]) }
    },
    continueAt: { cancel: async (id) => { cancelled.push(id) } },
    labelFor: async (id) => (id === 'a1' ? 'b@x.com' : id === 'default' ? 'me@x.com' : id),
    onRestarted: (id) => { restarted.push(id) },
    timers: {
      setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t },
      clearTimeout: (h) => { (h as { cleared: boolean }).cleared = true }
    }
  })
}

describe('moving a session to another account', () => {
  test('an idle session moves at once: its account is set, the marker written, Claude restarted once', async () => {
    await add(mkSession('s1'))
    await mover.request('s1', 'a1')
    expect(get('s1').account).toBe('a1')
    expect(get('s1').movedFrom).toBe('default')
    expect('moveTo' in get('s1')).toBe(false)
    expect(readFileSync(marker('s1'), 'utf8')).toBe('default\n')
    expect(restarts).toEqual(['s1'])
    expect(restarted).toEqual(['s1'])
    expect(timers.filter((t) => !t.cleared).map((t) => t.ms)).toEqual([WAIT_MS])
    expect(WAIT_MS).toBe(60_000)
  })

  test("the folder's trust entry goes with it, before the restart; the signed-in profile never does", async () => {
    await add(mkSession('s1'))
    await mover.request('s1', 'a1')
    const profile = JSON.parse(readFileSync(join(acctDir, '.claude.json'), 'utf8'))
    expect(profile.projects).toEqual({ '/w/s1': { hasTrustDialogAccepted: true } })
    expect(profile.oauthAccount.emailAddress).toBe('b@x.com')
  })

  test.each(['working', 'needs_you', 'starting'] as const)('a session that is %s waits, and moves when it becomes idle', async (busy) => {
    await add(mkSession('s1'))
    status.set('s1', busy)
    await mover.request('s1', 'a1')
    expect(get('s1').moveTo).toBe('a1')
    expect('account' in get('s1')).toBe(false)
    expect(restarts).toEqual([])
    setStatus('s1', 'unread')
    await settle()
    expect(get('s1').account).toBe('a1')
    expect(restarts).toEqual(['s1'])
  })

  test('an idle session with a subagent still at work waits for it', async () => {
    await add(mkSession('s1'))
    busySubagent.add('s1')
    await mover.request('s1', 'a1')
    expect(restarts).toEqual([])
    busySubagent.delete('s1')
    publish()
    await settle()
    expect(restarts).toEqual(['s1'])
  })

  test('a session whose Claude has exited moves at once', async () => {
    await add(mkSession('s1'))
    status.set('s1', 'exited')
    await mover.request('s1', 'a1')
    expect(get('s1').account).toBe('a1')
    expect(restarts).toEqual(['s1'])
  })

  test('moving back to the default account removes the account from the session', async () => {
    await add(mkSession('s1', { account: 'a1' }))
    await mover.request('s1', 'default')
    expect('account' in get('s1')).toBe(false)
    expect(get('s1').movedFrom).toBe('a1')
  })

  test('a pinned session is refused; an unknown account or session too', async () => {
    await add(mkSession('pin', { subProjectId: 'spp' }), mkSession('s1'))
    await expect(mover.request('pin', 'a1')).rejects.toThrow("This session's project sets its own Claude account.")
    await expect(mover.request('s1', 'nope')).rejects.toThrow('Account not found.')
    await expect(mover.request('ghost', 'a1')).rejects.toThrow('Session not found.')
    expect(restarts).toEqual([])
  })

  test('a scheduled continue is cancelled by the move', async () => {
    await add(mkSession('s1', { continueAt: 99 }))
    await mover.request('s1', 'a1')
    expect(cancelled).toEqual(['s1'])
  })
})

describe('moving every running session', () => {
  test('counts and moves the unpinned sessions on another account: idle ones now, busy ones later', async () => {
    await add(mkSession('idle1'), mkSession('idle2'), mkSession('busy'), mkSession('already', { account: 'a1' }), mkSession('pin', { subProjectId: 'spp' }), mkSession('old', { archivedAt: 1 }))
    status.set('busy', 'working')
    expect(mover.countMovable('a1')).toEqual({ now: 2, later: 1 })
    expect(restarts).toEqual([]) // counting moves nothing
    expect(await mover.requestAll('a1')).toEqual({ now: 2, later: 1 })
    expect(restarts.sort()).toEqual(['idle1', 'idle2'])
    expect(get('busy').moveTo).toBe('a1')
    expect('moveTo' in get('pin')).toBe(false)
    expect('moveTo' in get('already')).toBe(false)
  })

  test('nothing to move: zero and zero', async () => {
    await add(mkSession('already', { account: 'a1' }))
    expect(await mover.requestAll('a1')).toEqual({ now: 0, later: 0 })
  })
})

describe('after the restart', () => {
  test('SessionStart settles it: marker and movedFrom gone, the wait disarmed, nothing typed', async () => {
    await add(mkSession('s1'))
    await mover.request('s1', 'a1')
    emit('s1', 'SessionStart')
    await settle()
    expect(existsSync(marker('s1'))).toBe(false)
    expect('movedFrom' in get('s1')).toBe(false)
    expect(timers.every((t) => t.cleared)).toBe(true)
    publish()
    await settle()
    expect(sent).toEqual([])
  })

  test('a session that had stopped at a limit gets "continue" once, only after SessionStart and once it is idle', async () => {
    await add(mkSession('s1'))
    limitHit.add('s1')
    await mover.request('s1', 'a1')
    status.set('s1', 'starting')
    publish(); await settle()
    expect(sent).toEqual([]) // no SessionStart yet: a sign-in or trust prompt must never get the text
    setStatus('s1', 'read'); await settle()
    expect(sent).toEqual([])
    status.set('s1', 'starting')
    emit('s1', 'SessionStart'); await settle()
    expect(sent).toEqual([]) // started, not idle yet
    setStatus('s1', 'read'); await settle()
    expect(sent).toEqual([['s1', 'continue']])
    publish(); await settle()
    expect(sent).toHaveLength(1)
  })

  test("move-failed puts the session back on its previous account, restarts it there, and says so", async () => {
    await add(mkSession('s1'))
    limitHit.add('s1')
    await mover.request('s1', 'a1')
    emit('s1', 'pitwall:move-failed', { code: 1 })
    await settle()
    expect('account' in get('s1')).toBe(false)
    expect('movedFrom' in get('s1')).toBe(false)
    expect(existsSync(marker('s1'))).toBe(false)
    expect(restarts).toEqual(['s1', 's1'])
    expect(errors).toEqual([['s1', "Couldn't continue this conversation on b@x.com."]])
    emit('s1', 'SessionStart'); publish(); await settle()
    expect(sent).toEqual([]) // back where the limit is: nothing typed
  })

  test('after 60 seconds with neither, the session is marked waiting and stays on the new account', async () => {
    await add(mkSession('s1'))
    await mover.request('s1', 'a1')
    fireTimers()
    await settle()
    expect(extras).toEqual([['s1', { moveWaiting: true }]])
    expect(get('s1').account).toBe('a1')
    expect(get('s1').movedFrom).toBe('default')
    expect(existsSync(marker('s1'))).toBe(true)
    expect(restarts).toEqual(['s1'])
    // It starts after all (the user signed in at the prompt): settled, no longer waiting.
    emit('s1', 'SessionStart'); await settle()
    expect(extras.at(-1)).toEqual(['s1', { moveWaiting: undefined }])
    expect('movedFrom' in get('s1')).toBe(false)
  })

  test('Move back returns a waiting session to its previous account, with no error', async () => {
    await add(mkSession('s1'))
    await mover.request('s1', 'a1')
    fireTimers(); await settle()
    await mover.moveBack('s1')
    expect('account' in get('s1')).toBe(false)
    expect('movedFrom' in get('s1')).toBe(false)
    expect(existsSync(marker('s1'))).toBe(false)
    expect(restarts).toEqual(['s1', 's1'])
    expect(errors).toEqual([])
    expect(extras.at(-1)).toEqual(['s1', { moveWaiting: undefined }])
    await expect(mover.moveBack('s1')).rejects.toThrow('This session was not moved.')
  })

  test("a restart that can't even start leaves the session back on its previous account, with the reason", async () => {
    await add(mkSession('s1'))
    restartFails = true
    await expect(mover.request('s1', 'a1')).rejects.toThrow('no tmux')
    expect('account' in get('s1')).toBe(false)
    expect('movedFrom' in get('s1')).toBe(false)
    expect(existsSync(marker('s1'))).toBe(false)
  })
})

describe('changing your mind, and things changing underneath', () => {
  test('requesting twice restarts once', async () => {
    await add(mkSession('s1'))
    await Promise.all([mover.request('s1', 'a1'), mover.request('s1', 'a1')])
    publish(); await settle()
    expect(restarts).toEqual(['s1'])
  })

  test('switching back to its current account cancels a pending move; Cancel does too', async () => {
    await add(mkSession('s1'), mkSession('s2'))
    status.set('s1', 'working'); status.set('s2', 'working')
    await mover.request('s1', 'a1')
    await mover.request('s1', 'default')
    await mover.request('s2', 'a1')
    await mover.cancel('s2')
    expect('moveTo' in get('s1')).toBe(false)
    expect('moveTo' in get('s2')).toBe(false)
    setStatus('s1', 'read'); setStatus('s2', 'read'); await settle()
    expect(restarts).toEqual([])
  })

  test('a new target replaces a pending one', async () => {
    await add(mkSession('s1'))
    status.set('s1', 'working')
    await mover.request('s1', 'a1')
    await mover.request('s1', 'a2')
    expect(get('s1').moveTo).toBe('a2')
    setStatus('s1', 'read'); await settle()
    expect(get('s1').account).toBe('a2')
    expect(restarts).toEqual(['s1'])
  })

  test("a project that becomes pinned drops its sessions' pending moves", async () => {
    await add(mkSession('s1'))
    status.set('s1', 'working')
    await mover.request('s1', 'a1')
    await store.update((d) => { d.projects[0].extraEnv = [{ key: 'CLAUDE_CONFIG_DIR', value: join(tmp, 'now-pinned') }] })
    setStatus('s1', 'read'); await settle()
    expect('moveTo' in get('s1')).toBe(false)
    expect(restarts).toEqual([])
  })

  test('a pending move to an account that has been removed is dropped', async () => {
    await add(mkSession('s1'))
    status.set('s1', 'working')
    await mover.request('s1', 'a1')
    await store.update((d) => { d.settings.claudeAccounts = d.settings.claudeAccounts!.filter((a) => a.id !== 'a1') })
    setStatus('s1', 'read'); await settle()
    expect('moveTo' in get('s1')).toBe(false)
    expect(restarts).toEqual([])
  })

  test('after a restart of Pitwall: a pending move still happens, and a session mid-move keeps its new account and re-arms the wait', async () => {
    await add(mkSession('pending', { moveTo: 'a1' }), mkSession('mid', { account: 'a1', movedFrom: 'default' }))
    writeFileSync(marker('mid'), 'default\n')
    mover.stop()
    timers = []
    mover = make()
    mover.start()
    await settle()
    expect(get('pending').account).toBe('a1')
    expect(restarts).toEqual(['pending'])
    expect(get('mid').account).toBe('a1')
    expect(get('mid').movedFrom).toBe('default')
    expect(existsSync(marker('mid'))).toBe(true)
    // One wait for the session moved just now, one re-armed for the one found mid-move.
    expect(timers.filter((t) => !t.cleared)).toHaveLength(2)
    emit('mid', 'SessionStart'); await settle()
    expect('movedFrom' in get('mid')).toBe(false)
    expect(existsSync(marker('mid'))).toBe(false)
  })
})
