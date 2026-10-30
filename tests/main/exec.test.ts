import { expect, test } from 'vitest'
import { exec } from '../../src/main/exec'

test('returns code and output without throwing', async () => {
  expect(await exec('sh', ['-c', 'echo hi; echo err >&2; exit 3'])).toEqual({ code: 3, stdout: 'hi\n', stderr: 'err\n' })
})
test('pipes input', async () => {
  expect((await exec('cat', [], { input: 'abc' })).stdout).toBe('abc')
})
test('missing binary throws naming it', async () => {
  await expect(exec('nope-bin-xyz', [])).rejects.toThrow(/nope-bin-xyz/)
})
test('timeout kills', async () => {
  expect((await exec('sleep', ['5'], { timeoutMs: 200 })).code).not.toBe(0)
})
