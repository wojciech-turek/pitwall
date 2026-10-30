/**
 * Pitwall's PowerShell hook and status line, run as Claude Code runs them on Windows (the hook in exec form, the
 * status line through Git Bash or PowerShell). The same cases as hook-script.test.ts and statusline-script.test.ts
 * for the sh versions. Windows only (Task 4's runner); skipped elsewhere.
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { parseEventLine } from '../../src/main/hooks/events'
import { windowsHookCommand, windowsStatusLineCommand } from '../../src/main/hooks/settings'
import { findGitBash, windowsPowerShell } from '../../src/main/platform'
import { isFile } from '../../src/main/exec'

const BIN = join(process.cwd(), 'resources', 'bin')
const POWERSHELL = windowsPowerShell(process.env)

interface Result { code: number | null; stdout: string; stderr: string }

/** Starts a program with no shell (as exec form does), feeding `input`. */
function run(file: string, args: string[], input: string, o: { env?: Record<string, string>; cwd?: string } = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: o.env ?? (process.env as Record<string, string>), cwd: o.cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d })
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

/** A folder like Pitwall's on Windows: spaces and a non-ASCII letter in the path. */
async function folder(): Promise<string> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pitwall wïn-')))
  const dir = join(base, 'App Data', 'sessions', 's_1')
  await mkdir(dir, { recursive: true })
  return dir
}

const hook = (file: string, input: string) => {
  const h = windowsHookCommand(POWERSHELL, join(BIN, 'pitwall-hook.ps1'), file, 's_test')
  return run(h.command, h.args, input)
}
const lines = async (f: string) => (await readFile(f, 'utf8')).split('\n').filter(Boolean)

describe.skipIf(process.platform !== 'win32')('pitwall-hook.ps1', () => {
  test('writes one compact line like the sh hook, nothing on stdout, exit 0', async () => {
    const f = join(await folder(), 'events.jsonl')
    const r = await hook(f, '{"hook_event_name":"PreToolUse","session_id":"abc","tool_name":"Bash","tool_input":{"command":"ls"}}')
    expect(r).toMatchObject({ code: 0, stdout: '' })
    const ls = await lines(f)
    expect(ls).toHaveLength(1)
    expect(ls[0]).toMatch(/^\{"c":"s_test","t":\d+,"e":"PreToolUse","sid":"abc","tool":"Bash","nt":null,"src":null,"reason":null,"msg":null,"err":null\}$/)
    expect(Math.abs(parseEventLine(ls[0])!.t - Date.now())).toBeLessThan(60_000)
  })

  test('message, error object and non-ASCII text, cut to 300 characters as jq counts them', async () => {
    const f = join(await folder(), 'events.jsonl')
    await hook(f, JSON.stringify({ hook_event_name: 'Stop', session_id: 'x', last_assistant_message: 'Zażółć 🧾 '.repeat(100) }))
    await hook(f, JSON.stringify({ hook_event_name: 'StopFailure', session_id: 'x', message: 'fallback', error: { type: 'rate_limit', n: 1 } }))
    await hook(f, JSON.stringify({ hook_event_name: 'Notification', session_id: 'x', notification_type: 'permission_prompt', last_assistant_message: false, message: 'Needs "you"\n' }))
    const [stop, failure, note] = (await lines(f)).map((l) => parseEventLine(l)!)
    expect([...(stop.msg as string)]).toHaveLength(300)
    expect(stop.msg).toBe([...'Zażółć 🧾 '.repeat(100)].slice(0, 300).join(''))
    expect(failure).toMatchObject({ msg: 'fallback', err: '{"type":"rate_limit","n":1}' })
    expect(note).toMatchObject({ nt: 'permission_prompt', msg: 'Needs "you"\n' })
  })

  test('invalid stdin: exit 0, nothing written', async () => {
    const f = join(await folder(), 'events.jsonl')
    expect(await hook(f, 'not json {')).toMatchObject({ code: 0, stdout: '' })
    await expect(readFile(f, 'utf8')).rejects.toThrow(/ENOENT/)
  })

  test('creates the events folder; a payload over 2 MB still gets its line', async () => {
    const f = join(await folder(), 'new dir', 'events.jsonl')
    const r = await hook(f, JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'p', tool_name: 'Write', tool_input: { content: 'z'.repeat(3_000_000) } }))
    expect(r.code).toBe(0)
    expect(parseEventLine((await lines(f))[0])).toMatchObject({ e: 'PostToolUse', tool: 'Write' })
  })

  test('30 at once with 100 KB payloads: 30 whole lines', async () => {
    const f = join(await folder(), 'events.jsonl')
    const body = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'p', tool_name: 'Write', tool_input: { content: 'z'.repeat(100_000) } })
    const rs = await Promise.all(Array.from({ length: 30 }, () => hook(f, body)))
    expect(rs.every((r) => r.code === 0)).toBe(true)
    const ls = await lines(f)
    expect(ls).toHaveLength(30)
    expect(ls.every((l) => parseEventLine(l)?.e === 'PostToolUse')).toBe(true)
  })
})

describe.skipIf(process.platform !== 'win32')('pitwall-statusline.ps1', () => {
  const payload = (pct: number) => JSON.stringify({ session_id: 'abc', rate_limits: { five_hour: { used_percentage: pct, resets_at: 1_900_000_000 } } })
  const env = (extra: Record<string, string> = {}): Record<string, string> => {
    const e = { ...(process.env as Record<string, string>) }
    delete e.PITWALL_USER_STATUSLINE
    delete e.PITWALL_GIT_BASH
    return { ...e, ...extra }
  }
  /** As Claude Code runs a status line: through PowerShell (no Git Bash) — the command reads the same in Git Bash. */
  const statusLine = (dir: string, input: string, extra: Record<string, string> = {}, cwd?: string) => {
    const command = windowsStatusLineCommand(join(BIN, 'pitwall-statusline.ps1'), dir)!
    return run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', command], input, { env: env(extra), cwd })
  }

  test('keeps the JSON in statusline.json, prints nothing without a chained command, exit 0', async () => {
    const dir = await folder()
    const r = await statusLine(dir, payload(42))
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' })
    expect(JSON.parse(await readFile(join(dir, 'statusline.json'), 'utf8'))).toEqual(JSON.parse(payload(42)))
    expect(await readdir(dir)).toEqual(['statusline.json'])
    await statusLine(dir, payload(2))
    expect(JSON.parse(await readFile(join(dir, 'statusline.json'), 'utf8')).rate_limits.five_hour.used_percentage).toBe(2)
  })

  test("chains the user's status line in PowerShell: same JSON on stdin, its output passed through byte for byte", async () => {
    const dir = await folder()
    const user = '$j = [Console]::In.ReadToEnd() | ConvertFrom-Json; [Console]::Out.Write("5h " + $j.rate_limits.five_hour.used_percentage)'
    const r = await statusLine(dir, payload(7), { PITWALL_USER_STATUSLINE: user })
    expect(r).toMatchObject({ code: 0, stdout: '5h 7', stderr: '' })
  })

  test.skipIf(!findGitBash(process.env, isFile))("chains it in Git Bash when Claude Code would use Git Bash", async () => {
    const dir = await folder()
    const bash = findGitBash(process.env, isFile)!
    const r = await statusLine(dir, payload(9), {
      // (tr: grep ends its match with a newline, which the script passes on byte for byte too.)
      PITWALL_USER_STATUSLINE: `read -r j; printf '%s' "$j" | grep -o '"used_percentage":[0-9]*' | tr -d '\n'; printf ' ✓'`, PITWALL_GIT_BASH: bash
    })
    expect(r).toMatchObject({ code: 0, stdout: '"used_percentage":9 ✓', stderr: '' })
  })

  test('a failing chained command: its output still passes, nothing on stderr, exit 0; a missing dir is fine', async () => {
    const dir = await folder()
    expect(await statusLine(dir, payload(3), { PITWALL_USER_STATUSLINE: 'Write-Output partial; Write-Error oops; exit 9' }))
      .toMatchObject({ code: 0, stderr: '' })
    expect(await statusLine(join(dir, 'gone'), payload(5), { PITWALL_USER_STATUSLINE: '[Console]::Out.Write("hi")' }))
      .toMatchObject({ code: 0, stdout: 'hi', stderr: '' })
    await expect(readdir(join(dir, 'gone'))).rejects.toThrow(/ENOENT/)
  })

  test('parallel runs always leave one complete payload', async () => {
    const dir = await folder()
    const big = (n: number) => JSON.stringify({ n, pad: 'x'.repeat(50_000), rate_limits: {} })
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => statusLine(dir, big(i))))
    expect(rs.every((r) => r.code === 0)).toBe(true)
    expect(JSON.parse(await readFile(join(dir, 'statusline.json'), 'utf8')).pad).toHaveLength(50_000)
    expect(await readdir(dir)).toEqual(['statusline.json'])
  })
})
