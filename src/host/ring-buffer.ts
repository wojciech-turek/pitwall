const INITIAL = 16 * 1024

/**
 * The most recent `capacity` bytes of a stream; older bytes are dropped. Memory grows with use, up to `capacity`.
 */
export class RingBuffer {
  private buf: Buffer
  private start = 0
  private len = 0
  private droppedBytes = 0

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('capacity must be a positive integer')
    this.buf = Buffer.alloc(Math.min(INITIAL, capacity))
  }

  get size(): number {
    return this.len
  }

  /** Bytes dropped so far to stay within capacity. */
  get dropped(): number {
    return this.droppedBytes
  }

  push(data: Uint8Array): void {
    const n = data.length
    if (n === 0) return
    if (n >= this.capacity) {
      this.droppedBytes += this.len + n - this.capacity
      this.ensure(this.capacity)
      this.buf.set(data.subarray(n - this.capacity), 0)
      this.start = 0
      this.len = this.capacity
      return
    }
    if (this.len + n > this.buf.length && this.buf.length < this.capacity) this.ensure(Math.min(this.capacity, Math.max(this.buf.length * 2, this.len + n)))
    const cap = this.buf.length
    const overflow = Math.max(0, this.len + n - cap)
    const end = (this.start + this.len) % cap
    const first = Math.min(n, cap - end)
    this.buf.set(data.subarray(0, first), end)
    if (first < n) this.buf.set(data.subarray(first), 0)
    this.len = Math.min(cap, this.len + n)
    if (overflow > 0) {
      this.start = (this.start + overflow) % cap
      this.droppedBytes += overflow
    }
  }

  /** The stored bytes, oldest first (a copy). */
  snapshot(): Buffer {
    const out = Buffer.allocUnsafe(this.len)
    const cap = this.buf.length
    const first = Math.min(this.len, cap - this.start)
    this.buf.copy(out, 0, this.start, this.start + first)
    if (first < this.len) this.buf.copy(out, first, 0, this.len - first)
    return out
  }

  /** Grows the backing buffer to `size` bytes, keeping the contents in order from index 0. */
  private ensure(size: number): void {
    if (this.buf.length >= size) return
    const next = Buffer.alloc(size)
    this.snapshot().copy(next, 0)
    this.buf = next
    this.start = 0
  }
}
