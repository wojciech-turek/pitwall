import { afterEach, describe, expect, test, vi } from 'vitest'

const KEY = 'pitwall.sidebarWidth.v1'

function fakeStorage(initial?: string) {
  const data = new Map<string, string>(initial === undefined ? [] : [[KEY, initial]])
  vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) } })
  return data
}

async function fresh() {
  vi.resetModules()
  return import('../../src/renderer/src/state/sidebarWidth')
}

afterEach(() => { vi.unstubAllGlobals() })

describe('sidebar width', () => {
  test('kept between 200 and 480px, whole pixels; nonsense gives the default 260', async () => {
    fakeStorage()
    const { clampSidebarWidth } = await fresh()
    expect([100, 200, 333.6, 480, 1000].map(clampSidebarWidth)).toEqual([200, 200, 334, 480, 480])
    expect(clampSidebarWidth(Number.NaN)).toBe(260)
  })

  test('starts at 260 with nothing saved, or a bad saved value', async () => {
    fakeStorage()
    expect((await fresh()).useSidebarWidth.getState().width).toBe(260)
    fakeStorage('"wide"')
    expect((await fresh()).useSidebarWidth.getState().width).toBe(260)
    vi.stubGlobal('localStorage', undefined)
    expect((await fresh()).useSidebarWidth.getState().width).toBe(260)
  })

  test('a drag changes the width live and saves it when it ends; the next run starts there', async () => {
    const data = fakeStorage()
    const { useSidebarWidth } = await fresh()
    useSidebarWidth.getState().setWidth(310)
    useSidebarWidth.getState().setWidth(9999)
    expect(useSidebarWidth.getState().width).toBe(480)
    expect(data.has(KEY)).toBe(false) // not saved on every move
    useSidebarWidth.getState().save()
    expect(data.get(KEY)).toBe('480')
    expect((await fresh()).useSidebarWidth.getState().width).toBe(480)
  })

  test('reset goes back to 260 and saves it', async () => {
    const data = fakeStorage('400')
    const { useSidebarWidth } = await fresh()
    expect(useSidebarWidth.getState().width).toBe(400)
    useSidebarWidth.getState().reset()
    expect(useSidebarWidth.getState().width).toBe(260)
    expect(data.get(KEY)).toBe('260')
  })

  test('storage that throws is ignored', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('full') } })
    const { useSidebarWidth } = await fresh()
    expect(useSidebarWidth.getState().width).toBe(260)
    useSidebarWidth.getState().setWidth(300)
    useSidebarWidth.getState().save()
    expect(useSidebarWidth.getState().width).toBe(300)
  })
})
