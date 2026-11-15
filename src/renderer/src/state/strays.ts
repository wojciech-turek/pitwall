import type { StrayWorktree } from '@shared/types'

/** `8.4 GB`, `640 MB`, `12 KB`: one decimal for gigabytes only. */
export function formatBytes(bytes: number): string {
  const GB = 1024 ** 3
  const MB = 1024 ** 2
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/** A stray row can be picked only when removing it loses nothing: merged, no changes, nothing running in it. */
export const removable = (w: StrayWorktree): boolean => w.merged && !w.dirty && !w.inUse

/** Why a row can't be picked. */
export function blockedReason(w: StrayWorktree): string | null {
  if (w.dirty) return 'uncommitted changes'
  if (w.inUse) return 'in use'
  if (!w.merged) return 'not merged'
  return null
}

export const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

/** The footer button: `Remove 12 worktrees (8.4 GB)`; the size once every picked one has been measured. */
export function removeLabel(count: number, sizes: (number | null | undefined)[]): string {
  const noun = `${count} ${count === 1 ? 'worktree' : 'worktrees'}`
  if (count === 0 || sizes.some((s) => s === undefined)) return `Remove ${noun}`
  return `Remove ${noun} (${formatBytes(sizes.reduce<number>((a, s) => a + (s ?? 0), 0))})`
}

/** The toast after removing: what went and what was refused. */
export function removeSummary(results: { ok: boolean; message?: string }[]): string {
  const done = results.filter((r) => r.ok).length
  const refused = results.filter((r) => !r.ok)
  const parts: string[] = []
  if (done) parts.push(`Removed ${done} ${done === 1 ? 'worktree' : 'worktrees'}.`)
  if (refused.length) {
    const why = [...new Set(refused.map((r) => r.message ?? 'Could not remove'))].join('; ')
    parts.push(`Left ${refused.length} alone: ${why}.`)
  }
  return parts.join(' ') || 'Nothing to remove.'
}
