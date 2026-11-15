import { describe, expect, test } from 'vitest'
import { baseName, blockedReason, formatBytes, removable, removeLabel, removeSummary } from '../../src/renderer/src/state/strays'

const w = (o: Partial<{ merged: boolean; dirty: boolean; inUse: boolean; inUseUnknown: boolean }> = {}) =>
  ({ path: '/x/a', merged: true, dirty: false, inUse: false, lastCommitAt: null, ...o })

describe('stray worktree helpers', () => {
  test('sizes read like 8.4 GB and 640 MB', () => {
    expect(formatBytes(8.4 * 1024 ** 3)).toBe('8.4 GB')
    expect(formatBytes(640 * 1024 ** 2)).toBe('640 MB')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(12)).toBe('12 B')
  })

  test('only merged, clean, idle rows can be picked, and blocked ones say why', () => {
    expect(removable(w())).toBe(true)
    expect(removable(w({ dirty: true }))).toBe(false)
    expect(removable(w({ inUse: true }))).toBe(false)
    expect(removable(w({ merged: false }))).toBe(false)
    expect(removable(w({ inUseUnknown: true }))).toBe(false)
    expect(blockedReason(w({ inUseUnknown: true }))).toBe("couldn't check whether it's in use")
    expect(blockedReason(w({ dirty: true }))).toBe('uncommitted changes')
    expect(blockedReason(w({ inUse: true }))).toBe('in use')
    expect(blockedReason(w({ merged: false }))).toBe('not merged')
    expect(blockedReason(w())).toBeNull()
  })

  test('the footer button counts and sums once every size is known', () => {
    expect(removeLabel(12, [4.2 * 1024 ** 3, 4.2 * 1024 ** 3, ...Array(10).fill(0)])).toBe('Remove 12 worktrees (8.4 GB)')
    expect(removeLabel(1, [640 * 1024 ** 2])).toBe('Remove 1 worktree (640 MB)')
    expect(removeLabel(2, [1024, undefined])).toBe('Remove 2 worktrees')
    expect(removeLabel(0, [])).toBe('Remove 0 worktrees')
  })

  test('the toast says what was removed and what was left, with the reasons', () => {
    expect(removeSummary([{ ok: true }, { ok: true }, { ok: false, message: 'Has uncommitted changes' }]))
      .toBe('Removed 2 worktrees. Left 1 alone: Has uncommitted changes.')
    expect(removeSummary([{ ok: true }])).toBe('Removed 1 worktree.')
  })

  test('baseName', () => {
    expect(baseName('/a/b/c/')).toBe('c')
    expect(baseName('C:\\a\\b')).toBe('b')
  })
})
