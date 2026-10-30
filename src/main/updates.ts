import type { ReleaseInfo, UpdateState } from '../shared/types'

/** GitHub's list of the app's releases (unauthenticated; newest first). */
export const RELEASES_URL = 'https://api.github.com/repos/wojciech-turek/pitwall/releases'
/** Where a release with an unusable page link sends the user instead. */
export const RELEASES_PAGE = 'https://github.com/wojciech-turek/pitwall/releases'
export const FIRST_CHECK_DELAY_MS = 10_000
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 20_000

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function parts(v: string): number[] | null {
  const m = SEMVER.exec(v)
  if (!m) return null
  const n = m.slice(1).map(Number)
  return n.every(Number.isSafeInteger) ? n : null
}

/**
 * Compares two plain `X.Y.Z` versions: > 0 when a is newer, < 0 when older, 0 when equal. Anything else (`1.2`,
 * `latest`, `1.2.3-beta.1`) is not a release: the result is NaN, so it is never newer, older or equal.
 */
export function compareVersions(a: string, b: string): number {
  const x = parts(a)
  const y = parts(b)
  if (!x || !y) return NaN
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const isWeb = (u: string): boolean => /^https?:\/\//i.test(u)

/**
 * GitHub's releases JSON -> the published releases strictly newer than `current`, newest first. Drafts,
 * prereleases and tags that aren't `vX.Y.Z` / `X.Y.Z` are skipped; anything but an array gives nothing.
 */
export function parseReleases(json: unknown, current: string): ReleaseInfo[] {
  if (!Array.isArray(json)) return []
  const out = new Map<string, ReleaseInfo>()
  for (const item of json) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const r = item as Record<string, unknown>
    if (r.draft === true || r.prerelease === true) continue
    const tag = str(r.tag_name)
    const version = tag.replace(/^v/, '')
    if (!(compareVersions(version, current) > 0) || out.has(version)) continue
    const url = str(r.html_url)
    const published = Date.parse(str(r.published_at))
    out.set(version, {
      version,
      name: str(r.name).trim() || tag,
      notes: str(r.body),
      url: isWeb(url) ? url : RELEASES_PAGE,
      publishedAt: Number.isFinite(published) ? published : 0
    })
  }
  return [...out.values()].sort((a, b) => compareVersions(b.version, a.version))
}

/**
 * Where to look for releases, or null for no checks. A dev build checks only when pointed at a feed
 * (PITWALL_RELEASES_URL), so it never offers the published app as an update; an empty value turns checks off.
 */
export function releasesUrl(env: NodeJS.ProcessEnv, dev: boolean): string | null {
  const v = env.PITWALL_RELEASES_URL
  if (v !== undefined) return v.trim() || null
  return dev ? null : RELEASES_URL
}

export interface FetchResponse { ok: boolean; status: number; json(): Promise<unknown> }
export type FetchFn = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<FetchResponse>
export interface Timers { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }

export interface UpdateCheckerDeps {
  /** This build's version (APP_VERSION). */
  current: string
  /** null: never fetch (see releasesUrl). */
  url: string | null
  fetch: FetchFn
  now: () => number
  timers: Timers
  /** The user's setting; read before every automatic check. */
  enabled: () => boolean
}

/**
 * Looks for newer releases: about 10 s after start, then every 24 h while the setting is on, and whenever the user
 * asks (checkNow). One unauthenticated GET; any failure is silent and keeps what was known.
 */
export class UpdateChecker {
  private known: UpdateState
  private listeners = new Set<(s: UpdateState) => void>()
  private timer: unknown = null
  private checking: Promise<UpdateState> | null = null

  constructor(private deps: UpdateCheckerDeps) {
    this.known = { current: deps.current, checkedAt: null, newer: [] }
  }

  start(): void {
    this.stop()
    if (this.deps.url) this.schedule(FIRST_CHECK_DELAY_MS)
  }

  stop(): void {
    if (this.timer !== null) this.deps.timers.clearTimeout(this.timer)
    this.timer = null
  }

  state(): UpdateState {
    return this.known
  }

  /** Fires only when the list of newer releases changes, not on every successful check. */
  onChange(cb: (s: UpdateState) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  /** Checks now, whatever the setting (the user asked). Never throws; resolves with the resulting state. */
  checkNow(): Promise<UpdateState> {
    this.checking ??= this.check().catch(() => undefined).then(() => this.known).finally(() => { this.checking = null })
    return this.checking
  }

  private schedule(ms: number): void {
    this.timer = this.deps.timers.setTimeout(() => {
      this.schedule(CHECK_INTERVAL_MS)
      if (this.deps.enabled()) void this.checkNow()
    }, ms)
  }

  private async check(): Promise<void> {
    const { url, current } = this.deps
    if (!url) return
    const res = await this.deps.fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Pitwall/${current}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!res.ok) return // rate-limited (403/429), not found, server error: try again next time
    const json = await res.json()
    if (!Array.isArray(json)) return // not a releases list: don't take it as "up to date"
    const newer = parseReleases(json, current)
    const changed = JSON.stringify(newer) !== JSON.stringify(this.known.newer)
    this.known = { current, checkedAt: this.deps.now(), newer }
    if (!changed) return
    for (const cb of [...this.listeners]) {
      try { cb(this.known) } catch { /* a listener must not break the checker */ }
    }
  }
}
