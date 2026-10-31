import { expect, test } from 'vitest'
import { exec } from '../../src/main/exec'
import { WINDOWS } from '../helpers/processes'

test.skipIf(WINDOWS)('returns code and output without throwing', async () => {
  expect(await exec('sh', ['-c', 'echo hi; echo err >&2; exit 3'])).toEqual({ code: 3, stdout: 'hi\n', stderr: 'err\n' })
})
test.skipIf(WINDOWS)('pipes input', async () => {
  expect((await exec('cat', [], { input: 'abc' })).stdout).toBe('abc')
})
test('missing binary throws naming it', async () => {
  await expect(exec('nope-bin-xyz', [])).rejects.toThrow(/nope-bin-xyz/)
})
test.skipIf(WINDOWS)('timeout kills', async () => {
  expect((await exec('sleep', ['5'], { timeoutMs: 200 })).code).not.toBe(0)
})
test('a program found by path: exit code, output, input and timeout (every platform; the ones above use sh)', async () => {
  const node = (script: string, o: Parameters<typeof exec>[2] = {}) => exec(process.execPath, ['-e', script], o)
  expect(await node("process.stdout.write('hi\\n'); process.stderr.write('err\\n'); process.exit(3)"))
    .toEqual({ code: 3, stdout: 'hi\n', stderr: 'err\n' })
  expect((await node('process.stdin.pipe(process.stdout)', { input: 'abc' })).stdout).toBe('abc')
  expect((await node('setTimeout(() => {}, 5000)', { timeoutMs: 200 })).code).not.toBe(0)
})
