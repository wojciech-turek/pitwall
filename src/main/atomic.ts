import { randomBytes } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'

const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY'])

/**
 * Windows refuses to replace a file another process has open at that moment (a reader, a virus scan, a backup):
 * retry, backing off (25, 50, 100, then 200 ms), for up to `retryForMs`. Measured on a Windows VM with a reader polling
 * the file every 5 ms: 1 write in 40 still failed within the 0.5 s this used to allow, and the slowest took ~1 s.
 */
export async function renameOver(
  from: string, to: string, platform: NodeJS.Platform = process.platform,
  o: { retryForMs?: number; rename?: (from: string, to: string) => Promise<void> } = {}
): Promise<void> {
  const started = Date.now()
  const doRename = o.rename ?? rename
  for (let attempt = 0; ; attempt++) {
    try {
      return await doRename(from, to)
    } catch (e) {
      const busy = BUSY.has((e as NodeJS.ErrnoException).code ?? '')
      if (platform !== 'win32' || !busy || Date.now() - started >= (o.retryForMs ?? 5000)) throw e
      await new Promise((r) => setTimeout(r, Math.min(25 * 2 ** attempt, 200)))
    }
  }
}

/** Write via a uniquely named temp file and rename, so readers never see half a file and writers never collide. */
export async function writeFileAtomic(file: string, content: string, mode?: number): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(tmp, content, mode === undefined ? undefined : { mode })
    await renameOver(tmp, file, process.platform)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}
