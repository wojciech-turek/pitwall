import { createHash } from 'node:crypto'
import { tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'

/** macOS allows 103 bytes in a Unix socket path (Linux 107); leave a margin. */
const MAX_SOCKET_PATH = 100

function currentUser(): string {
  try {
    return userInfo().username
  } catch {
    return process.env.USERNAME || process.env.USER || 'user'
  }
}

/**
 * Where the host listens. One host per data dir, so dev and packaged builds (separate data dirs) never share one.
 * Unix: `host.sock` in the data dir (a short path in the per-user temp dir if that would be too long for a socket).
 * Windows: a named pipe per user and data dir. The pipe is not a boundary: created without a security descriptor (as
 * Node does), its default DACL lets other local users open it for reading, and any user could take the name while no
 * host runs. What keeps them out is the handshake (auth.ts): both sides prove they know host.key, which only this user
 * can read (the AppData ACL), and nothing is served or shown before that.
 */
export function hostSocketPath(
  dataDir: string,
  o: { platform?: NodeJS.Platform; user?: string; tmp?: string } = {}
): string {
  const platform = o.platform ?? process.platform
  const hash = createHash('sha256').update(platform === 'win32' ? dataDir.toLowerCase() : resolve(dataDir)).digest('hex').slice(0, 16)
  if (platform === 'win32') {
    const user = (o.user ?? currentUser()).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)
    return `\\\\.\\pipe\\pitwall-${user}-${hash}`
  }
  const p = join(dataDir, 'host.sock')
  return Buffer.byteLength(p) <= MAX_SOCKET_PATH ? p : join(o.tmp ?? tmpdir(), `pitwall-host-${hash}.sock`)
}

/** The running host's pid; written once it listens, removed when it exits. */
export const hostPidFile = (dataDir: string): string => join(dataDir, 'host.pid')

export const hostLogFile = (dataDir: string): string => join(dataDir, 'host.log')

/** The host key: a secret only this user can read, written by each host as it starts (see protocol.ts). */
export const hostKeyFile = (dataDir: string): string => join(dataDir, 'host.key')
