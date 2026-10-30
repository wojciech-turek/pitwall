import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { exec } from '../../src/main/exec'
import { GitClient } from '../../src/main/git'
import { HostBackend } from '../../src/main/host-backend'
import type { Notifier } from '../../src/main/notifier'
import { PtyBridge } from '../../src/main/pty-bridge'
import { SessionManager } from '../../src/main/sessions/manager'
import { KeyedMutex } from '../../src/main/sessions/mutex'
import { Store } from '../../src/main/store'
import { claudeTmuxName } from '../../src/main/tmux'
import type { Project, SubProject, TermKind } from '../../src/shared/types'
import { makeTestEnv } from '../helpers/env'
import { alive, hostLaunch, stopHost } from '../helpers/host'
import { waitFor } from '../helpers/wait'

// The app's own path when its sessions' backend goes away (today's "tmux died"), with the host as the backend:
// the terminal ends, a key reopens it, the agent is relaunched in a new host and resumes its conversation.

let t: Awaited<ReturnType<typeof makeTestEnv>>
let store: Store
let backend: HostBackend
let managers: SessionManager[]
let bridges: PtyBridge[]
const notifier: Notifier = { notify: () => {}, setBadge: () => {} }

beforeEach(async () => {
  t = await makeTestEnv()
  t.env.STUB_CLAUDE_LOG = join(t.tmp, 'claude.log')
  backend = new HostBackend({ dataDir: t.paths.dataDir, appVersion: 'test', launch: hostLaunch(t.paths.dataDir, { env: t.env }) })
  managers = []
  bridges = []
  await mkdir(t.paths.sshDir, { recursive: true })
  const project: Project = {
    id: 'p_1', name: 'Proj', createdAt: 0, extraEnv: [],
    identity: { sshKeyPath: join(t.paths.sshDir, 'id_test'), ghAccount: 'dev-work', gitName: 'Jane', gitEmail: 'm@x.io' }
  }
  await writeFile(project.identity.sshKeyPath, 'fake')
  store = await Store.open(t.paths.stateFile)
  const folder = join(t.tmp, 'folder')
  await mkdir(folder)
  const sp: SubProject = { id: 'sp_1', projectId: 'p_1', name: 'Folder', kind: 'folder', path: folder, createdAt: 0 }
  await store.update((d) => {
    d.projects.push(project)
    d.subProjects.push(sp)
  })
})
afterEach(async () => {
  for (const b of bridges) b.dispose()
  for (const m of managers) m.dispose()
  backend.disconnect()
  await stopHost(t.paths.dataDir)
  await t.cleanup()
})

async function manager(): Promise<SessionManager> {
  const m = new SessionManager({
    store, paths: t.paths, git: new GitClient(exec, t.env), backend, exec, env: t.env, home: t.tmp,
    mutex: new KeyedMutex(), firstEventTimeoutMs: 8000, notifier
  })
  managers.push(m)
  await m.init()
  return m
}

function bridge(m: SessionManager): { b: PtyBridge; out: () => string; exits: Array<[string, TermKind, number]> } {
  let out = ''
  const exits: Array<[string, TermKind, number]> = []
  const b = new PtyBridge({
    backend, ensureTarget: (id, kind) => m.ensureTerminalTarget(id, kind),
    onData: (_i, _k, d) => { out += d }, onExit: (i, k, c) => { exits.push([i, k, c]) }, onUserInput: () => {}
  })
  bridges.push(b)
  return { b, out: () => out, exits }
}

const log = (): Promise<string> => readFile(t.env.STUB_CLAUDE_LOG, 'utf8').catch(() => '')

async function startSession(m: SessionManager): Promise<string> {
  const res = await m.start({ requestId: 'r', subProjectId: 'sp_1', title: 'Survivor', branchMode: 'new', branch: '' }, () => {})
  if (!res.ok) throw new Error(res.error)
  await waitFor(async () => (await log()).includes('--session-id'), 8000, 'first launch')
  return res.sessionId
}

test('the host dies: the open terminal ends, and a key relaunches the agent in a new host, resuming it', async () => {
  const m = await manager()
  const id = await startSession(m)
  const term = bridge(m)
  await term.b.open(id, 'claude', 100, 30)
  await waitFor(async () => term.out().includes('STUB CLAUDE READY'), 8000, 'replayed screen')
  const hostPid = backend.hostPid!
  const [launcherPid] = (await backend.processRoots(claudeTmuxName(id))).panePids

  process.kill(hostPid, 'SIGKILL')
  await waitFor(async () => term.exits.length === 1, 8000, 'terminal ended')
  expect(term.exits[0][0]).toBe(id)
  await waitFor(async () => !alive(launcherPid), 8000, 'the agent went with its host') // no orphaned agents

  await term.b.open(id, 'claude', 100, 30) // what "press any key to reattach" does
  await waitFor(async () => (await log()).includes('--resume'), 8000, 'relaunched with --resume')
  expect(backend.hostPid).not.toBe(hostPid)
  expect(await backend.hasSession(claudeTmuxName(id))).toBe(true)
  await waitFor(async () => term.out().split('STUB CLAUDE READY').length === 3, 8000, 'the relaunched agent on screen')
})

test('the app reopens after the host died: startup relaunches every session with --resume', async () => {
  const m1 = await manager()
  const id = await startSession(m1)
  m1.dispose()
  const hostPid = backend.hostPid!
  process.kill(hostPid, 'SIGKILL')
  await waitFor(async () => !alive(hostPid), 8000, 'host gone')
  backend.disconnect()

  const m2 = await manager()
  expect(await backend.hasSession(claudeTmuxName(id))).toBe(true)
  await waitFor(async () => (await log()).includes('--resume'), 8000, '--resume')
  expect(m2.snapshot().sessions).toHaveLength(1)
  expect(m2.snapshot().sessions[0].lastError).toBeUndefined()
})
