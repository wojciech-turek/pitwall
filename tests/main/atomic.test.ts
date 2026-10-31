import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { renameOver, writeFileAtomic } from '../../src/main/atomic'
import { WINDOWS } from '../helpers/processes'

test('concurrent writers never collide and leave no temp files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pitwall-atomic-'))
  const file = join(dir, 'claude-id')
  await Promise.all(Array.from({ length: 20 }, (_, i) => writeFileAtomic(file, `id-${i}\n`)))
  expect(await readFile(file, 'utf8')).toMatch(/^id-\d+\n$/)
  expect(await readdir(dir)).toEqual(['claude-id'])
  await writeFileAtomic(join(dir, 'env.sh'), 'x', 0o600)
  // (Windows has no POSIX modes: the user's profile ACL protects the data dir.)
  if (!WINDOWS) expect((await stat(join(dir, 'env.sh'))).mode & 0o777).toBe(0o600)
})

test('Windows: replacing a file someone has open is retried, backing off, for a while; then it fails', async () => {
  const busy = (n: number) => {
    let calls = 0
    const rename = async (): Promise<void> => {
      if (++calls <= n) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    }
    return { rename, calls: () => calls }
  }
  const slow = busy(8) // 25 + 50 + 100 + 200 × 5 ms of waiting: past the old 0.5 s
  const t0 = Date.now()
  await renameOver('a', 'b', 'win32', { rename: slow.rename })
  expect(slow.calls()).toBe(9)
  expect(Date.now() - t0).toBeGreaterThanOrEqual(1000)
  const stuck = busy(1000)
  await expect(renameOver('a', 'b', 'win32', { rename: stuck.rename, retryForMs: 300 })).rejects.toThrow('EPERM')
  const mac = busy(1)
  await expect(renameOver('a', 'b', 'darwin', { rename: mac.rename })).rejects.toThrow('EPERM') // only Windows waits
  expect(mac.calls()).toBe(1)
})
