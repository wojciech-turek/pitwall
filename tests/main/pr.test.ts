import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { exec } from '../../src/main/exec'
import { PrPoller, failingChecks, fetchOpenThreads, fetchPr, parsePrUrl, summarizeChecks } from '../../src/main/pr'
import type { AppPaths } from '../../src/main/paths'
import type { SessionManager } from '../../src/main/sessions/manager'
import type { Store } from '../../src/main/store'
import type { GitClient } from '../../src/main/git'
import type { HookEvent, PersistedState, Session } from '../../src/shared/types'
import { waitFor } from '../helpers/wait'

const GH = resolve(__dirname, '../fixtures/bin/gh')
const dirs: string[] = []
afterEach(async () => { while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true }) })

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'pitwall-pr-'))
  dirs.push(d)
  return d
}

const PR = [{
  number: 123, url: 'https://github.com/o/r/pull/123', title: 'Fix tax', state: 'OPEN',
  updatedAt: '2026-10-30T10:00:00Z',
  statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }, { status: 'COMPLETED', conclusion: 'SUCCESS' }]
}]

describe('summarizeChecks', () => {
  test('rules', () => {
    expect(summarizeChecks([])).toBe('none')
    expect(summarizeChecks([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }])).toBe('passing')
    for (const c of ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']) {
      expect(summarizeChecks([{ status: 'COMPLETED', conclusion: c }])).toBe('failing')
    }
    expect(summarizeChecks([{ state: 'ERROR' }])).toBe('failing')
    expect(summarizeChecks([{ state: 'FAILURE' }])).toBe('failing')
    for (const s of ['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED']) {
      expect(summarizeChecks([{ status: s, conclusion: '' }])).toBe('pending')
    }
    expect(summarizeChecks([{ state: 'PENDING' }])).toBe('pending')
    expect(summarizeChecks([{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }])).toBe('failing')
  })
})

describe('fetchPr', () => {
  test('maps gh json and passes token via env', async () => {
    const d = await tmp()
    await writeFile(join(d, 'pr.json'), JSON.stringify(PR))
    const log = join(d, 'log')
    const env = { ...process.env, STUB_GH_PR_JSON: join(d, 'pr.json'), STUB_GH_LOG: log } as Record<string, string>
    const pr = await fetchPr({ ghBin: GH, cwd: d, branch: 'pitwall/x', token: 'sekret', exec, env })
    expect(pr).toEqual({
      number: 123, url: PR[0].url, title: 'Fix tax', state: 'OPEN', checks: 'failing', updatedAt: Date.parse(PR[0].updatedAt)
    })
    const logged = await readFile(log, 'utf8')
    expect(logged).toContain('pr list --head pitwall/x --state all')
    expect(logged).toContain('isDraft')
    expect(logged).toContain('GH_TOKEN=set')
    expect(logged).not.toContain('sekret')
    expect(logged).not.toContain('switch')
  })

  test('a draft PR is marked as one', async () => {
    const d = await tmp()
    await writeFile(join(d, 'pr.json'), JSON.stringify([{ ...PR[0], isDraft: true }]))
    const env = { ...process.env, STUB_GH_PR_JSON: join(d, 'pr.json') } as Record<string, string>
    expect(await fetchPr({ ghBin: GH, cwd: d, branch: 'b', token: 't', exec, env })).toMatchObject({ number: 123, draft: true })
  })

  test('no PR on the branch gives "none"; a failed lookup gives null', async () => {
    const d = await tmp()
    const env = { ...process.env } as Record<string, string>
    expect(await fetchPr({ ghBin: GH, cwd: d, branch: 'b', token: 't', exec, env })).toBe('none')
    const fail = async () => ({ code: 1, stdout: '', stderr: 'x' })
    expect(await fetchPr({ ghBin: GH, cwd: d, branch: 'b', token: 't', exec: fail, env })).toBeNull()
    const garbage = async () => ({ code: 0, stdout: 'not json', stderr: '' })
    expect(await fetchPr({ ghBin: GH, cwd: d, branch: 'b', token: 't', exec: garbage, env })).toBeNull()
  })
})

describe('failingChecks', () => {
  test('lists failed CheckRuns and StatusContexts, not passing or pending ones', () => {
    expect(failingChecks([
      { name: 'build', detailsUrl: 'u', status: 'COMPLETED', conclusion: 'FAILURE' },
      { context: 'ci/lint', targetUrl: 'v', state: 'ERROR' },
      { name: 'ok', detailsUrl: 'w', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'slow', status: 'IN_PROGRESS', conclusion: '' },
      { context: 'ci/wait', state: 'PENDING' },
      { name: 'bare', conclusion: 'TIMED_OUT' }
    ])).toEqual([{ name: 'build', url: 'u' }, { name: 'ci/lint', url: 'v' }, { name: 'bare' }])
  })
})

describe('parsePrUrl', () => {
  test('reads owner and repo from a GitHub PR url', () => {
    expect(parsePrUrl('https://github.com/o/r/pull/12')).toEqual({ owner: 'o', repo: 'r' })
    expect(parsePrUrl('https://gitlab.com/x')).toBeNull()
  })
})

describe('fetchOpenThreads', () => {
  const nodes = [
    { isResolved: false, isOutdated: false }, { isResolved: true, isOutdated: false },
    { isResolved: false, isOutdated: true }, { isResolved: false, isOutdated: false }
  ]
  const o = { ghBin: 'gh', cwd: '/w', token: 'tok', owner: 'o', repo: 'r', number: 12, env: { PATH: '/x' } }
  test('counts unresolved, current threads and sends the query as gh api graphql', async () => {
    const seen: { args: string[]; env?: Record<string, string> }[] = []
    const ex = async (_f: string, args: string[], opts?: { env?: Record<string, string> }) => {
      seen.push({ args, env: opts?.env })
      return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } }), stderr: '' }
    }
    expect(await fetchOpenThreads({ ...o, exec: ex })).toBe(2)
    expect(seen[0].args.slice(0, 2)).toEqual(['api', 'graphql'])
    expect(seen[0].args).toContain('owner=o')
    expect(seen[0].args).toContain('name=r')
    expect(seen[0].args).toContain('number=12')
    expect(seen[0].env?.GH_TOKEN).toBe('tok')
  })
  test('a failed gh, bad json or a missing path gives null', async () => {
    expect(await fetchOpenThreads({ ...o, exec: async () => ({ code: 1, stdout: '', stderr: 'x' }) })).toBeNull()
    expect(await fetchOpenThreads({ ...o, exec: async () => ({ code: 0, stdout: 'nope', stderr: '' }) })).toBeNull()
    expect(await fetchOpenThreads({ ...o, exec: async () => ({ code: 0, stdout: '{"data":{}}', stderr: '' }) })).toBeNull()
  })
})

function setup(o: { remote?: boolean; ghAccount?: string; pr?: Session['pr']; archived?: boolean; muted?: boolean } = {}) {
  const calls: { args: string[]; env?: Record<string, string> }[] = []
  let json: unknown[] = []
  let ghFails = false
  let threads: number | null = null
  const fakeExec = async (file: string, args: string[], opts?: { env?: Record<string, string> }) => {
    calls.push({ args, env: opts?.env })
    if (args[0] === 'auth') return { code: 0, stdout: 'tok\n', stderr: '' }
    if (ghFails) return { code: 1, stdout: '', stderr: 'offline' }
    if (args[0] === 'api') {
      if (threads === null) return { code: 1, stdout: '', stderr: 'graphql down' }
      const nodes = Array.from({ length: threads }, () => ({ isResolved: false, isOutdated: false }))
      return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } }), stderr: '' }
    }
    return { code: 0, stdout: JSON.stringify(json), stderr: '' }
  }
  const mk = (id: string): Session => ({
    id, subProjectId: 'sp', title: 'T ' + id, slug: id, claudeSessionId: 'c', cwd: '/w', worktreePath: '/w',
    branch: 'pitwall/' + id, branchCreatedByPitwall: true, createdAt: 0, lastViewedAt: 0,
    ...(o.pr && id === 's1' ? { pr: o.pr } : {}), ...(o.archived ? { archivedAt: 1 } : {})
  })
  const state = {
    projects: [{
      id: 'p', name: 'p', identity: { sshKeyPath: '', ghAccount: o.ghAccount ?? 'dev-work', gitName: '', gitEmail: '' }, extraEnv: [],
      createdAt: 0, ...(o.muted ? { muted: true } : {})
    }],
    subProjects: [{ id: 'sp', projectId: 'p', name: 'n', path: '/w', kind: 'repo', createdAt: 0 }],
    sessions: [mk('s1'), mk('s2')]
  } as unknown as PersistedState
  const store = {
    state,
    update: async (fn: (d: PersistedState) => void) => { fn(state) }
  } as unknown as Store
  const cbs: ((id: string, ev: HookEvent) => void)[] = []
  const manager = {
    onSessionEvent: (cb: (id: string, ev: HookEvent) => void) => { cbs.push(cb); return () => { cbs.splice(cbs.indexOf(cb), 1) } },
    snapshot: () => ({ sessions: [] })
  } as unknown as SessionManager
  const git = { hasRemote: async () => o.remote ?? true } as unknown as GitClient
  const notes: { sessionId: string; title: string; body: string }[] = []
  const notifier = { notify: (n: { sessionId: string; title: string; body: string }) => { notes.push(n) }, setBadge: () => {} }
  const poller = new PrPoller({
    store, manager, git, exec: fakeExec, env: { PATH: '/x' }, paths: { ghBin: 'gh' } as AppPaths,
    notifier, intervalMs: 60_000, debounceMs: 20
  })
  const emit = (id: string, e: string) => cbs.forEach((cb) => cb(id, { c: id, t: 1, e }))
  return { poller, calls, notes, state, emit, setJson: (j: unknown[]) => { json = j }, setGhFails: (f: boolean) => { ghFails = f }, setThreads: (n: number | null) => { threads = n } }
}

describe('PrPoller.feedbackContext', () => {
  const OPEN = { number: 12, url: 'https://github.com/o/r/pull/12', title: 't', state: 'OPEN' as const, checks: 'failing' as const, updatedAt: 0 }
  test('gives the dir, token, repo and PR', async () => {
    const t = setup({ pr: OPEN })
    expect(await t.poller.feedbackContext('s1')).toEqual({ ok: true, dir: '/w', token: 'tok', owner: 'o', repo: 'r', pr: OPEN })
  })
  test('plain messages for each failure', async () => {
    expect(await setup({ pr: OPEN, ghAccount: '' }).poller.feedbackContext('s1')).toEqual({ ok: false, message: 'This project has no GitHub account set.' })
    expect(await setup({ pr: OPEN }).poller.feedbackContext('s2')).toEqual({ ok: false, message: 'This session has no pull request.' })
    expect(await setup({ pr: OPEN }).poller.feedbackContext('nope')).toEqual({ ok: false, message: 'This session has no pull request.' })
    expect(await setup({ pr: { ...OPEN, url: 'https://example.com/x' } }).poller.feedbackContext('s1'))
      .toEqual({ ok: false, message: "Couldn't tell which GitHub repo the PR is in." })
    const bad = setup({ pr: OPEN })
    ;(bad.poller as unknown as { deps: { exec: unknown } }).deps.exec = async () => ({ code: 1, stdout: '', stderr: '' })
    expect(await bad.poller.feedbackContext('s1')).toEqual({ ok: false, message: "Couldn't get a GitHub token for dev-work." })
  })
})

const listCalls = <T extends { args: string[] }>(c: T[]) => c.filter((x) => x.args[0] === 'pr')

describe('PrPoller', () => {
  test('no remote → no gh call', async () => {
    const t = setup({ remote: false })
    t.setJson(PR)
    t.poller.start()
    await new Promise((r) => setTimeout(r, 150))
    t.poller.stop()
    expect(t.calls).toEqual([])
  })

  test('no ghAccount → no gh call', async () => {
    const t = setup({ ghAccount: '' })
    t.setJson(PR)
    t.poller.start()
    await new Promise((r) => setTimeout(r, 150))
    t.poller.stop()
    expect(t.calls).toEqual([])
  })

  test('stores pr once, uses cached token, passes GH_TOKEN in env only', async () => {
    const t = setup()
    t.setJson(PR)
    t.poller.start()
    await waitFor(async () => t.state.sessions.every((s) => s.pr))
    expect(t.state.sessions[0].pr).toMatchObject({ number: 123, checks: 'failing', state: 'OPEN' })
    expect(t.calls.filter((c) => c.args[0] === 'auth')).toHaveLength(1)
    const pr = listCalls(t.calls)[0]
    expect(pr.env?.GH_TOKEN).toBe('tok')
    expect(pr.args.join(' ')).not.toContain('tok')
    t.poller.stop()
  })

  test('archived sessions are skipped', async () => {
    const t = setup({ archived: true })
    t.setJson(PR)
    t.poller.start()
    await new Promise((r) => setTimeout(r, 150))
    t.poller.stop()
    expect(listCalls(t.calls)).toHaveLength(0)
  })

  test('refreshSoon debounces repeated Stop events', async () => {
    const t = setup()
    t.poller.start()
    await new Promise((r) => setTimeout(r, 100))
    const before = listCalls(t.calls).length
    t.setJson(PR)
    t.emit('s1', 'Stop'); t.emit('s1', 'Stop'); t.emit('s1', 'Stop')
    await waitFor(async () => t.state.sessions[0].pr)
    expect(listCalls(t.calls).length - before).toBe(1)
    t.poller.stop()
  })

  test('merged transition notifies once; first discovery of merged does not', async () => {
    const openPr = { number: 5, url: 'u', title: 'Ship it', state: 'OPEN' as const, checks: 'passing' as const, updatedAt: 1 }
    const t = setup({ pr: openPr })
    t.setJson([{ number: 5, url: 'u', title: 'Ship it', state: 'MERGED', updatedAt: '2026-10-30T10:00:00Z', statusCheckRollup: [] }])
    t.poller.start()
    await waitFor(async () => t.state.sessions[0].pr?.state === 'MERGED')
    await waitFor(async () => t.state.sessions[1].pr)
    t.poller.stop()
    expect(t.notes).toHaveLength(1)
    expect(t.notes[0]).toMatchObject({ sessionId: 's1', title: 'PR #5 merged', body: 'Archive "T s1"?' })

    const t2 = setup()
    t2.setJson([{ number: 6, url: 'u', title: 'Old', state: 'MERGED', updatedAt: '2026-10-30T10:00:00Z', statusCheckRollup: [] }])
    t2.poller.start()
    await waitFor(async () => t2.state.sessions.every((s) => s.pr))
    t2.poller.stop()
    expect(t2.notes).toEqual([])
  })

  test('a muted project gets no "PR merged" notification, but its PR badge still updates', async () => {
    const openPr = { number: 5, url: 'u', title: 'Ship it', state: 'OPEN' as const, checks: 'passing' as const, updatedAt: 1 }
    const t = setup({ pr: openPr, muted: true })
    t.setJson([{ number: 5, url: 'u', title: 'Ship it', state: 'MERGED', updatedAt: '2026-10-30T10:00:00Z', statusCheckRollup: [] }])
    t.poller.start()
    await waitFor(async () => t.state.sessions[0].pr?.state === 'MERGED')
    await waitFor(async () => t.state.sessions[1].pr)
    t.poller.stop()
    expect(t.notes).toEqual([])
  })

  test('stop clears timers and subscription', async () => {
    const t = setup()
    t.poller.start()
    await new Promise((r) => setTimeout(r, 100))
    t.poller.stop()
    const n = t.calls.length
    t.emit('s1', 'Stop')
    await new Promise((r) => setTimeout(r, 100))
    expect(t.calls.length).toBe(n)
  })

  test('a session whose branch has no PR loses the PR it had (it moved to a new branch after a merge)', async () => {
    const merged = { number: 5, url: 'u', title: 'Ship it', state: 'MERGED' as const, checks: 'none' as const, updatedAt: 1 }
    const t = setup({ pr: merged })
    t.setJson([])
    t.poller.start()
    await waitFor(async () => t.state.sessions[0].pr === undefined)
    t.poller.stop()
    expect('pr' in t.state.sessions[0]).toBe(false)
    expect(t.notes).toEqual([])
  })

  test('a failed lookup keeps the PR the session had', async () => {
    const merged = { number: 5, url: 'u', title: 'Ship it', state: 'MERGED' as const, checks: 'none' as const, updatedAt: 1 }
    const t = setup({ pr: merged })
    t.setGhFails(true)
    t.poller.start()
    await waitFor(async () => listCalls(t.calls).length >= 2)
    t.poller.stop()
    expect(t.state.sessions[0].pr).toEqual(merged)
  })

  test('a PR leaving draft updates the stored PR', async () => {
    const draft = { number: 7, url: 'u', title: 'WIP', state: 'OPEN' as const, checks: 'pending' as const, updatedAt: 1, draft: true }
    const t = setup({ pr: draft })
    t.setJson([{ number: 7, url: 'u', title: 'WIP', state: 'OPEN', isDraft: false, updatedAt: '2026-10-30T10:00:00Z',
      statusCheckRollup: [{ status: 'IN_PROGRESS' }] }])
    t.poller.start()
    await waitFor(async () => t.state.sessions[0].pr?.draft !== true)
    t.poller.stop()
    expect(t.state.sessions[0].pr).toMatchObject({ number: 7, checks: 'pending' })
    expect(t.state.sessions[0].pr?.draft).toBeUndefined()
  })

  test('checks turning failing notify once; a muted project gets nothing', async () => {
    const passing = { number: 9, url: 'https://github.com/o/r/pull/9', title: 'X', state: 'OPEN' as const, checks: 'passing' as const, updatedAt: 1 }
    const failingJson = [{ number: 9, url: passing.url, title: 'X', state: 'OPEN', updatedAt: '2026-10-30T10:00:00Z',
      statusCheckRollup: [{ name: 'build', detailsUrl: 'u', status: 'COMPLETED', conclusion: 'FAILURE' }] }]
    const t = setup({ pr: passing })
    t.setJson(failingJson)
    t.poller.start()
    await waitFor(async () => t.state.sessions[0].pr?.checks === 'failing' && !!t.state.sessions[1].pr)
    t.poller.stop()
    expect(t.state.sessions[0].pr?.failing).toEqual([{ name: 'build', url: 'u' }])
    expect(t.notes.filter((n) => n.sessionId === 's1' && n.title === 'PR #9: checks failing')).toHaveLength(1)
    expect(t.notes.find((n) => n.sessionId === 's1')).toMatchObject({ body: 'T s1' })

    const m = setup({ pr: passing, muted: true })
    m.setJson(failingJson)
    m.poller.start()
    await waitFor(async () => m.state.sessions[0].pr?.checks === 'failing')
    m.poller.stop()
    expect(m.notes).toEqual([])
  })

  test('open review threads are stored, new ones notify, and a failed lookup keeps the old count', async () => {
    const before = { number: 9, url: 'https://github.com/o/r/pull/9', title: 'X', state: 'OPEN' as const, checks: 'none' as const, updatedAt: 1, openThreads: 1 }
    const json = [{ number: 9, url: before.url, title: 'X', state: 'OPEN', updatedAt: '2026-10-30T10:00:00Z', statusCheckRollup: [] }]
    const t = setup({ pr: before })
    t.setJson(json)
    t.setThreads(3)
    t.poller.start()
    await waitFor(async () => t.state.sessions[0].pr?.openThreads === 3)
    t.poller.stop()
    expect(t.notes.filter((n) => n.sessionId === 's1')).toEqual([{ sessionId: 's1', title: 'PR #9: new review comments', body: 'T s1' }])

    const k = setup({ pr: { ...before, title: 'old title' } })
    k.setJson(json)
    k.setThreads(null)
    k.poller.start()
    await waitFor(async () => k.state.sessions[0].pr?.title === 'X')
    k.poller.stop()
    expect(k.state.sessions[0].pr?.openThreads).toBe(1)
    expect(k.notes).toEqual([])
  })
})
