import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { checkProof, HostKeyError, newNonce, proofFor, readHostKey, writeHostKey } from '../../src/host/auth'
import { hostKeyFile } from '../../src/host/paths'
import { makeHostDirs } from '../helpers/host'
import { rm } from 'node:fs/promises'

let tmp: string
let dataDir: string

beforeEach(async () => {
  ;({ tmp, dataDir } = await makeHostDirs())
  mkdirSync(dataDir, { recursive: true })
})
afterEach(async () => { await rm(tmp, { recursive: true, force: true }) })

test('each host writes a fresh key, readable only by this user, and the app reads the same one', () => {
  const a = writeHostKey(dataDir)
  expect(statSync(hostKeyFile(dataDir)).mode & 0o777).toBe(0o600)
  expect(readHostKey(dataDir)).toEqual(a)
  const b = writeHostKey(dataDir)
  expect(b).not.toEqual(a)
  expect(readHostKey(dataDir)).toEqual(b)
  expect(a).toHaveLength(32)
})

test('a missing, malformed or loosely protected key is refused, and says why', () => {
  expect(() => readHostKey(dataDir)).toThrow(new HostKeyError(`there is no host key at ${hostKeyFile(dataDir)}`))
  writeFileSync(hostKeyFile(dataDir), 'not a key', { mode: 0o600 })
  expect(() => readHostKey(dataDir)).toThrow('is not a host key')
  writeHostKey(dataDir)
  chmodSync(hostKeyFile(dataDir), 0o640)
  expect(() => readHostKey(dataDir)).toThrow(`${hostKeyFile(dataDir)} can be read by other users`)
  expect(() => readHostKey(dataDir, 'win32')).not.toThrow() // Windows: the user's AppData ACL protects it
})

test('proofs: only the key holder can make one, and a host proof never passes as an app proof', () => {
  const key = writeHostKey(dataDir)
  const nonce = newNonce()
  expect(nonce).toMatch(/^[0-9a-f]{64}$/)
  expect(newNonce()).not.toBe(nonce)
  const host = proofFor(key, 'host', nonce)
  expect(checkProof(key, 'host', nonce, host)).toBe(true)
  expect(checkProof(key, 'app', nonce, host)).toBe(false)
  expect(checkProof(key, 'host', newNonce(), host)).toBe(false)
  expect(checkProof(Buffer.alloc(32, 1), 'host', nonce, host)).toBe(false)
  for (const junk of [undefined, '', 'zz', host.toUpperCase(), host.slice(1), 42]) expect(checkProof(key, 'host', nonce, junk)).toBe(false)
})

test('the key file never holds anything but the hex key', () => {
  writeHostKey(dataDir)
  expect(readFileSync(hostKeyFile(dataDir), 'utf8')).toMatch(/^[0-9a-f]{64}$/)
  expect(join(dataDir, 'host.key')).toBe(hostKeyFile(dataDir))
})
