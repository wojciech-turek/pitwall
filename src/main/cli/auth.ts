import { createHash, createHmac, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from '../atomic'

/** A unix socket path must fit in sockaddr_un (104 bytes on macOS): a long data dir falls back to the temp dir. */
const MAX_SOCKET_PATH = 100

/**
 * The key that signs session tokens: 32 random bytes made once (kept as hex, owner-only), read back after that. A new
 * one only when there is none or it is corrupt: any other read error throws, since replacing a key that is merely
 * unreadable for now would break every running session's token.
 */
export async function loadCliKey(file: string): Promise<Buffer> {
  let text: string | null = null
  try {
    text = (await readFile(file, 'utf8')).trim()
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  if (text !== null) {
    const key = Buffer.from(text, 'hex')
    if (key.length === 32 && /^[0-9a-f]{64}$/i.test(text)) return key
  }
  const key = randomBytes(32)
  await writeFileAtomic(file, key.toString('hex'), 0o600)
  return key
}

/** What a session presents to prove it is one: it can't be made without the key. */
export function cliToken(key: Buffer, sessionId: string): string {
  return createHmac('sha256', key).update(`pitwall-cli-v1:${sessionId}`).digest('hex')
}

export function cliSocketPath(dataDir: string): string {
  const p = join(dataDir, 'cli.sock')
  if (Buffer.byteLength(p) <= MAX_SOCKET_PATH) return p
  return join(tmpdir(), `pitwall-${createHash('sha256').update(dataDir).digest('hex').slice(0, 12)}.sock`)
}
