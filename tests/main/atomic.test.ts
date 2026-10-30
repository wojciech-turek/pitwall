import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { writeFileAtomic } from '../../src/main/atomic'

test('concurrent writers never collide and leave no temp files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pitwall-atomic-'))
  const file = join(dir, 'claude-id')
  await Promise.all(Array.from({ length: 20 }, (_, i) => writeFileAtomic(file, `id-${i}\n`)))
  expect(await readFile(file, 'utf8')).toMatch(/^id-\d+\n$/)
  expect(await readdir(dir)).toEqual(['claude-id'])
  await writeFileAtomic(join(dir, 'env.sh'), 'x', 0o600)
  expect((await stat(join(dir, 'env.sh'))).mode & 0o777).toBe(0o600)
})
