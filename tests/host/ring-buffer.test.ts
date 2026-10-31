import { describe, expect, test } from 'vitest'
import { RingBuffer } from '../../src/host/ring-buffer'

const b = (s: string): Buffer => Buffer.from(s, 'latin1')
const text = (r: RingBuffer): string => r.snapshot().toString('latin1')

describe('RingBuffer', () => {
  test('keeps everything below capacity, in order', () => {
    const r = new RingBuffer(10)
    r.push(b('abc'))
    r.push(b(''))
    r.push(b('def'))
    expect(text(r)).toBe('abcdef')
    expect(r.size).toBe(6)
    expect(r.dropped).toBe(0)
  })

  test('drops the oldest bytes past capacity, across the wrap', () => {
    const r = new RingBuffer(5)
    r.push(b('abc'))
    r.push(b('def'))
    expect(text(r)).toBe('bcdef')
    r.push(b('gh'))
    expect(text(r)).toBe('defgh')
    r.push(b('ijkl'))
    expect(text(r)).toBe('hijkl')
    expect(r.dropped).toBe(7)
  })

  test('a chunk bigger than the capacity keeps its tail', () => {
    const r = new RingBuffer(4)
    r.push(b('xy'))
    r.push(b('0123456789'))
    expect(text(r)).toBe('6789')
    expect(r.dropped).toBe(8)
  })

  test('matches a naive model for many random pushes (growth and wrapping)', () => {
    let seed = 42
    const rand = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n }
    const cap = 50_000
    const r = new RingBuffer(cap)
    let all = ''
    for (let i = 0; i < 400; i++) {
      const s = String.fromCharCode(97 + (i % 26)).repeat(rand(2000))
      r.push(b(s))
      all += s
      expect(r.size).toBe(Math.min(cap, all.length))
    }
    expect(text(r)).toBe(all.slice(-cap))
    expect(r.dropped).toBe(Math.max(0, all.length - cap))
  })

  test('memory is bounded by the capacity however much goes through', () => {
    const r = new RingBuffer(1024 * 1024)
    const chunk = Buffer.alloc(64 * 1024, 0x78)
    for (let i = 0; i < 800; i++) r.push(chunk) // 50 MB
    expect(r.size).toBe(1024 * 1024)
    expect((r as unknown as { buf: Buffer }).buf.length).toBe(1024 * 1024)
  })

  test('snapshot is a copy', () => {
    const r = new RingBuffer(8)
    r.push(b('abcd'))
    const s = r.snapshot()
    r.push(b('efgh'))
    expect(s.toString('latin1')).toBe('abcd')
  })

  test('rejects a bad capacity', () => {
    expect(() => new RingBuffer(0)).toThrow()
  })
})
