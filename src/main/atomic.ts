import { randomBytes } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY'])

export interface BusyRetry {
  /** How long to keep trying (default 5 s). */
  retryForMs?: number
}

/**
 * Runs `op`, and on Windows runs it again while it fails because another process has the file open at that moment
 * (a reader, a virus scan, a backup, the indexer: EPERM/EACCES/EBUSY), backing off (25, 50, 100, then 200 ms) for up
 * to `retryForMs`. Measured on a Windows VM with a reader polling a file every 5 ms: replacing it failed 1 time in 40
 * within the 0.5 s once allowed here, and the slowest success took ~1 s. Elsewhere `op` runs once.
 */
export async function retryWhileBusy<T>(op: () => Promise<T>, platform: NodeJS.Platform = process.platform, o: BusyRetry = {}): Promise<T> {
  const started = Date.now()
  for (let attempt = 0; ; attempt++) {
    try {
      return await op()
    } catch (e) {
      const busy = BUSY.has((e as NodeJS.ErrnoException).code ?? '')
      if (platform !== 'win32' || !busy || Date.now() - started >= (o.retryForMs ?? 5000)) throw e
      await new Promise((r) => setTimeout(r, Math.min(25 * 2 ** attempt, 200)))
    }
  }
}

/** Windows refuses to replace a file another process has open at that moment: see retryWhileBusy. */
export function renameOver(
  from: string, to: string, platform: NodeJS.Platform = process.platform,
  o: BusyRetry & { rename?: (from: string, to: string) => Promise<void> } = {}
): Promise<void> {
  const doRename = o.rename ?? rename
  return retryWhileBusy(() => doRename(from, to), platform, o)
}

/** Writes in progress, per file: the next write to a file starts when the last one is done. */
const writing = new Map<string, Promise<void>>()

/**
 * Write via a uniquely named temp file and rename, so readers never see half a file and writers never collide.
 * Writes to one file land in the order they were made (a rename may be retried for a while on Windows, and a later
 * write must not land first: claude-id after two quick /clears).
 */
export function writeFileAtomic(
  file: string, content: string, mode?: number, o: { rename?: (from: string, to: string) => Promise<void> } = {}
): Promise<void> {
  const key = process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file)
  const write = async (): Promise<void> => {
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      await writeFile(tmp, content, mode === undefined ? undefined : { mode })
      await renameOver(tmp, file, process.platform, o)
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {})
      throw e
    }
  }
  const done = (writing.get(key) ?? Promise.resolve()).then(write)
  const settled = done.catch(() => undefined)
  writing.set(key, settled)
  void settled.then(() => { if (writing.get(key) === settled) writing.delete(key) })
  return done
}
