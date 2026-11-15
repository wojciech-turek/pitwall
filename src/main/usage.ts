import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AccountUsage, ClaudeUsage, UsageWindow } from '../shared/types'

/** Written by pitwall-statusline in each session folder. */
export const STATUSLINE_FILE = 'statusline.json'

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

function windowFrom(v: unknown, keys: { pct: string; reset: string; toMs: number }): UsageWindow | undefined {
  const o = obj(v)
  const pct = o?.[keys.pct]
  const reset = o?.[keys.reset]
  if (!isNum(pct) || !isNum(reset)) return undefined
  return { usedPercentage: pct, resetsAt: Math.round(reset * keys.toMs) }
}
const CLAUDE_KEYS = { pct: 'used_percentage', reset: 'resets_at', toMs: 1000 } // resets_at is in seconds
const SAVED_KEYS = { pct: 'usedPercentage', reset: 'resetsAt', toMs: 1 }

function usageOf(fiveHour: UsageWindow | undefined, sevenDay: UsageWindow | undefined, updatedAt: number): ClaudeUsage | null {
  if (!fiveHour && !sevenDay) return null
  return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}), updatedAt }
}

/** Claude's status-line JSON -> usage, or null if it has no usable rate_limits. */
export function parseStatusLine(text: string, mtimeMs: number): ClaudeUsage | null {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return null }
  const rl = obj(obj(raw)?.rate_limits)
  if (!rl) return null
  return usageOf(windowFrom(rl.five_hour, CLAUDE_KEYS), windowFrom(rl.seven_day, CLAUDE_KEYS), Math.floor(mtimeMs))
}

function parseUsage(raw: unknown): ClaudeUsage | null {
  const o = obj(raw)
  if (!o || !isNum(o.updatedAt)) return null
  return usageOf(windowFrom(o.fiveHour, SAVED_KEYS), windowFrom(o.sevenDay, SAVED_KEYS), o.updatedAt)
}

/** The saved file: v2 is { v: 2, accounts }, anything older is one bare usage, which belonged to the default account. */
function parseSaved(text: string, defaultAccount: string): Map<string, ClaudeUsage> {
  const out = new Map<string, ClaudeUsage>()
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return out }
  const o = obj(raw)
  if (!o) return out
  if (o.v === undefined) {
    const u = parseUsage(o)
    if (u) out.set(defaultAccount, u)
    return out
  }
  const accounts = o.v === 2 ? obj(o.accounts) : null
  for (const [key, v] of Object.entries(accounts ?? {})) {
    const u = parseUsage(v)
    if (u) out.set(key, u)
  }
  return out
}

/**
 * Claude subscription usage per account, from the newest status-line report of each account's live sessions. The
 * latest values are kept in `file` so they show again after a restart.
 */
export class UsageTracker {
  private usage = new Map<string, ClaudeUsage>()
  /** Each account's label, and the report time it was read at. */
  private labels = new Map<string, { label: string; at: number }>()
  private listeners = new Set<(u: AccountUsage[]) => void>()
  /** statusline.json files (by mtime) already found to have no rate_limits. */
  private noLimits = new Map<string, number>()
  private timer?: NodeJS.Timeout
  private checking: Promise<void> | null = null
  private readonly intervalMs: number

  constructor(private deps: {
    file: string
    sessions: () => { dir: string; account: string }[]
    labelFor: (account: string) => Promise<string>
    defaultAccount: string
    intervalMs?: number
  }) {
    this.intervalMs = deps.intervalMs ?? 5000
  }

  async load(): Promise<void> {
    const text = await readFile(this.deps.file, 'utf8').catch(() => null)
    this.usage = text === null ? new Map() : parseSaved(text, this.deps.defaultAccount)
    await this.refreshLabels()
  }

  start(): void {
    this.stop()
    this.timer = setInterval(() => { void this.check() }, this.intervalMs)
    void this.check()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  current(): AccountUsage[] {
    const out: AccountUsage[] = []
    for (const [account, usage] of this.usage) out.push({ account, label: this.labels.get(account)?.label ?? account, usage })
    return out.sort((a, b) => a.label.localeCompare(b.label) || a.account.localeCompare(b.account))
  }

  onChange(cb: (u: AccountUsage[]) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  /** Looks for newer reports; never throws. */
  check(): Promise<void> {
    this.checking ??= this.scan().catch(() => undefined).finally(() => { this.checking = null })
    return this.checking
  }

  /** Reads the label of each account that has none yet or has a newer report than its label was read at. */
  private async refreshLabels(): Promise<boolean> {
    let changed = false
    for (const [account, u] of this.usage) {
      const known = this.labels.get(account)
      if (known && known.at >= u.updatedAt) continue
      const label = await this.deps.labelFor(account).catch(() => account)
      if (label !== known?.label) changed = true
      this.labels.set(account, { label, at: u.updatedAt })
    }
    return changed
  }

  private async scan(): Promise<void> {
    const found = (await Promise.all(this.deps.sessions().map(async ({ dir, account }) => {
      const path = join(dir, STATUSLINE_FILE)
      const st = await stat(path).catch(() => null)
      return st?.isFile() ? { path, account, mtime: Math.floor(st.mtimeMs) } : null
    }))).filter((f) => f !== null).sort((a, b) => b.mtime - a.mtime)
    for (const k of this.noLimits.keys()) if (!found.some((f) => f.path === k)) this.noLimits.delete(k)

    let changed = false
    for (const account of new Set(found.map((f) => f.account))) {
      for (const { path, mtime } of found.filter((f) => f.account === account)) {
        const have = this.usage.get(account)
        if (have && mtime <= have.updatedAt) break // nothing newer than what we have for this account
        if (this.noLimits.get(path) === mtime) continue
        const text = await readFile(path, 'utf8').catch(() => null)
        const next = text === null ? null : parseStatusLine(text, mtime)
        if (!next) {
          this.noLimits.set(path, mtime)
          continue
        }
        this.usage.set(account, next)
        changed = true
        break
      }
    }
    if (await this.refreshLabels()) changed = true
    if (!changed) return
    await this.save()
    const list = this.current()
    for (const cb of [...this.listeners]) {
      try { cb(list) } catch { /* a listener must not break the tracker */ }
    }
  }

  private async save(): Promise<void> {
    try {
      const tmp = `${this.deps.file}.tmp`
      await writeFile(tmp, JSON.stringify({ v: 2, accounts: Object.fromEntries(this.usage) }))
      await rename(tmp, this.deps.file)
    } catch {
      // best effort: only the values shown after a restart are affected
    }
  }
}
