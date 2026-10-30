import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  CHECK_INTERVAL_MS, compareVersions, FIRST_CHECK_DELAY_MS, parseReleases, RELEASES_PAGE, RELEASES_URL, releasesUrl,
  UpdateChecker, type FetchFn
} from '../../src/main/updates'
import type { UpdateState } from '../../src/shared/types'

const rel = (tag: unknown, o: Record<string, unknown> = {}): Record<string, unknown> => ({
  tag_name: tag,
  name: `Pitwall ${String(tag)}`,
  body: `Notes for ${String(tag)}`,
  html_url: `https://github.com/wojciech-turek/pitwall/releases/tag/${String(tag)}`,
  draft: false,
  prerelease: false,
  published_at: '2026-10-01T10:00:00Z',
  ...o
})

describe('compareVersions', () => {
  test('compares X.Y.Z numerically, part by part', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('0.9.9', '0.10.0')).toBeLessThan(0)
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0)
    expect(compareVersions('1.2.10', '1.2.9')).toBeGreaterThan(0)
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('0.0.0', '0.0.0')).toBe(0)
  })

  test('anything but plain X.Y.Z is not a release: never newer, never older, never equal', () => {
    for (const bad of ['1.2', 'latest', '1.2.3-beta.1', 'v1.2.3', '1.2.3.4', '', ' 1.2.3', '01.2.3', '1.2.x', '99999999999999999999.0.0']) {
      expect(compareVersions(bad, '1.0.0'), bad).toBeNaN()
      expect(compareVersions('1.0.0', bad), bad).toBeNaN()
    }
  })
})

describe('parseReleases', () => {
  test('keeps published releases strictly newer than current, newest first', () => {
    const json = [
      rel('v0.2.0'), rel('v0.10.0'), rel('v0.1.0'), rel('v0.0.9'), rel('0.5.0'),
      rel('v0.3.0', { draft: true }), rel('v0.4.0', { prerelease: true }),
      rel('v1.2'), rel('latest'), rel('v1.2.3-beta.1'), rel(5), rel(null), null, 'v9.9.9', 42, [rel('v7.0.0')]
    ]
    expect(parseReleases(json, '0.1.0').map((r) => r.version)).toEqual(['0.10.0', '0.5.0', '0.2.0'])
  })

  test('maps the GitHub fields; the leading v is stripped', () => {
    expect(parseReleases([rel('v0.2.0', { body: '## Added\n- x' })], '0.1.0')).toEqual([{
      version: '0.2.0',
      name: 'Pitwall v0.2.0',
      notes: '## Added\n- x',
      url: 'https://github.com/wojciech-turek/pitwall/releases/tag/v0.2.0',
      publishedAt: Date.parse('2026-10-01T10:00:00Z')
    }])
  })

  test('odd fields fall back to safe values', () => {
    const [r] = parseReleases([rel('v0.2.0', {
      name: '', body: null, html_url: 'javascript:alert(1)', published_at: 'soon'
    })], '0.1.0')
    expect(r).toEqual({ version: '0.2.0', name: 'v0.2.0', notes: '', url: RELEASES_PAGE, publishedAt: 0 })
    expect(parseReleases([rel('v0.2.0', { html_url: 'file:///etc/passwd' })], '0.1.0')[0].url).toBe(RELEASES_PAGE)
  })

  test('a tag listed twice is shown once', () => {
    expect(parseReleases([rel('v0.2.0'), rel('0.2.0')], '0.1.0').map((r) => r.version)).toEqual(['0.2.0'])
  })

  test('non-array JSON, or an unparsable current version, gives nothing', () => {
    for (const json of [null, undefined, {}, 'v1.0.0', 42, true, { message: 'API rate limit exceeded' }]) {
      expect(parseReleases(json, '0.1.0')).toEqual([])
    }
    expect(parseReleases([rel('v0.2.0')], '0.1.0-dev')).toEqual([])
  })
})

describe('releasesUrl', () => {
  test('the published app checks GitHub, or the feed it is pointed at', () => {
    expect(RELEASES_URL).toBe('https://api.github.com/repos/wojciech-turek/pitwall/releases')
    expect(releasesUrl({}, false)).toBe(RELEASES_URL)
    expect(releasesUrl({ PITWALL_RELEASES_URL: 'http://127.0.0.1:9/r' }, false)).toBe('http://127.0.0.1:9/r')
  })

  test('a dev build checks only when pointed at a feed', () => {
    expect(releasesUrl({}, true)).toBeNull()
    expect(releasesUrl({ PITWALL_RELEASES_URL: 'http://127.0.0.1:9/r' }, true)).toBe('http://127.0.0.1:9/r')
  })

  test('an empty PITWALL_RELEASES_URL turns checks off', () => {
    expect(releasesUrl({ PITWALL_RELEASES_URL: '' }, false)).toBeNull()
    expect(releasesUrl({ PITWALL_RELEASES_URL: '  ' }, true)).toBeNull()
  })
})

/** Timers that only fire when the test says so. */
function manualTimers() {
  const pending: { id: number; fn: () => void; ms: number }[] = []
  let nextId = 1
  return {
    pending,
    timers: {
      setTimeout: (fn: () => void, ms: number): unknown => {
        const id = nextId++
        pending.push({ id, fn, ms })
        return id
      },
      clearTimeout: (id: unknown): void => {
        const i = pending.findIndex((t) => t.id === id)
        if (i >= 0) pending.splice(i, 1)
      }
    },
    /** Fires the oldest pending timer; returns its delay. */
    fire(): number {
      const t = pending.shift()
      if (!t) throw new Error('no pending timer')
      t.fn()
      return t.ms
    }
  }
}

type Reply = { status: number; body: unknown } | { throws: Error } | { badJson: true }

let dir: string
let file: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pitwall-updates-'))
  file = join(dir, 'updates.json')
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const FEED = 'https://releases.test/r'
const HOUR = 60 * 60 * 1000

function setup(o: { url?: string | null; enabled?: boolean; current?: string; clock?: number; file?: string } = {}) {
  const t = manualTimers()
  let reply: Reply = { status: 200, body: [rel('v0.2.0'), rel('v0.1.0')] }
  let clock = o.clock ?? 1_000
  let enabled = o.enabled ?? true
  const fetch = vi.fn<FetchFn>(async () => {
    const r = reply
    if ('throws' in r) throw r.throws
    if ('badJson' in r) return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <') } }
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body }
  })
  const checker = new UpdateChecker({
    current: o.current ?? '0.1.0',
    url: o.url === undefined ? FEED : o.url,
    file: o.file ?? file,
    fetch,
    now: () => clock,
    timers: t.timers,
    enabled: () => enabled
  })
  const seen: UpdateState[] = []
  checker.onChange((s) => seen.push(s))
  return {
    checker, fetch, seen, ...t,
    reply: (r: Reply) => { reply = r },
    tick: (ms: number) => { clock += ms },
    setEnabled: (v: boolean) => { enabled = v }
  }
}

/** Waits until a check started by a timer has finished (fetched, saved, published). */
const settle = (s: { checker: UpdateChecker }) => vi.waitFor(() => {
  if ((s.checker as unknown as { checking: unknown }).checking) throw new Error('still checking')
})

describe('UpdateChecker', () => {
  test('starts with nothing known', () => {
    const { checker, fetch } = setup()
    expect(checker.state()).toEqual({ current: '0.1.0', checkedAt: null, newer: [] })
    expect(fetch).not.toHaveBeenCalled()
  })

  test('first check about 10 s after start, then every 24 h', async () => {
    const s = setup()
    s.checker.start()
    expect(s.pending.map((p) => p.ms)).toEqual([FIRST_CHECK_DELAY_MS])
    expect(FIRST_CHECK_DELAY_MS).toBe(10_000)
    expect(s.fetch).not.toHaveBeenCalled()

    expect(s.fire()).toBe(10_000)
    await settle(s)
    expect(s.fetch).toHaveBeenCalledTimes(1)
    expect(s.fetch.mock.calls[0][0]).toBe(FEED)
    expect(s.fetch.mock.calls[0][1].headers['User-Agent']).toBe('Pitwall/0.1.0')
    expect(s.checker.state()).toMatchObject({ checkedAt: 1_000, newer: [{ version: '0.2.0' }] })

    expect(s.pending.map((p) => p.ms)).toEqual([CHECK_INTERVAL_MS])
    expect(CHECK_INTERVAL_MS).toBe(24 * 60 * 60 * 1000)
    s.tick(CHECK_INTERVAL_MS)
    expect(s.fire()).toBe(CHECK_INTERVAL_MS)
    await settle(s)
    expect(s.fetch).toHaveBeenCalledTimes(2)
    expect(s.checker.state().checkedAt).toBe(1_000 + CHECK_INTERVAL_MS)
    expect(s.pending).toHaveLength(1) // only ever one timer
  })

  test('disabled: the timer never fetches, and picks up again once enabled', async () => {
    const s = setup({ enabled: false })
    s.checker.start()
    s.fire()
    await settle(s)
    expect(s.fetch).not.toHaveBeenCalled()
    expect(s.pending.map((p) => p.ms)).toEqual([CHECK_INTERVAL_MS])
    s.setEnabled(true)
    s.fire()
    await settle(s)
    expect(s.fetch).toHaveBeenCalledTimes(1)
  })

  test('without a URL (a dev build not pointed at a feed) nothing is ever loaded or fetched', async () => {
    await save({ url: FEED, checkedAt: 500, releases: [stored('0.2.0')] })
    const s = setup({ url: null })
    expect(s.checker.hasFeed()).toBe(false)
    await s.checker.load()
    s.checker.start()
    expect(s.pending).toHaveLength(0)
    expect(await s.checker.checkNow()).toEqual({ current: '0.1.0', checkedAt: null, newer: [] })
    expect(s.fetch).not.toHaveBeenCalled()
    expect(setup().checker.hasFeed()).toBe(true)
  })

  test('checkNow works before the timer has fired', async () => {
    const s = setup()
    s.checker.start()
    const st = await s.checker.checkNow()
    expect(s.fetch).toHaveBeenCalledTimes(1)
    expect(st).toEqual(s.checker.state())
    expect(st).toMatchObject({ current: '0.1.0', checkedAt: 1_000, newer: [{ version: '0.2.0' }] })
  })

  test('checkNow fetches even when automatic checks are off (the user asked)', async () => {
    const s = setup({ enabled: false })
    await s.checker.checkNow()
    expect(s.fetch).toHaveBeenCalledTimes(1)
  })

  test('network errors, 403/429/500, invalid or non-array JSON keep the previous state and never throw', async () => {
    const s = setup()
    const good = await s.checker.checkNow()
    expect(good.newer).toHaveLength(1)
    expect(s.seen).toHaveLength(1)
    const failures: Reply[] = [
      { throws: new TypeError('fetch failed') },
      { status: 403, body: { message: 'API rate limit exceeded' } },
      { status: 429, body: [] },
      { status: 500, body: [] },
      { badJson: true },
      { status: 200, body: { message: 'Not Found' } },
      { status: 200, body: null }
    ]
    for (const f of failures) {
      s.tick(5_000)
      s.reply(f)
      await expect(s.checker.checkNow()).resolves.toEqual(good)
    }
    expect(s.checker.state()).toEqual(good)
    expect(s.seen).toHaveLength(1)
  })

  test('a failing first check leaves nothing to show', async () => {
    const s = setup()
    s.reply({ status: 403, body: { message: 'API rate limit exceeded' } })
    expect(await s.checker.checkNow()).toEqual({ current: '0.1.0', checkedAt: null, newer: [] })
    expect(s.seen).toHaveLength(0)
  })

  test('a timer check that fails does not throw and keeps the timer going', async () => {
    const s = setup()
    s.reply({ throws: new Error('offline') })
    s.checker.start()
    s.fire()
    await settle(s)
    expect(s.checker.state().checkedAt).toBeNull()
    expect(s.pending.map((p) => p.ms)).toEqual([CHECK_INTERVAL_MS])
  })

  test('onChange fires only when the list of newer releases changes', async () => {
    const s = setup()
    await s.checker.checkNow()
    s.tick(1_000)
    await s.checker.checkNow() // same releases, later time
    expect(s.seen).toHaveLength(1)
    expect(s.seen[0].newer.map((r) => r.version)).toEqual(['0.2.0'])
    s.reply({ status: 200, body: [rel('v0.3.0', { body: '- more' }), rel('v0.2.0')] })
    await s.checker.checkNow()
    expect(s.seen).toHaveLength(2)
    expect(s.seen[1].newer.map((r) => r.version)).toEqual(['0.3.0', '0.2.0'])
    s.reply({ status: 200, body: [rel('v0.3.0', { body: '- more, edited' }), rel('v0.2.0')] })
    await s.checker.checkNow()
    expect(s.seen).toHaveLength(3) // edited notes are a change too
  })

  test('a listener that throws does not break the checker', async () => {
    const s = setup()
    s.checker.onChange(() => { throw new Error('boom') })
    await expect(s.checker.checkNow()).resolves.toMatchObject({ newer: [{ version: '0.2.0' }] })
  })

  test('concurrent checks share one request', async () => {
    const s = setup()
    const [a, b] = await Promise.all([s.checker.checkNow(), s.checker.checkNow()])
    expect(s.fetch).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
  })

  test('stop() cancels the pending check', async () => {
    const s = setup()
    s.checker.start()
    s.checker.stop()
    expect(s.pending).toHaveLength(0)
  })
})

const stored = (version: string, o: Partial<Record<string, unknown>> = {}) => ({
  version, name: `Pitwall v${version}`, notes: `Notes for ${version}`,
  url: `https://github.com/wojciech-turek/pitwall/releases/tag/v${version}`, publishedAt: 1_700_000_000_000, ...o
})
async function save(v: unknown): Promise<void> {
  await writeFile(file, typeof v === 'string' ? v : JSON.stringify(v))
}

describe('UpdateChecker across restarts (updates.json)', () => {
  const T = 1_800_000_000_000

  test('a successful check is saved; a failed one is not', async () => {
    const s = setup({ clock: T })
    await s.checker.checkNow()
    const saved = JSON.parse(await readFile(file, 'utf8'))
    expect(saved).toEqual({ url: FEED, checkedAt: T, releases: s.checker.state().newer })
    expect(saved.releases.map((r: { version: string }) => r.version)).toEqual(['0.2.0'])
    s.tick(HOUR)
    s.reply({ status: 403, body: { message: 'API rate limit exceeded' } })
    await s.checker.checkNow()
    expect(JSON.parse(await readFile(file, 'utf8')).checkedAt).toBe(T)
  })

  test('a relaunch within 24 h shows the saved notice at once and asks nothing until the day is up', async () => {
    await setup({ clock: T }).checker.checkNow()
    const s = setup({ clock: T + 3 * HOUR })
    await s.checker.load()
    expect(s.checker.state()).toEqual({ current: '0.1.0', checkedAt: T, newer: [stored('0.2.0', {
      name: 'Pitwall v0.2.0', notes: 'Notes for v0.2.0', publishedAt: Date.parse('2026-10-01T10:00:00Z')
    })] })
    s.checker.start()
    expect(s.pending.map((p) => p.ms)).toEqual([CHECK_INTERVAL_MS - 3 * HOUR])
    s.tick(CHECK_INTERVAL_MS - 3 * HOUR)
    s.fire()
    expect(s.fetch).toHaveBeenCalledTimes(1)
    await settle(s)
    expect(s.checker.state().checkedAt).toBe(T + CHECK_INTERVAL_MS)
  })

  test('with checks off, a relaunch shows no saved notice, but the saved time still counts', async () => {
    await save({ url: FEED, checkedAt: T, releases: [stored('0.2.0')] })
    const s = setup({ clock: T + HOUR, enabled: false })
    await s.checker.load()
    expect(s.checker.state()).toEqual({ current: '0.1.0', checkedAt: T, newer: [] })
    s.checker.start()
    expect(s.pending.map((p) => p.ms)).toEqual([CHECK_INTERVAL_MS - HOUR])
  })

  test('a relaunch after 24 h checks 10 s after start', async () => {
    await save({ url: FEED, checkedAt: T, releases: [stored('0.2.0')] })
    const s = setup({ clock: T + CHECK_INTERVAL_MS + HOUR })
    await s.checker.load()
    expect(s.checker.state().newer.map((r) => r.version)).toEqual(['0.2.0'])
    s.checker.start()
    expect(s.pending.map((p) => p.ms)).toEqual([FIRST_CHECK_DELAY_MS])
    expect(s.fetch).not.toHaveBeenCalled()
  })

  test('after an update, saved releases up to the installed version are not shown, with no request', async () => {
    await save({ url: FEED, checkedAt: T, releases: [stored('0.3.0'), stored('0.2.0')] })
    const at = setup({ current: '0.2.0', clock: T + HOUR })
    await at.checker.load()
    expect(at.checker.state()).toMatchObject({ current: '0.2.0', checkedAt: T })
    expect(at.checker.state().newer.map((r) => r.version)).toEqual(['0.3.0'])
    const latest = setup({ current: '0.3.0', clock: T + HOUR })
    await latest.checker.load()
    expect(latest.checker.state()).toEqual({ current: '0.3.0', checkedAt: T, newer: [] })
    latest.checker.start()
    expect(latest.pending.map((p) => p.ms)).toEqual([CHECK_INTERVAL_MS - HOUR])
    expect(at.fetch).not.toHaveBeenCalled()
    expect(latest.fetch).not.toHaveBeenCalled()
  })

  test('a missing, corrupt or odd file, or one from another feed, means no previous check', async () => {
    const fresh = { current: '0.1.0', checkedAt: null, newer: [] }
    for (const content of [null, 'garbage{', 'null', '[]', '{}',
      { url: 'https://other.test/r', checkedAt: T, releases: [stored('0.2.0')] },
      { url: FEED, checkedAt: 'yesterday', releases: [stored('0.2.0')] },
      { url: FEED, checkedAt: T, releases: 'none' }]) {
      await rm(file, { force: true })
      if (content !== null) await save(content)
      const s = setup({ clock: T + HOUR })
      await s.checker.load()
      expect(s.checker.state(), JSON.stringify(content)).toEqual(fresh)
      s.checker.start()
      expect(s.pending.map((p) => p.ms)).toEqual([FIRST_CHECK_DELAY_MS])
    }
  })

  test('saved entries are checked like fresh ones', async () => {
    await save({ url: FEED, checkedAt: T, releases: [
      stored('0.2.0', { url: 'javascript:alert(1)', publishedAt: 'soon', name: 7 }), stored('latest'), stored('0.4.0-beta.1'),
      null, 'x', stored('0.3.0'), stored('0.3.0', { notes: 'duplicate' })
    ] })
    const s = setup({ clock: T + HOUR })
    await s.checker.load()
    expect(s.checker.state().newer).toEqual([
      stored('0.3.0'),
      { version: '0.2.0', name: 'v0.2.0', notes: 'Notes for 0.2.0', url: RELEASES_PAGE, publishedAt: 0 }
    ])
  })

  test('a check in between (Check now) pushes the next automatic one back a day', async () => {
    const s = setup({ clock: T })
    s.checker.start()
    s.tick(5_000)
    await s.checker.checkNow()
    s.tick(5_000)
    s.fire() // the 10 s timer: checked 5 s ago, so wait
    expect(s.fetch).toHaveBeenCalledTimes(1)
    expect(s.pending.map((p) => p.ms)).toEqual([CHECK_INTERVAL_MS - 5_000])
  })

  test('a saved check from the future (the clock was changed) waits at most a day', async () => {
    await save({ url: FEED, checkedAt: T + 30 * CHECK_INTERVAL_MS, releases: [] })
    const s = setup({ clock: T })
    await s.checker.load()
    s.checker.start()
    expect(s.pending.map((p) => p.ms)).toEqual([CHECK_INTERVAL_MS])
  })

  test('a file that cannot be written does not break the check', async () => {
    const s = setup({ clock: T, file: join(dir, 'missing-dir', 'updates.json') })
    await expect(s.checker.checkNow()).resolves.toMatchObject({ checkedAt: T, newer: [{ version: '0.2.0' }] })
  })
})
