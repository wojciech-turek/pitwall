import { renameSync } from 'node:fs'

/**
 * renameSync, tried again for a moment (20 × 25 ms) when it fails: Windows refuses to replace a file another process
 * has open at that instant (a scanner, an app reading it). Synchronous: only for small files at the host's start.
 */
export function renameSyncRetrying(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      return renameSync(from, to)
    } catch (e) {
      if (attempt >= 20) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
}
