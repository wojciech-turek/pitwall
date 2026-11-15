import { describe, expect, test } from 'vitest'
import { mkdtemp, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec } from '../../src/main/exec'
import { parseEventLine } from '../../src/main/hooks/events'

const HOOK = join(process.cwd(), 'resources/bin/pitwall-hook')
const run = (file: string, input: string) =>
  exec(HOOK, [file, 's_test'], { env: { ...process.env } as Record<string, string>, input })

async function eventsFile(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'pitwall-hook-'))
  const dir = join(base, 'Application Support', 'sessions')
  await mkdir(join(base, 'Application Support'), { recursive: true })
  return join(dir, 'events.jsonl')
}
const lines = async (f: string) => (await readFile(f, 'utf8')).split('\n').filter(Boolean)

describe('pitwall-hook', () => {
  test('writes one compact line, nothing on stdout, exit 0', async () => {
    const f = await eventsFile()
    const r = await run(f, '{"hook_event_name":"PreToolUse","session_id":"abc","tool_name":"Bash","tool_input":{"command":"ls"}}')
    expect(r.stdout).toBe('')
    expect(r.code).toBe(0)
    const ls = await lines(f)
    expect(ls).toHaveLength(1)
    const ev = parseEventLine(ls[0])
    expect(ev).toMatchObject({ c: 's_test', e: 'PreToolUse', tool: 'Bash', sid: 'abc' })
    expect(typeof ev!.t).toBe('number')
  })

  test('invalid stdin -> exit 0, no line', async () => {
    const f = await eventsFile()
    const r = await run(f, 'not json {')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
    await expect(readFile(f, 'utf8')).rejects.toThrow(/ENOENT/)
  })

  test('msg truncated to 300 chars', async () => {
    const f = await eventsFile()
    await run(f, JSON.stringify({ hook_event_name: 'Stop', session_id: 'x', last_assistant_message: 'a'.repeat(1000) }))
    const ev = parseEventLine((await lines(f))[0])
    expect(ev!.msg).toHaveLength(300)
  })

  test('subagent events carry the agent id and type', async () => {
    const f = await eventsFile()
    await run(f, JSON.stringify({ hook_event_name: 'SubagentStart', session_id: 's', agent_id: 'a1', agent_type: 'Explore' }))
    expect(parseEventLine((await lines(f))[0])).toMatchObject({ e: 'SubagentStart', aid: 'a1', at: 'Explore', desc: null })
  })

  test('the Agent tool\'s description is recorded as desc, cut to 120; other tools get null', async () => {
    const f = await eventsFile()
    const pre = (tool_name: string, tool_input: unknown) =>
      run(f, JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', tool_name, tool_input }))
    await pre('Agent', { description: 'Find the bug' })
    await pre('Agent', { description: 'd'.repeat(200) })
    await pre('Agent', { prompt: 'no description' })
    await pre('Agent', { description: 5 })
    await pre('Bash', { command: 'ls', description: 'List files' })
    const evs = (await lines(f)).map((l) => parseEventLine(l)!)
    expect(evs.map((e) => e.desc)).toEqual(['Find the bug', 'd'.repeat(120), null, null, null])
    expect(evs[0].aid).toBeNull()
  })

  test('50 parallel invocations with 100KB tool_input -> 50 valid lines', async () => {
    const f = await eventsFile()
    const body = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'p', tool_name: 'Write', tool_input: { content: 'z'.repeat(100_000) } })
    const rs = await Promise.all(Array.from({ length: 50 }, () => run(f, body)))
    expect(rs.every((r) => r.code === 0)).toBe(true)
    const ls = await lines(f)
    expect(ls).toHaveLength(50)
    expect(ls.every((l) => parseEventLine(l)?.e === 'PostToolUse')).toBe(true)
  })
})
