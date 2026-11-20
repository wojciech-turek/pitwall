import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { agentTranscript, interruptedAt } from '../../src/main/sessions/subagent-watch'

let tmp: string
beforeEach(async () => { tmp = await mkdtemp(join(tmpdir(), 'pitwall-watch-')) })
afterEach(async () => { await rm(tmp, { recursive: true, force: true }) })

const line = (o: object) => JSON.stringify({ isSidechain: true, agentId: 'a1', ...o })
const assistant = line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(9000) }] }, timestamp: '2026-11-19T21:18:55.000Z' })
/** As Claude Code 2.1.328 ends the transcript of a subagent stopped with TaskStop. */
const interrupted = line({
  type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, timestamp: '2026-11-19T21:18:56.684Z'
})

describe('interruptedAt', () => {
  test('the time of the interruption a transcript ends with', async () => {
    const f = join(tmp, 'agent-a1.jsonl')
    await writeFile(f, `${assistant}\n${interrupted}\n`)
    expect(await interruptedAt(f)).toBe(Date.parse('2026-11-19T21:18:56.684Z'))
    const forTool = interrupted.replace('interrupted by user]', 'interrupted by user for tool use]')
    await writeFile(f, `${assistant}\n${forTool}\n`)
    expect(await interruptedAt(f)).toBe(Date.parse('2026-11-19T21:18:56.684Z'))
  })
  test('null while the subagent is at work, was resumed after an interruption, or has no transcript', async () => {
    const f = join(tmp, 'agent-a1.jsonl')
    await writeFile(f, `${assistant}\n`)
    expect(await interruptedAt(f)).toBeNull()
    await writeFile(f, `${interrupted}\n${assistant}\n`)
    expect(await interruptedAt(f)).toBeNull()
    await writeFile(f, `${interrupted}\n${interrupted.slice(0, 40)}`) // a line still being written
    expect(await interruptedAt(f)).toBeNull()
    // The words in what a subagent was asked or said are not an interruption.
    await writeFile(f, line({ type: 'assistant', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] }, timestamp: '2026-11-19T21:18:56.684Z' }) + '\n')
    expect(await interruptedAt(f)).toBeNull()
    expect(await interruptedAt(join(tmp, 'none.jsonl'))).toBeNull()
  })
})

describe('agentTranscript', () => {
  test("finds a subagent's transcript under the conversation, in a workflow's folder too", async () => {
    const cwd = '/Users/me/my proj'
    const conv = join(tmp, 'projects', '-Users-me-my-proj', 'sid-1', 'subagents')
    await mkdir(join(conv, 'workflows', 'wf_1'), { recursive: true })
    await writeFile(join(conv, 'agent-a1.jsonl'), '')
    await writeFile(join(conv, 'workflows', 'wf_1', 'agent-a2.jsonl'), '')
    expect(await agentTranscript(tmp, cwd, 'sid-1', 'a1')).toBe(join(conv, 'agent-a1.jsonl'))
    expect(await agentTranscript(tmp, cwd, 'sid-1', 'a2')).toBe(join(conv, 'workflows', 'wf_1', 'agent-a2.jsonl'))
    expect(await agentTranscript(tmp, cwd, 'sid-1', 'a3')).toBeNull()
    expect(await agentTranscript(tmp, cwd, 'sid-2', 'a1')).toBeNull()
    // The conversation was started in another folder (a session whose folder moved).
    expect(await agentTranscript(tmp, '/elsewhere', 'sid-1', 'a2')).toBe(join(conv, 'workflows', 'wf_1', 'agent-a2.jsonl'))
  })
})
