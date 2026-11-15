import { createServer } from 'node:net'
import { describe, expect, test } from 'vitest'
import { PortAllocator, PORT_RANGE, portFree } from '../../src/main/ports'

const always = async () => true

describe('PortAllocator', () => {
  test('the lowest free block', async () => {
    expect(await new PortAllocator({ isFree: always }).allocate([])).toBe(40000)
  })
  test('skips blocks that are taken', async () => {
    expect(await new PortAllocator({ isFree: always }).allocate([40000, 40010])).toBe(40020)
  })
  test('skips a block whose first port is busy', async () => {
    const a = new PortAllocator({ isFree: async (p) => p !== 40000 })
    expect(await a.allocate([])).toBe(40010)
  })
  test('never hands out the same block twice, even when called at once', async () => {
    const a = new PortAllocator({ isFree: always })
    expect(await Promise.all([a.allocate([]), a.allocate([])])).toEqual([40000, 40010])
    expect(await a.allocate([])).toBe(40020)
  })
  test('claim of a free block is true, and allocate then skips it', async () => {
    const a = new PortAllocator({ isFree: always })
    expect(await a.claim(40000, [])).toBe(true)
    expect(await a.allocate([])).toBe(40010)
  })
  test('claim of a taken or reserved block is false', async () => {
    const a = new PortAllocator({ isFree: always })
    expect(await a.claim(40000, [40000])).toBe(false)
    expect(await a.claim(40010, [])).toBe(true)
    expect(await a.claim(40010, [])).toBe(false)
  })
  test('claim of a busy block is false and leaves it unreserved', async () => {
    let busy = true
    const a = new PortAllocator({ isFree: async () => !busy })
    expect(await a.claim(40000, [])).toBe(false)
    busy = false
    expect(await a.allocate([])).toBe(40000)
  })
  test('a claim and an allocate at the same moment never get the same block', async () => {
    const a = new PortAllocator({ isFree: () => new Promise((r) => setImmediate(() => r(true))) })
    const [claimed, got] = await Promise.all([a.claim(40000, []), a.allocate([])])
    expect(claimed).toBe(true)
    expect(got).toBe(40010)
    const b = new PortAllocator({ isFree: () => new Promise((r) => setImmediate(() => r(true))) })
    const [got2, claimed2] = await Promise.all([b.allocate([]), b.claim(40000, [])])
    expect(got2).toBe(40000)
    expect(claimed2).toBe(false)
  })
  test('a busy block is not left reserved', async () => {
    let busy = true
    const a = new PortAllocator({ isFree: async () => !busy })
    await expect(a.allocate([])).rejects.toThrow()
    busy = false
    expect(await a.allocate([])).toBe(40000)
  })
  test('an exhausted range rejects', async () => {
    const a = new PortAllocator({ isFree: always })
    const all: number[] = []
    for (let p = PORT_RANGE.first; p <= PORT_RANGE.last; p += PORT_RANGE.size) all.push(p)
    await expect(a.allocate(all)).rejects.toThrow('No free port block left (40000–48999).')
  })
})

describe('portFree', () => {
  test('false while something listens, true after', async () => {
    const srv = createServer()
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as { port: number }).port
    expect(await portFree(port)).toBe(false)
    await new Promise((r) => srv.close(r))
    expect(await portFree(port)).toBe(true)
  })
})
