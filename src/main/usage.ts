import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ClaudeUsage, UsageWindow } from '../shared/types'

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

function parseSaved(text: string): ClaudeUsage | null {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return null }
  const o = obj(raw)
  if (!o || !isNum(o.updatedAt)) return null
  return usageOf(windowFrom(o.fiveHour, SAVED_KEYS), windowFrom(o.sevenDay, SAVED_KEYS), o.updatedAt)
}

/**
 * Claude subscription usage, from the newest status-line report of any live session. The latest value is kept in
 * `file` so it shows again after a restart.
 */
export class UsageTracker {
  private usage: ClaudeUsage | null = null
  private listeners = new Set<(u: ClaudeUsage | null) => void>()
  /** statusline.json files (by mtime) already found to have no rate_limits. */
  private noLimits = new Map<string, number>()
  private timer?: NodeJS.Timeout
  private checking: Promise<void> | null = null
  private readonly intervalMs: number

  constructor(private deps: { file: string; sessionDirs: () => string[]; intervalMs?: number }) {
    this.intervalMs = deps.intervalMs ?? 5000
  }

  async load(): Promise<void> {
    const text = await readFile(this.deps.file, 'utf8').catch(() => null)
    this.usage = text === null ? null : parseSaved(text)
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

  current(): ClaudeUsage | null {
    return this.usage
  }

  onChange(cb: (u: ClaudeUsage | null) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  /** Looks for a newer report; never throws. */
  check(): Promise<void> {
    this.checking ??= this.scan().catch(() => undefined).finally(() => { this.checking = null })
    return this.checking
  }

  private async scan(): Promise<void> {
    const files = (await Promise.all(this.deps.sessionDirs().map(async (dir) => {
      const path = join(dir, STATUSLINE_FILE)
      const st = await stat(path).catch(() => null)
      return st?.isFile() ? { path, mtime: Math.floor(st.mtimeMs) } : null
    }))).filter((f) => f !== null).sort((a, b) => b.mtime - a.mtime)
    for (const k of this.noLimits.keys()) if (!files.some((f) => f.path === k)) this.noLimits.delete(k)

    for (const { path, mtime } of files) {
      if (this.usage && mtime <= this.usage.updatedAt) return // nothing newer than what we have, so no change
      if (this.noLimits.get(path) === mtime) continue
      const text = await readFile(path, 'utf8').catch(() => null)
      const next = text === null ? null : parseStatusLine(text, mtime)
      if (!next) {
        this.noLimits.set(path, mtime)
        continue
      }
      await this.set(next)
      return
    }
  }

  private async set(next: ClaudeUsage): Promise<void> {
    this.usage = next
    try {
      const tmp = `${this.deps.file}.tmp`
      await writeFile(tmp, JSON.stringify(next))
      await rename(tmp, this.deps.file)
    } catch {
      // best effort: only the value shown after a restart is affected
    }
    for (const cb of [...this.listeners]) {
      try { cb(next) } catch { /* a listener must not break the tracker */ }
    }
  }
}
