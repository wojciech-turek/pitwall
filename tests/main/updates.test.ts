import { describe, expect, test, vi } from 'vitest'
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

function setup(o: { url?: string | null; enabled?: boolean; current?: string } = {}) {
  const t = manualTimers()
  let reply: Reply = { status: 200, body: [rel('v0.2.0'), rel('v0.1.0')] }
  let clock = 1_000
  let enabled = o.enabled ?? true
  const fetch = vi.fn<FetchFn>(async () => {
    const r = reply
    if ('throws' in r) throw r.throws
    if ('badJson' in r) return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <') } }
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body }
  })
  const checker = new UpdateChecker({
    current: o.current ?? '0.1.0',
    url: o.url === undefined ? 'https://releases.test/r' : o.url,
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

/** Lets the fetch promise chain started by a timer settle. */
const settle = () => new Promise((r) => setTimeout(r, 0))

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
    await settle()
    expect(s.fetch).toHaveBeenCalledTimes(1)
    expect(s.fetch.mock.calls[0][0]).toBe('https://releases.test/r')
    expect(s.fetch.mock.calls[0][1].headers['User-Agent']).toBe('Pitwall/0.1.0')
    expect(s.checker.state()).toMatchObject({ checkedAt: 1_000, newer: [{ version: '0.2.0' }] })

    expect(s.pending.map((p) => p.ms)).toEqual([CHECK_INTERVAL_MS])
    expect(CHECK_INTERVAL_MS).toBe(24 * 60 * 60 * 1000)
    s.tick(CHECK_INTERVAL_MS)
    expect(s.fire()).toBe(CHECK_INTERVAL_MS)
    await settle()
    expect(s.fetch).toHaveBeenCalledTimes(2)
    expect(s.checker.state().checkedAt).toBe(1_000 + CHECK_INTERVAL_MS)
    expect(s.pending).toHaveLength(1) // only ever one timer
  })

  test('disabled: the timer never fetches, and picks up again once enabled', async () => {
    const s = setup({ enabled: false })
    s.checker.start()
    s.fire()
    await settle()
    expect(s.fetch).not.toHaveBeenCalled()
    expect(s.pending.map((p) => p.ms)).toEqual([CHECK_INTERVAL_MS])
    s.setEnabled(true)
    s.fire()
    await settle()
    expect(s.fetch).toHaveBeenCalledTimes(1)
  })

  test('without a URL (a dev build not pointed at a feed) nothing is ever fetched', async () => {
    const s = setup({ url: null })
    s.checker.start()
    expect(s.pending).toHaveLength(0)
    expect(await s.checker.checkNow()).toEqual({ current: '0.1.0', checkedAt: null, newer: [] })
    expect(s.fetch).not.toHaveBeenCalled()
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
    await settle()
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
