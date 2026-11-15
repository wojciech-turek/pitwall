import { afterEach, describe, expect, test, vi } from 'vitest'
import type { SubagentRun } from '../../src/shared/types'

const KEY = 'pitwall.subagents.v1'

function fakeStorage(initial?: string) {
  const data = new Map<string, string>(initial === undefined ? [] : [[KEY, initial]])
  vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) } })
  return data
}

async function fresh() {
  vi.resetModules()
  return import('../../src/renderer/src/state/subagentsOpen')
}

afterEach(() => { vi.unstubAllGlobals() })

const run = (state: 'running' | 'done'): SubagentRun => ({ id: Math.random().toString(), type: 'Explore', state, startedAt: 1 })

describe('subagentSummary', () => {
  test('counts running and done runs', async () => {
    fakeStorage()
    const { subagentSummary } = await fresh()
    expect(subagentSummary([run('running'), run('running')])).toBe('2 running')
    expect(subagentSummary([run('running'), run('done'), run('done'), run('done')])).toBe('1 running · 3 done')
    expect(subagentSummary([run('done'), run('done'), run('done')])).toBe('3 done')
    expect(subagentSummary([])).toBe('')
  })
})

describe('subagents open flag', () => {
  test('open by default, and when storage is unreadable', async () => {
    fakeStorage()
    expect((await fresh()).isSubagentsOpen('s1')).toBe(true)
    fakeStorage('not json')
    expect((await fresh()).isSubagentsOpen('s1')).toBe(true)
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('no') }, setItem: () => { throw new Error('no') } })
    const m = await fresh()
    expect(m.isSubagentsOpen('s1')).toBe(true)
    expect(() => m.setSubagentsOpen('s1', false)).not.toThrow()
    expect(m.isSubagentsOpen('s1')).toBe(false)
  })

  test('closing is remembered per session and saved', async () => {
    const data = fakeStorage()
    const m = await fresh()
    m.setSubagentsOpen('s1', false)
    expect(m.isSubagentsOpen('s1')).toBe(false)
    expect(m.isSubagentsOpen('s2')).toBe(true)
    expect(JSON.parse(data.get(KEY)!)).toEqual({ s1: false })
    expect((await fresh()).isSubagentsOpen('s1')).toBe(false)
    m.setSubagentsOpen('s1', true)
    expect(JSON.parse(data.get(KEY)!)).toEqual({})
  })
})

describe('SubagentRows', () => {
  test("they hang one step under their session, at the session's own depth", async () => {
    fakeStorage()
    vi.resetModules()
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { default: SubagentRows } = await import('../../src/renderer/src/components/SubagentRows')
    const session = { id: 's1', title: 'Child', status: 'working', subagents: [run('running')] } as never
    const html = (depth?: number) => renderToStaticMarkup(createElement(SubagentRows, { session, depth, onSelect: () => {} }))
    expect(html()).toContain('data-depth="0"')
    expect(html(2)).toContain('data-depth="2"')
  })
})
