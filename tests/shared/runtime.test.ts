import { describe, expect, test } from 'vitest'
import {
  countStatuses, displayStatus, initialRuntime, nextAttention, reduceRuntime, sidebarOrder, STATUS_LABEL
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
})
