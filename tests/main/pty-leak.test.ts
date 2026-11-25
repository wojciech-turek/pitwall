import { execFileSync } from 'node:child_process'
import * as pty from 'node-pty'
import { describe, expect, it } from 'vitest'

/** How many pty masters (/dev/ptmx) this process holds open. */
function openPtys(): number {
  // lsof exits 1 when some file can't be examined, with its output still complete.
  let out: string
  try { out = execFileSync('lsof', ['-p', String(process.pid)], { encoding: 'utf8' }) }
  catch (e) { out = String((e as { stdout?: string }).stdout ?? '') }
  return out.split('\n').filter((l) => l.endsWith('/dev/ptmx')).length
}

function runOnce(): Promise<void> {
  return new Promise((resolve) => {
    const p = pty.spawn('/bin/sh', ['-c', 'exit 0'], { cols: 80, rows: 24 })
    p.onData(() => {})
    p.onExit(() => setTimeout(resolve, 100)) // the master closes just after the exit is reported
  })
}

// macOS has 511 ptys for the whole machine. node-pty 1.1.0 left one open for every terminal it started, so after a
// few hundred opened terminals no program could start one ("posix_spawnp failed.") until Pitwall quit.
// patches/node-pty@1.1.0.patch closes it; this fails if the patch (or the build from source it needs) is lost.
describe.runIf(process.platform === 'darwin')('node-pty', () => {
  it('holds no pty once its terminal has ended', async () => {
    await runOnce() // anything opened once and kept is not a leak
    const before = openPtys()
    for (let i = 0; i < 5; i++) await runOnce()
    expect(openPtys()).toBe(before)
  })
})
