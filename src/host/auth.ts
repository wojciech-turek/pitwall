import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, fstatSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { hostKeyFile } from './paths'
import { renameSyncRetrying } from './rename-sync'

/**
 * Proving knowledge of the host key (see protocol.ts). Each host writes a fresh key when it starts; the app reads it
 * when the host greets it, so a host and the apps it serves always share one, and an impostor (something else holding
 * the socket or pipe name) can't answer, because only this user can read the key. This is the boundary between users:
 * on Windows the pipe itself may be opened by other local users (its default DACL) or squatted while no host runs,
 * so the key file's protection (the user's AppData ACL there; 0600 elsewhere) and this proof are what keep them out.
 */

export type Role = 'host' | 'app'

/** Thrown when the key can't be trusted or read; the message says why, for the person reading it. */
export class HostKeyError extends Error {}

export const newNonce = (): string => randomBytes(32).toString('hex')

/** HMAC-SHA256 of the other side's nonce, labelled with the prover's role so one side's proof never works for the other. */
export function proofFor(key: Buffer, role: Role, nonce: string): string {
  return createHmac('sha256', key).update(`pitwall-host-v1:${role}:${nonce}`).digest('hex')
}

export function checkProof(key: Buffer, role: Role, nonce: string, proof: unknown): boolean {
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) return false
  return timingSafeEqual(Buffer.from(proofFor(key, role, nonce), 'hex'), Buffer.from(proof, 'hex'))
}

/** The host, once it owns the socket: a new random key, owner-only (0600; on Windows the user's AppData ACL). */
export function writeHostKey(dataDir: string): Buffer {
  const key = randomBytes(32)
  const file = hostKeyFile(dataDir)
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, key.toString('hex'), { mode: 0o600, flag: 'wx' })
  renameSyncRetrying(tmp, file) // atomic: an app never reads half a key
  return key
}

/** The app: the key the host wrote. Refused if missing, malformed, or (Unix) someone else's or readable by others. */
export function readHostKey(dataDir: string, platform: NodeJS.Platform = process.platform): Buffer {
  const file = hostKeyFile(dataDir)
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    throw new HostKeyError(`there is no host key at ${file}`)
  }
  try {
    if (platform !== 'win32') {
      const st = fstatSync(fd)
      if (st.uid !== process.getuid!()) throw new HostKeyError(`${file} belongs to another user`)
      if ((st.mode & 0o077) !== 0) throw new HostKeyError(`${file} can be read by other users`)
    }
    const hex = readFileSync(fd, 'utf8').trim()
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new HostKeyError(`${file} is not a host key`)
    return Buffer.from(hex, 'hex')
  } finally {
    closeSync(fd)
  }
}
