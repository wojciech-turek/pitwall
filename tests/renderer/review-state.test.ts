import { afterEach, describe, expect, test, vi } from 'vitest'

const KEY = 'pitwall.review.v1'
const draft = { path: 'a.ts', fromLine: 1, toLine: 2, quote: 'q', note: 'n' }

function fakeStorage(initial?: string) {
  const data = new Map<string, string>(initial === undefined ? [] : [[KEY, initial]])
  vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) } })
  return data
}

async function fresh() {
  vi.resetModules()
  return import('../../src/renderer/src/state/review')
}

afterEach(() => { vi.unstubAllGlobals() })

describe('review drafts', () => {
  test('add gives each comment a unique id', async () => {
    fakeStorage()
    const { useReview } = await fresh()
    useReview.getState().add('s1', draft)
    useReview.getState().add('s1', draft)
    const list = useReview.getState().byId.s1
    expect(list).toHaveLength(2)
    expect(list[0].id).not.toBe(list[1].id)
    expect(list[0]).toMatchObject(draft)
  })

  test('remove drops only that comment; clear empties the session and leaves others', async () => {
    fakeStorage()
    const { useReview } = await fresh()
    const s = useReview.getState()
    s.add('s1', draft); s.add('s1', { ...draft, note: 'm' }); s.add('s2', draft)
    const [a, b] = useReview.getState().byId.s1
    useReview.getState().remove('s1', a.id)
    expect(useReview.getState().byId.s1.map((x) => x.id)).toEqual([b.id])
    useReview.getState().clear('s1')
    expect(useReview.getState().byId.s1 ?? []).toEqual([])
    expect(useReview.getState().byId.s2).toHaveLength(1)
  })

  test('drafts are saved and the next run starts with them; bad saved data is ignored', async () => {
    const data = fakeStorage()
    const { useReview } = await fresh()
    useReview.getState().add('s1', draft)
    expect(JSON.parse(data.get(KEY)!).s1).toHaveLength(1)
    expect((await fresh()).useReview.getState().byId.s1).toHaveLength(1)
    fakeStorage('not json')
    expect((await fresh()).useReview.getState().byId).toEqual({})
    fakeStorage('[1]')
    expect((await fresh()).useReview.getState().byId).toEqual({})
  })

  test('storage that throws is ignored', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('full') } })
    const { useReview } = await fresh()
    expect(() => useReview.getState().add('s1', draft)).not.toThrow()
    expect(useReview.getState().byId.s1).toHaveLength(1)
  })
})
