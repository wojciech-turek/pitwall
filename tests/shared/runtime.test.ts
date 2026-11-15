import { describe, expect, test } from 'vitest'
import {
  countStatuses, displayStatus, initialRuntime, nextAttention, reduceRuntime, sessionDepth, sidebarOrder, STATUS_LABEL
} from '../../src/shared/runtime'
import type { HookEvent, SessionRuntime } from '../../src/shared/types'

const E = (e: string, x: Partial<HookEvent> = {}): HookEvent => ({ c: 's', t: 100, e, ...x })
const rt = (x: Partial<SessionRuntime>): SessionRuntime => ({ ...initialRuntime, ...x })
const r = (s: SessionRuntime, e: string, x: Partial<HookEvent> = {}) => reduceRuntime(s, E(e, x))

describe('reduceRuntime', () => {
  test('SessionStart', () => {
    expect(r(rt({ activity: 'starting' }), 'SessionStart', { src: 'startup' }).activity).toBe('idle')
    expect(r(rt({ activity: 'working' }), 'SessionStart', { src: 'compact' }).activity).toBe('working')
  })
  test('UserPromptSubmit', () => {
    const o = r(rt({ activity: 'needs_input', needsInput: 'other', lastError: 'x' }), 'UserPromptSubmit')
    expect(o).toMatchObject({ activity: 'working' })
    expect(o.needsInput).toBeUndefined()
    expect(o.lastError).toBeUndefined()
  })
  test('PreToolUse', () => {
    expect(r(rt({ activity: 'idle' }), 'PreToolUse', { tool: 'Bash' }).activity).toBe('working')
    expect(r(rt({ activity: 'working' }), 'PreToolUse', { tool: 'AskUserQuestion' })).toMatchObject({ activity: 'needs_input', needsInput: 'question' })
  })
  test('PermissionRequest', () => {
    expect(r(rt({ activity: 'working' }), 'PermissionRequest', { tool: 'Bash' })).toMatchObject({ activity: 'needs_input', needsInput: 'permission' })
    // Observed in Claude Code 2.1.314: AskUserQuestion also raises a PermissionRequest; it stays a question.
    expect(r(rt({ activity: 'needs_input', needsInput: 'question' }), 'PermissionRequest', { tool: 'AskUserQuestion' }))
      .toMatchObject({ activity: 'needs_input', needsInput: 'question' })
    expect(r(rt({ activity: 'working' }), 'PermissionRequest', { tool: 'AskUserQuestion' })).toMatchObject({ needsInput: 'question' })
  })
  test('PostToolUse and PostToolUseFailure', () => {
    for (const e of ['PostToolUse', 'PostToolUseFailure']) {
      const o = r(rt({ activity: 'needs_input', needsInput: 'permission' }), e)
      expect(o.activity).toBe('working')
      expect(o.needsInput).toBeUndefined()
    }
  })
  test('Notification', () => {
    expect(r(rt({ activity: 'working' }), 'Notification', { nt: 'permission_prompt' })).toMatchObject({ activity: 'needs_input', needsInput: 'permission' })
    // permission_prompt carries no tool and follows a PermissionRequest ~6 s later: keep the reason already known.
    expect(r(rt({ activity: 'needs_input', needsInput: 'question' }), 'Notification', { nt: 'permission_prompt' }))
      .toMatchObject({ activity: 'needs_input', needsInput: 'question' })
    for (const nt of ['elicitation_dialog', 'agent_needs_input'])
      expect(r(rt({ activity: 'working' }), 'Notification', { nt })).toMatchObject({ activity: 'needs_input', needsInput: 'other' })
    expect(r(rt({ activity: 'working' }), 'Notification', { nt: 'idle_prompt', t: 555 })).toMatchObject({ activity: 'idle', lastFinishedAt: 555 })
    expect(r(rt({ activity: 'needs_input', needsInput: 'other' }), 'Notification', { nt: 'idle_prompt', t: 556 })).toMatchObject({ activity: 'idle', lastFinishedAt: 556 })
    const idle = rt({ activity: 'idle', lastFinishedAt: 5 })
    expect(r(idle, 'Notification', { nt: 'idle_prompt', t: 999 }).lastFinishedAt).toBe(5)
    expect(r(rt({ activity: 'working' }), 'Notification', { nt: 'auth_success' }).activity).toBe('working')
  })
  test('Stop', () => {
    const o = r(rt({ activity: 'needs_input', needsInput: 'other', lastError: 'old' }), 'Stop', { t: 300, msg: 'done' })
    expect(o).toMatchObject({ activity: 'idle', lastFinishedAt: 300, lastMessage: 'done' })
    expect(o.needsInput).toBeUndefined()
    expect(o.lastError).toBeUndefined()
    const n = r(rt({ activity: 'working', lastMessage: 'stale' }), 'Stop', { t: 301, msg: null })
    expect(n).toMatchObject({ activity: 'idle', lastFinishedAt: 301 })
    expect('lastMessage' in n).toBe(false)
  })
  test('StopFailure', () => {
    const o = r(rt({ activity: 'working', lastMessage: 'old reply' }), 'StopFailure', { t: 400, err: 'boom' })
    expect(o).toMatchObject({ activity: 'idle', lastFinishedAt: 400, lastError: 'boom' })
    expect('lastMessage' in o).toBe(false)
    expect(r(rt({ activity: 'working', lastError: 'stale' }), 'StopFailure', { t: 401, err: null }).lastError).toBe('Claude stopped with an error')
  })
  test('SessionEnd', () => {
    expect(r(rt({ activity: 'working' }), 'SessionEnd', { reason: 'clear' }).activity).toBe('working')
    expect(r(rt({ activity: 'working' }), 'SessionEnd', { reason: 'resume' }).activity).toBe('working')
    expect(r(rt({ activity: 'working' }), 'SessionEnd', { reason: 'logout' }).activity).toBe('exited')
  })
  test('pitwall:launch', () => {
    const o = r(rt({ activity: 'exited', exitCode: 1 }), 'pitwall:launch')
    expect(o.activity).toBe('starting')
    expect(o.exitCode).toBeUndefined()
  })
  test('pitwall:warning: one per kind, until the next launch; never counts as Claude reporting in', () => {
    let o = r(initialRuntime, 'pitwall:warning', { kind: 'gh', msg: 'signed out' })
    o = reduceRuntime(o, E('pitwall:warning', { kind: 'setup', msg: 'setup failed' }))
    o = reduceRuntime(o, E('pitwall:warning', { kind: 'gh', msg: 'signed out again' }))
    expect(o.warnings).toEqual({ gh: 'signed out again', setup: 'setup failed' })
    expect(o.firstEventSeen).toBe(false)
    expect(o.activity).toBe('starting')
    expect(reduceRuntime(o, E('pitwall:launch', { mode: 'resume' })).warnings).toBeUndefined()
    expect(reduceRuntime(o, E('SessionStart', { src: 'startup' })).warnings).toEqual(o.warnings)
    expect(r(initialRuntime, 'pitwall:warning', { kind: 'x' }).warnings).toBeUndefined() // no message: nothing
  })
  test('pitwall:exited', () => {
    expect(r(rt({ activity: 'working' }), 'pitwall:exited', { code: 3 })).toMatchObject({ activity: 'exited', exitCode: 3 })
  })
  test('pitwall:user-esc', () => {
    expect(r(rt({ activity: 'working', lastFinishedAt: 7 }), 'pitwall:user-esc')).toMatchObject({ activity: 'idle', lastFinishedAt: 7 })
    expect(r(rt({ activity: 'needs_input', needsInput: 'other' }), 'pitwall:user-esc').activity).toBe('idle')
    expect(r(rt({ activity: 'exited' }), 'pitwall:user-esc').activity).toBe('exited')
  })
  test('pitwall:user-input', () => {
    const o = r(rt({ activity: 'needs_input', needsInput: 'permission' }), 'pitwall:user-input')
    expect(o.activity).toBe('working')
    expect(o.needsInput).toBeUndefined()
    expect(r(rt({ activity: 'idle' }), 'pitwall:user-input').activity).toBe('idle')
  })
  test('sid updates claudeSessionId', () => {
    expect(r(initialRuntime, 'PreToolUse', { sid: 'abc' }).claudeSessionId).toBe('abc')
    expect(r(rt({ claudeSessionId: 'old' }), 'PreToolUse').claudeSessionId).toBe('old')
  })
  test('firstEventSeen only on non-pitwall events; lastEventAt set', () => {
    expect(r(initialRuntime, 'pitwall:launch').firstEventSeen).toBe(false)
    const o = r(initialRuntime, 'SessionStart', { t: 42 })
    expect(o.firstEventSeen).toBe(true)
    expect(o.lastEventAt).toBe(42)
  })
  test('does not mutate input', () => {
    const s = rt({ activity: 'working' })
    const copy = { ...s }
    r(s, 'Stop')
    expect(s).toEqual(copy)
    expect(initialRuntime).toEqual({ activity: 'starting', firstEventSeen: false })
  })
})

describe('observed Claude Code 2.1.314 sequences', () => {
  const fold = (evs: [string, Partial<HookEvent>?][], from: SessionRuntime = rt({ activity: 'idle', firstEventSeen: true })) =>
    evs.reduce((s, [e, x], i) => reduceRuntime(s, E(e, { t: 1000 + i, ...x })), from)
  const asking: [string, Partial<HookEvent>?][] = [
    ['UserPromptSubmit'], ['PreToolUse', { tool: 'Bash' }], ['PermissionRequest', { tool: 'Bash' }], ['Notification', { nt: 'permission_prompt' }]
  ]
  test('Bash permission prompt → Needs you (permission); approving → Working → Stop', () => {
    expect(fold(asking)).toMatchObject({ activity: 'needs_input', needsInput: 'permission' })
    const done = fold([...asking, ['PostToolUse', { tool: 'Bash' }], ['Stop', { msg: 'ok' }]])
    expect(done).toMatchObject({ activity: 'idle', lastMessage: 'ok' })
    expect(done.needsInput).toBeUndefined()
  })
  test('AskUserQuestion → Needs you (question) despite its PermissionRequest/permission_prompt; answering → Working', () => {
    const q: [string, Partial<HookEvent>?][] = [
      ['UserPromptSubmit'], ['PreToolUse', { tool: 'AskUserQuestion' }], ['PermissionRequest', { tool: 'AskUserQuestion' }],
      ['Notification', { nt: 'permission_prompt' }]
    ]
    expect(fold(q)).toMatchObject({ activity: 'needs_input', needsInput: 'question' })
    expect(fold([...q, ['PostToolUse', { tool: 'AskUserQuestion' }]]).activity).toBe('working')
  })
  test('Esc on a prompt or mid-turn fires no hook: only pitwall:user-esc ends Needs you / Working', () => {
    expect(fold([...asking.slice(0, 3), ['pitwall:user-esc']]).activity).toBe('idle')
    expect(fold([['UserPromptSubmit'], ['pitwall:user-esc']]).activity).toBe('idle')
  })
  test('/clear: SessionEnd(clear) then SessionStart(clear) with a new sid → idle, new claudeSessionId', () => {
    const o = fold([['SessionEnd', { reason: 'clear', sid: 'old' }], ['SessionStart', { src: 'clear', sid: 'new' }]], rt({ activity: 'idle', claudeSessionId: 'old' }))
    expect(o).toMatchObject({ activity: 'idle', claudeSessionId: 'new' })
  })
  test('/exit: SessionEnd(prompt_input_exit) → exited', () => {
    expect(fold([['SessionEnd', { reason: 'prompt_input_exit' }]]).activity).toBe('exited')
  })
})

describe('selectors', () => {
  test('displayStatus unread vs read', () => {
    expect(displayStatus(rt({ activity: 'idle', lastFinishedAt: 200 }), 100)).toBe('unread')
    expect(displayStatus(rt({ activity: 'idle', lastFinishedAt: 200 }), 300)).toBe('read')
    expect(displayStatus(rt({ activity: 'idle' }), 0)).toBe('read')
    expect(displayStatus(rt({ activity: 'working' }), 0)).toBe('working')
    expect(displayStatus(rt({ activity: 'needs_input' }), 0)).toBe('needs_you')
    expect(displayStatus(rt({ activity: 'exited' }), 0)).toBe('exited')
    expect(displayStatus(rt({ activity: 'starting' }), 0)).toBe('starting')
  })
  test('STATUS_LABEL', () => {
    expect(STATUS_LABEL).toEqual({ starting: 'Starting', working: 'Working', needs_you: 'Needs you', unread: 'Unread', read: 'Read', exited: 'Exited' })
  })
  test('countStatuses', () => {
    expect(countStatuses([{ status: 'working' }, { status: 'needs_you' }, { status: 'unread' }, { status: 'unread' }, { status: 'read' }]))
      .toEqual({ needsYou: 1, unread: 2, working: 1 })
  })
  test('nextAttention prefers needs_you, wraps, falls back to unread, else null', () => {
    const o = (xs: [string, any][]) => xs.map(([id, status]) => ({ id, status }))
    const l = o([['a', 'needs_you'], ['b', 'read'], ['c', 'unread'], ['d', 'needs_you']])
    expect(nextAttention(l, 'a')).toBe('d')
    expect(nextAttention(l, 'd')).toBe('a')
    expect(nextAttention(l, null)).toBe('a')
    expect(nextAttention(o([['a', 'read'], ['b', 'unread'], ['c', 'read']]), 'b')).toBeNull()
    expect(nextAttention(o([['a', 'read'], ['b', 'unread'], ['c', 'read']]), 'a')).toBe('b')
    expect(nextAttention(o([['a', 'needs_you']]), 'a')).toBeNull()
    expect(nextAttention(o([['a', 'working']]), null)).toBeNull()
    expect(nextAttention(o([['a', 'unread'], ['b', 'needs_you']]), 'b')).toBe('a')
  })
  test('sidebarOrder', () => {
    const p = (id: string, createdAt: number) => ({ id, createdAt }) as any
    const sp = (id: string, projectId: string, name: string) => ({ id, projectId, name }) as any
    const s = (id: string, subProjectId: string, createdAt: number) => ({ id, subProjectId, createdAt }) as any
    const out = sidebarOrder({
      projects: [p('p2', 20), p('p1', 10)],
      subProjects: [sp('b', 'p1', 'beta'), sp('a', 'p1', 'Alpha'), sp('c', 'p2', 'c')],
      sessions: [s('s3', 'c', 1), s('s2', 'a', 9), s('s1', 'a', 5), s('s4', 'b', 1)]
    })
    expect(out.map((x) => x.id)).toEqual(['s1', 's2', 's4', 's3'])
  })

  test('sidebarOrder: pinned sessions come first within their folder, then by creation', () => {
    const s = (id: string, subProjectId: string, createdAt: number, pinned?: boolean) =>
      ({ id, subProjectId, createdAt, ...(pinned ? { pinned } : {}) }) as any
    const out = sidebarOrder({
      projects: [{ id: 'p1', createdAt: 1 } as any],
      subProjects: [{ id: 'a', projectId: 'p1', name: 'a' } as any, { id: 'b', projectId: 'p1', name: 'b' } as any],
      sessions: [s('a1', 'a', 1), s('a2', 'a', 2, true), s('a3', 'a', 3), s('a4', 'a', 4, true), s('b1', 'b', 1), s('b2', 'b', 2, true)]
    })
    // A pinned session never leaves its folder: b2 stays under b.
    expect(out.map((x) => x.id)).toEqual(['a2', 'a4', 'a1', 'a3', 'b2', 'b1'])
  })
})

describe('sessions under the one that started them', () => {
  const snap = (sessions: any[]) => ({
    projects: [{ id: 'p1', createdAt: 1 } as any], subProjects: [{ id: 'f', projectId: 'p1', name: 'f' } as any],
    sessions: sessions.map((x) => ({ subProjectId: 'f', ...x }))
  })
  const ids = (sessions: any[]) => sidebarOrder(snap(sessions)).map((x) => x.id)

  test('children come right after their parent, recursively, each level in its own order', () => {
    expect(ids([
      { id: 'X', createdAt: 1 }, { id: 'P', createdAt: 2 }, { id: 'C2', createdAt: 5, createdBy: 'P' },
      { id: 'G', createdAt: 9, createdBy: 'C1' }, { id: 'C1', createdAt: 3, createdBy: 'P' }
    ])).toEqual(['X', 'P', 'C1', 'G', 'C2'])
  })
  test('a pinned child stays under its parent; pinning orders siblings only', () => {
    expect(ids([
      { id: 'P', createdAt: 2 }, { id: 'Q', createdAt: 3 }, { id: 'C1', createdAt: 4, createdBy: 'P' },
      { id: 'C2', createdAt: 5, createdBy: 'P', pinned: true }
    ])).toEqual(['P', 'C2', 'C1', 'Q'])
  })
  test('a child whose parent is not listed sorts as a normal session', () => {
    expect(ids([
      { id: 'C1', createdAt: 3, createdBy: 'P' }, { id: 'C2', createdAt: 1, createdBy: 'gone' }, { id: 'Z', createdAt: 2 }
    ])).toEqual(['C2', 'Z', 'C1'])
  })
  test('a loop in createdBy still lists every session once', () => {
    const out = ids([
      { id: 'A', createdAt: 1, createdBy: 'B' }, { id: 'B', createdAt: 2, createdBy: 'A' },
      { id: 'S', createdAt: 3, createdBy: 'S' }, { id: 'T', createdAt: 4 }
    ])
    expect([...out].sort()).toEqual(['A', 'B', 'S', 'T'])
  })
  test('sessionDepth counts live ancestors, capped at 3', () => {
    const list = [
      { id: 'a' }, { id: 'b', createdBy: 'a' }, { id: 'c', createdBy: 'b' }, { id: 'd', createdBy: 'c' },
      { id: 'e', createdBy: 'd' }, { id: 'o', createdBy: 'gone' }, { id: 'x', createdBy: 'y' }, { id: 'y', createdBy: 'x' }
    ] as any[]
    const byId = new Map(list.map((x) => [x.id, x]))
    const live = new Set(list.map((x) => x.id))
    const d = (id: string) => sessionDepth(byId.get(id), live, byId)
    expect([d('a'), d('b'), d('c'), d('d'), d('e'), d('o'), d('x')]).toEqual([0, 1, 2, 3, 3, 0, 3])
  })
})

describe('subagent runs', () => {
  const started = (aid = 'a', at = 'Explore') => r(r(rt({ activity: 'working' }), 'Stop'), 'SubagentStart', { aid, at, t: 200 })
  test('SubagentStart adds a running run and leaves activity alone', () => {
    const o = started()
    expect(o.activity).toBe('idle')
    expect(o.subagents).toEqual([{ id: 'a', type: 'Explore', state: 'running', startedAt: 200 }])
  })
  test('internal agents (empty type) never show', () => {
    expect(r(rt({}), 'SubagentStart', { aid: 'x', at: '' }).subagents).toBeUndefined()
  })
  test('the same aid starting again updates the run', () => {
    const done = r(started(), 'SubagentStop', { aid: 'a', t: 300 })
    const o = r(done, 'SubagentStart', { aid: 'a', at: 'Explore', t: 400 })
    expect(o.subagents).toHaveLength(1)
    expect(o.subagents![0]).toMatchObject({ state: 'running', startedAt: 200 })
    expect(o.subagents![0].endedAt).toBeUndefined()
  })
  test('a tool call inside a subagent records lastTool and keeps the parent idle', () => {
    const o = r(started(), 'PreToolUse', { aid: 'a', tool: 'Bash' })
    expect(o.activity).toBe('idle')
    expect(o.subagents![0].lastTool).toBe('Bash')
  })
  test('a background subagent outlives the parent Stop', () => {
    const o = r(r(rt({ activity: 'working' }), 'SubagentStart', { aid: 'a', at: 'Explore' }), 'Stop', { t: 500 })
    expect(o.activity).toBe('idle')
    expect(o.subagents![0].state).toBe('running')
    expect(displayStatus(o, 0)).toBe('unread')
  })
  test('a permission prompt inside a subagent needs you; Post* clears the run', () => {
    const o = r(started(), 'PermissionRequest', { aid: 'a', tool: 'Bash' })
    expect(o).toMatchObject({ activity: 'needs_input', needsInput: 'permission' })
    expect(o.subagents![0].needsYou).toBe(true)
    const p = r(o, 'PostToolUse', { aid: 'a', tool: 'Bash' })
    expect(p.subagents![0].needsYou).toBe(false)
    expect(p.activity).toBe('idle')
    expect(p.needsInput).toBeUndefined()
    expect(p.resumeActivity).toBeUndefined()
  })
  test('a background subagent answered: the parent returns to unread', () => {
    const o = r(started(), 'PermissionRequest', { aid: 'a', tool: 'Bash' })
    const p = r(o, 'PostToolUse', { aid: 'a', tool: 'Bash' })
    expect(displayStatus(p, 0)).toBe('unread')
  })
  test('the same with a typed answer in between', () => {
    const o = r(started(), 'PermissionRequest', { aid: 'a', tool: 'Bash' })
    const w = r(o, 'pitwall:user-input')
    expect(w.activity).toBe('working')
    expect(r(w, 'PostToolUse', { aid: 'a', tool: 'Bash' }).activity).toBe('idle')
  })
  test('a foreground subagent answered: the parent goes back to working', () => {
    let o = r(rt({ activity: 'idle' }), 'UserPromptSubmit')
    o = r(o, 'SubagentStart', { aid: 'a', at: 'Explore' })
    o = r(o, 'PermissionRequest', { aid: 'a', tool: 'Bash' })
    expect(o.activity).toBe('needs_input')
    expect(r(o, 'PostToolUse', { aid: 'a' }).activity).toBe('working')
  })
  test('two runs needing you: the parent resumes only after both', () => {
    let o = r(r(started(), 'SubagentStart', { aid: 'b', at: 'Plan' }), 'PermissionRequest', { aid: 'a', tool: 'Bash' })
    o = r(o, 'PermissionRequest', { aid: 'b', tool: 'Bash' })
    o = r(o, 'PostToolUse', { aid: 'a' })
    expect(o.activity).toBe('needs_input')
    expect(r(o, 'PostToolUse', { aid: 'b' }).activity).toBe('idle')
  })
  test('a parent event while a subagent question is pending drops the resume', () => {
    const o = r(r(started(), 'PermissionRequest', { aid: 'a', tool: 'Bash' }), 'UserPromptSubmit')
    expect(o.resumeActivity).toBeUndefined()
  })
  test('a permission Notification inside a subagent needs you; idle_prompt does not', () => {
    const o = r(started(), 'Notification', { aid: 'a', nt: 'permission_prompt' })
    expect(o.activity).toBe('needs_input')
    expect(o.subagents![0].needsYou).toBe(true)
    expect(r(started(), 'Notification', { aid: 'a', nt: 'idle_prompt' }).activity).toBe('idle')
  })
  test('SubagentStop marks the run done; unknown ids are ignored', () => {
    const o = r(started(), 'SubagentStop', { aid: 'a', msg: 'found it', t: 300 })
    expect(o.subagents![0]).toMatchObject({ state: 'done', endedAt: 300, lastMessage: 'found it', needsYou: false })
    expect(r(o, 'SubagentStop', { aid: 'zz' }).subagents).toEqual(o.subagents)
  })
  test('the Agent tool description goes to the next run', () => {
    const o = r(rt({ activity: 'working' }), 'PreToolUse', { tool: 'Agent', desc: 'Find things' })
    expect(o.activity).toBe('working')
    expect(o.agentDescs).toEqual(['Find things'])
    const s = r(o, 'SubagentStart', { aid: 'a', at: 'Explore' })
    expect(s.subagents![0].description).toBe('Find things')
    expect(s.agentDescs).toEqual([])
  })
  test('agentDescs keep the newest 20, runs the newest 30', () => {
    let o = rt({})
    for (let i = 0; i < 25; i++) o = r(o, 'PreToolUse', { tool: 'Agent', desc: `d${i}` })
    expect(o.agentDescs).toHaveLength(20)
    expect(o.agentDescs![0]).toBe('d5')
    let q = rt({})
    for (let i = 0; i < 35; i++) q = r(q, 'SubagentStart', { aid: `a${i}`, at: 'X' })
    expect(q.subagents).toHaveLength(30)
    expect(q.subagents![0].id).toBe('a5')
  })
  test('UserPromptSubmit drops done runs only', () => {
    const two = r(started('b'), 'SubagentStart', { aid: 'c', at: 'Plan' })
    const o = r(r(two, 'SubagentStop', { aid: 'b' }), 'UserPromptSubmit')
    expect(o.subagents!.map((x) => x.id)).toEqual(['c'])
  })
  test('SessionStart (not compact) and pitwall:exited clear runs and descs', () => {
    const base = { ...started(), agentDescs: ['x'] }
    expect(r(base, 'SessionStart', { src: 'compact' }).subagents).toHaveLength(1)
    for (const o of [r(base, 'SessionStart', { src: 'startup' }), r(base, 'pitwall:exited')]) {
      expect(o.subagents).toBeUndefined()
      expect(o.agentDescs).toBeUndefined()
    }
  })
  test('the reducer does not mutate the old runs', () => {
    const before = started()
    const copy = JSON.parse(JSON.stringify(before))
    r(r(before, 'PreToolUse', { aid: 'a', tool: 'Bash' }), 'SubagentStop', { aid: 'a' })
    expect(before).toEqual(copy)
  })
  test('aid events still record lastEventAt and firstEventSeen', () => {
    const o = r(rt({}), 'SubagentStart', { aid: 'a', at: 'X', sid: 'S', t: 777 })
    expect(o).toMatchObject({ lastEventAt: 777, firstEventSeen: true, claudeSessionId: 'S' })
  })
})
