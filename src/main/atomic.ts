import { randomBytes } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'

/** Write via a uniquely named temp file and rename, so readers never see half a file and writers never collide. */
export async function writeFileAtomic(file: string, content: string, mode?: number): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(tmp, content, mode === undefined ? undefined : { mode })
    await rename(tmp, file)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}
