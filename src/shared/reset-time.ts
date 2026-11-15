import type { ClaudeUsage } from './types'

const MIN = 60_000

/**
 * When to type "continue" for a session stopped at a limit: just after the window that is full resets (the latest,
 * if several are), else the soonest reset Claude reported, else an hour on. Two minutes of slack, as Claude's own
 * reset time is to the minute.
 */
export function resetTimeFor(usage: ClaudeUsage | undefined, now: number): number {
  const windows = [usage?.fiveHour, usage?.sevenDay].filter((w) => w !== undefined)
  const full = windows.filter((w) => w.usedPercentage >= 100 && w.resetsAt > now)
  const upcoming = windows.filter((w) => w.resetsAt > now)
  const at = full.length
    ? Math.max(...full.map((w) => w.resetsAt))
    : upcoming.length ? Math.min(...upcoming.map((w) => w.resetsAt)) : now + 60 * MIN
  return at + 2 * MIN
}
