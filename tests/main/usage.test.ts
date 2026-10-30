import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { parseStatusLine, UsageTracker } from '../../src/main/usage'
import type { ClaudeUsage } from '../../src/shared/types'
import { waitFor } from '../helpers/wait'

const T = 1_800_000_000_000 // a fixed mtime base (ms)
const RESET_5H = 1_800_010_000 // seconds
const RESET_7D = 1_800_400_000

let base: string
let dirs: string[]
let file: string
let trackers: UsageTracker[]

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'pitwall-usage-'))
  dirs = ['s_a', 's_b', 's_c'].map((id) => join(base, 'sessions', id))
  for (const d of dirs) await mkdir(d, { recursive: true })
  file = join(base, 'usage.json')
  trackers = []
})
afterEach(async () => {
  for (const t of trackers) t.stop()
  await rm(base, { recursive: true, force: true })
})

function tracker(o: { intervalMs?: number } = {}): UsageTracker {
  const t = new UsageTracker({ file, sessionDirs: () => dirs, ...o })
  trackers.push(t)
  return t
}

const limits = (five?: number, week?: number) => ({
  ...(five !== undefined ? { five_hour: { used_percentage: five, resets_at: RESET_5H } } : {}),
  ...(week !== undefined ? { seven_day: { used_percentage: week, resets_at: RESET_7D } } : {})
})

/** Writes a status-line payload as Claude would, with the given mtime. */
async function report(dir: string, body: unknown, at: number): Promise<void> {
  const f = join(dir, 'statusline.json')
  await writeFile(f, typeof body === 'string' ? body : JSON.stringify(body))
  await utimes(f, at / 1000, at / 1000)
}
const withLimits = (rl: unknown) => ({ session_id: 'x', model: { id: 'm' }, rate_limits: rl })

const usage = (five: number | undefined, week: number | undefined, updatedAt: number): ClaudeUsage => ({
  ...(five !== undefined ? { fiveHour: { usedPercentage: five, resetsAt: RESET_5H * 1000 } } : {}),
  ...(week !== undefined ? { sevenDay: { usedPercentage: week, resetsAt: RESET_7D * 1000 } } : {}),
  updatedAt
})

async function ready(o: { intervalMs?: number } = {}): Promise<{ t: UsageTracker; seen: (ClaudeUsage | null)[] }> {
  const t = tracker(o)
  await t.load()
  const seen: (ClaudeUsage | null)[] = []
  t.onChange((u) => seen.push(u))
  return { t, seen }
}

describe('parseStatusLine', () => {
  test('converts seconds to ms and keeps only usable windows', () => {
    expect(parseStatusLine(JSON.stringify(withLimits(limits(12.5, 40))), T + 0.7)).toEqual(usage(12.5, 40, T))
    expect(parseStatusLine(JSON.stringify(withLimits({
      five_hour: { used_percentage: '12', resets_at: RESET_5H }, seven_day: { used_percentage: 3, resets_at: RESET_7D }
    })), T)).toEqual(usage(undefined, 3, T))
  })

  test('null without rate_limits or any usable window', () => {
    for (const text of ['', '{ nope', 'null', '[]', '{}', JSON.stringify({ session_id: 'x' }), JSON.stringify(withLimits(null)),
      JSON.stringify(withLimits({})), JSON.stringify(withLimits({ spend_limit: { used_percentage: 5, resets_at: RESET_5H } })),
      JSON.stringify(withLimits({ five_hour: { used_percentage: 5 } })),
      JSON.stringify(withLimits({ five_hour: { used_percentage: null, resets_at: RESET_5H } }))]) {
      expect(parseStatusLine(text, T)).toBeNull()
    }
  })
})

describe('UsageTracker', () => {
  test('nothing reported yet: null, and nothing emitted', async () => {
    const { t, seen } = await ready()
    await t.check()
    expect(t.current()).toBeNull()
    expect(seen).toEqual([])
  })

  test('takes the most recently modified statusline.json that has rate_limits', async () => {
    const { t, seen } = await ready()
    await report(dirs[0], withLimits(limits(10, 20)), T)
    await report(dirs[1], withLimits(limits(30, 40)), T + 5000)
    await report(dirs[2], { session_id: 'no limits yet' }, T + 9000)
    await t.check()
    expect(t.current()).toEqual(usage(30, 40, T + 5000))
    expect(seen).toEqual([usage(30, 40, T + 5000)])
  })

  test('a window missing from the newest report stays missing (no mixing of reports)', async () => {
    const { t } = await ready()
    await report(dirs[0], withLimits(limits(10, 20)), T)
    await report(dirs[1], withLimits(limits(undefined, 41)), T + 1000)
    await t.check()
    expect(t.current()).toEqual(usage(undefined, 41, T + 1000))
  })

  test('emits only when the value changes', async () => {
    const { t, seen } = await ready()
    await report(dirs[0], withLimits(limits(10, 20)), T)
    await t.check()
    await t.check()
    expect(seen).toHaveLength(1)
    // a newer report without rate_limits (e.g. before Claude's first API response) changes nothing
    await report(dirs[1], { session_id: 'x' }, T + 1000)
    await report(dirs[2], '{ half written', T + 2000)
    await t.check()
    await t.check()
    expect(seen).toHaveLength(1)
    await report(dirs[0], withLimits(limits(11, 20)), T + 3000)
    await t.check()
    expect(seen).toEqual([usage(10, 20, T), usage(11, 20, T + 3000)])
  })

  test('keeps the last value when the sessions are gone', async () => {
    const { t, seen } = await ready()
    await report(dirs[0], withLimits(limits(10, 20)), T)
    await t.check()
    dirs = [join(base, 'sessions', 'missing')]
    await t.check()
    expect(t.current()).toEqual(usage(10, 20, T))
    expect(seen).toHaveLength(1)
  })

  test('persists the latest value and loads it after a restart', async () => {
    const first = await ready()
    await report(dirs[1], withLimits(limits(55, 66)), T + 7000)
    await first.t.check()
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(usage(55, 66, T + 7000))
    first.t.stop()

    // A report older than the saved one does not replace it.
    await report(dirs[1], withLimits(limits(1, 2)), T)
    const second = await ready()
    expect(second.t.current()).toEqual(usage(55, 66, T + 7000))
    await second.t.check()
    expect(second.t.current()).toEqual(usage(55, 66, T + 7000))
    expect(second.seen).toEqual([])
    await report(dirs[2], withLimits(limits(70, 80)), T + 8000)
    await second.t.check()
    expect(second.t.current()).toEqual(usage(70, 80, T + 8000))
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(usage(70, 80, T + 8000))
  })

  test('a missing or corrupt usage.json loads as nothing known', async () => {
    const a = await ready()
    expect(a.t.current()).toBeNull()
    for (const bad of ['{ nope', 'null', '{"updatedAt":"x"}', '{"fiveHour":{"usedPercentage":1}}', '[]']) {
      await writeFile(file, bad)
      const b = await ready()
      expect(b.t.current()).toBeNull()
    }
    await writeFile(file, JSON.stringify(usage(5, undefined, T)))
    expect((await ready()).t.current()).toEqual(usage(5, undefined, T))
  })

  test('start checks at once and then on the interval; stop ends it', async () => {
    const { t, seen } = await ready({ intervalMs: 20 })
    await report(dirs[0], withLimits(limits(10, 20)), T)
    t.start()
    await waitFor(async () => seen.length === 1, 2000, 'first value')
    await report(dirs[0], withLimits(limits(12, 20)), T + 1000)
    await waitFor(async () => seen.length === 2, 2000, 'second value')
    t.stop()
    await report(dirs[0], withLimits(limits(99, 20)), T + 2000)
    await new Promise((r) => setTimeout(r, 120))
    expect(seen.at(-1)).toEqual(usage(12, 20, T + 1000))
  })
})
