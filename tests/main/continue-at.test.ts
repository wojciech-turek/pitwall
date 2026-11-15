import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ContinueScheduler } from '../../src/main/sessions/continue-at'
import type { ClaudeUsage, DisplayStatus } from '../../src/shared/types'

const NOW = 1_000_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN

interface Fake { id: string; continueAt?: number; archivedAt?: number }
let sessions: Fake[]
let live: Record<string, { status: DisplayStatus; limitHit?: boolean }>
let sent: Array<[string, string]>
let clock: number
let usage: ClaudeUsage | undefined
let sched: ContinueScheduler

function make(): ContinueScheduler {
  const state = { get sessions() { return sessions } }
  const store = {
    get state() { return state },
    update: async (fn: (d: { sessions: Fake[] }) => void) => { fn({ sessions }) }
  }
  const manager = {
    snapshot: () => ({ sessions: Object.entries(live).map(([id, v]) => ({ id, ...v })) }),
    sendText: async (id: string, text: string) => { sent.push([id, text]) }
  }
  return new ContinueScheduler({
    store, manager, usageFor: () => usage, now: () => clock
  } as unknown as ConstructorParameters<typeof ContinueScheduler>[0])
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  clock = NOW
  sessions = [{ id: 's1' }]
  live = { s1: { status: 'read', limitHit: true } }
  sent = []
  usage = { fiveHour: { usedPercentage: 100, resetsAt: NOW + HOUR }, updatedAt: NOW }
  sched = make()
})
afterEach(() => { sched.stop(); vi.useRealTimers() })

describe('ContinueScheduler', () => {
  test('stores the reset time and types continue then, when the session is idle', async () => {
    const at = await sched.schedule('s1')
    expect(at).toBe(NOW + HOUR + 2 * MIN)
    expect(sessions[0].continueAt).toBe(at)
    await vi.advanceTimersByTimeAsync(HOUR + 2 * MIN - 1)
    expect(sent).toEqual([])
    clock = at
    await vi.advanceTimersByTimeAsync(1)
    expect(sent).toEqual([['s1', 'continue']])
    expect(sessions[0].continueAt).toBeUndefined()
  })
  test('sends nothing when the session is working by then, but clears continueAt', async () => {
    const at = await sched.schedule('s1')
    live.s1 = { status: 'working', limitHit: true }
    clock = at
    await vi.advanceTimersByTimeAsync(HOUR + 2 * MIN)
    expect(sent).toEqual([])
    expect(sessions[0].continueAt).toBeUndefined()
  })
  test('sends nothing when the limit flag is gone', async () => {
    const at = await sched.schedule('s1')
    live.s1 = { status: 'unread' }
    clock = at
    await vi.advanceTimersByTimeAsync(HOUR + 2 * MIN)
    expect(sent).toEqual([])
    expect(sessions[0].continueAt).toBeUndefined()
  })
  test('cancel clears it and nothing fires', async () => {
    await sched.schedule('s1')
    await sched.cancel('s1')
    expect(sessions[0].continueAt).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2 * HOUR)
    expect(sent).toEqual([])
  })
  test('scheduling again replaces the timer', async () => {
    await sched.schedule('s1')
    usage = { fiveHour: { usedPercentage: 100, resetsAt: NOW + 3 * HOUR }, updatedAt: NOW }
    const at = await sched.schedule('s1')
    clock = at
    await vi.advanceTimersByTimeAsync(2 * HOUR)
    expect(sent).toEqual([])
    await vi.advanceTimersByTimeAsync(HOUR + 2 * MIN)
    expect(sent).toEqual([['s1', 'continue']])
  })
  test('start() re-arms a future value', async () => {
    sessions[0].continueAt = NOW + HOUR
    sched.start()
    clock = NOW + HOUR
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(sent).toEqual([['s1', 'continue']])
  })
  test('a past value 1 h old fires within 10 s of start()', async () => {
    sessions[0].continueAt = NOW - HOUR
    sched.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sent).toEqual([['s1', 'continue']])
    expect(sessions[0].continueAt).toBeUndefined()
  })
  test('a value 13 h old is dropped without typing', async () => {
    sessions[0].continueAt = NOW - 13 * HOUR
    sched.start()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(sent).toEqual([])
    expect(sessions[0].continueAt).toBeUndefined()
  })
})
