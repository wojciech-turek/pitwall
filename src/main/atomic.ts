import { randomBytes } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'

const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** Windows refuses to replace a file another process has open at that moment (a reader, a virus scan): retry briefly. */
async function renameOver(from: string, to: string, platform: NodeJS.Platform): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to)
    } catch (e) {
      if (platform !== 'win32' || attempt >= 20 || !BUSY.has((e as NodeJS.ErrnoException).code ?? '')) throw e
      await new Promise((r) => setTimeout(r, 25))
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
