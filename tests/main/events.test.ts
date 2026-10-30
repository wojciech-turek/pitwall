import { describe, expect, test } from 'vitest'
import { mkdtemp, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendEvent, EventTailer, parseEventLine } from '../../src/main/hooks/events'
import type { HookEvent } from '../../src/shared/types'

const tmp = async () => join(await mkdtemp(join(tmpdir(), 'pitwall-ev-')), 'events.jsonl')
const ev = (t: number, e = 'Stop'): HookEvent => ({ c: 's', t, e })
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('events', () => {
  test('parseEventLine rejects garbage and missing fields', () => {
    expect(parseEventLine('')).toBeNull()
    expect(parseEventLine('{')).toBeNull()
    expect(parseEventLine('{"e":"Stop"}')).toBeNull()
    expect(parseEventLine('{"c":"s","t":1,"e":"Stop"}')).toMatchObject({ c: 's', t: 1, e: 'Stop' })
  })

  test('readAll skips garbage line and holds back partial trailing line', async () => {
    const f = await tmp()
    const v = JSON.stringify(ev(1))
    await writeFile(f, `${v}\ngarbage\n${v}\n{"c":"s","t":1,"e":"St`)
    const t = new EventTailer(f, () => {})
    expect(await t.readAll()).toHaveLength(2)
  })

  test('tailer delivers appended lines once, including a completed partial line', async () => {
    const f = await tmp()
    await writeFile(f, `${JSON.stringify(ev(1))}\n{"c":"s","t":2,"e":"St`)
    const got: HookEvent[] = []
    const t = new EventTailer(f, (e) => got.push(e), 50)
    expect(await t.readAll()).toHaveLength(1)
    t.start()
    await appendFile(f, `op"}\n${JSON.stringify(ev(3))}\n`)
    await until(() => got.length >= 2)
    await new Promise((r) => setTimeout(r, 200))
    t.stop()
    expect(got.map((e) => e.t)).toEqual([2, 3])
    expect(got[0].e).toBe('Stop')
  })

  test('missing file is picked up when created', async () => {
    const f = await tmp()
    const got: HookEvent[] = []
    const t = new EventTailer(f, (e) => got.push(e), 30)
    expect(await t.readAll()).toEqual([])
    t.start()
    await appendEvent(f, ev(5))
    await until(() => got.length === 1)
    t.stop()
  })

  test('appendEvent + tailer round trip', async () => {
    const f = await tmp()
    const got: HookEvent[] = []
    const t = new EventTailer(f, (e) => got.push(e), 30)
    await t.readAll()
    t.start()
    await appendEvent(f, ev(7, 'UserPromptSubmit'))
    await until(() => got.length === 1)
    t.stop()
    expect(got[0]).toEqual(ev(7, 'UserPromptSubmit'))
  })
})
