import { describe, expect, test } from 'vitest'
import { mkdtemp, mkdir, readdir, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec } from '../../src/main/exec'

const SCRIPT = join(process.cwd(), 'resources/bin/pitwall-statusline')
const baseEnv = (): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.PITWALL_USER_STATUSLINE
  return env
}
const run = (dir: string, input: string, userCommand?: string, cwd?: string) =>
  exec(SCRIPT, [dir], { env: { ...baseEnv(), ...(userCommand ? { PITWALL_USER_STATUSLINE: userCommand } : {}) }, input, cwd })

async function sessionDir(): Promise<string> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pitwall-sl-')))
  const dir = join(base, 'App Support', 'sessions', 's_1')
  await mkdir(dir, { recursive: true })
  return dir
}

const payload = (pct: number) => JSON.stringify({
  session_id: 'abc', rate_limits: { five_hour: { used_percentage: pct, resets_at: 1_900_000_000 } }
})

describe('pitwall-statusline', () => {
  test('keeps the JSON in statusline.json, prints nothing without a chained command, exit 0', async () => {
    const dir = await sessionDir()
    const r = await run(dir, payload(42))
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' })
    expect(JSON.parse(await readFile(join(dir, 'statusline.json'), 'utf8'))).toEqual(JSON.parse(payload(42)))
    expect(await readdir(dir)).toEqual(['statusline.json']) // no temp file left behind
  })

  test('a later run replaces the file', async () => {
    const dir = await sessionDir()
    await run(dir, payload(1))
    await run(dir, payload(2))
    expect(JSON.parse(await readFile(join(dir, 'statusline.json'), 'utf8')).rate_limits.five_hour.used_percentage).toBe(2)
  })

  test('chains the user status line: same JSON on stdin, its stdout passed through, run in the same folder', async () => {
    const dir = await sessionDir()
    const cwd = await sessionDir()
    const r = await run(dir, payload(7), `jq -r '"5h " + (.rate_limits.five_hour.used_percentage|tostring)'; pwd -P | tr -d '\\n'`, cwd)
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(`5h 7\n${cwd}`)
    expect(JSON.parse(await readFile(join(dir, 'statusline.json'), 'utf8'))).toEqual(JSON.parse(payload(7)))
  })

  test('a failing chained command: its output still passes, nothing on stderr, exit 0', async () => {
    const dir = await sessionDir()
    const r = await run(dir, payload(3), 'echo partial; echo oops >&2; exit 9')
    expect(r).toMatchObject({ code: 0, stdout: 'partial\n', stderr: '' })
    const missing = await run(dir, payload(3), 'definitely-not-a-command-xyz')
    expect(missing).toMatchObject({ code: 0, stdout: '', stderr: '' })
  })

  test('missing session dir: nothing written or created, still exit 0 and still chains', async () => {
    const dir = join(await sessionDir(), 'gone')
    const r = await run(dir, payload(5), 'echo hi')
    expect(r).toMatchObject({ code: 0, stdout: 'hi\n', stderr: '' })
    await expect(readdir(dir)).rejects.toThrow(/ENOENT/)
    expect(await run('', payload(5))).toMatchObject({ code: 0, stdout: '', stderr: '' })
  })

  test('parallel runs always leave one complete payload', async () => {
    const dir = await sessionDir()
    const big = (n: number) => JSON.stringify({ n, pad: 'x'.repeat(50_000), rate_limits: {} })
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => run(dir, big(i))))
    expect(rs.every((r) => r.code === 0)).toBe(true)
    const kept = JSON.parse(await readFile(join(dir, 'statusline.json'), 'utf8'))
    expect(kept.pad).toHaveLength(50_000)
    expect(await readdir(dir)).toEqual(['statusline.json'])
  })
})
