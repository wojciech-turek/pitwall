import { createServer } from 'node:net'

/** Each session gets a block of `size` ports from here, the first of which is its $PITWALL_PORT. */
export const PORT_RANGE = { first: 40000, last: 48990, size: 10 } as const

/** True when nothing is listening on the port on this machine. */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

/**
 * Hands out port blocks. A block it returned is remembered for the app's run and never offered again, so sessions
 * starting at once can't get the same one. It is reserved before the first await, so concurrent calls don't race.
 */
export class PortAllocator {
  private readonly reserved = new Set<number>()
  private readonly isFree: (port: number) => Promise<boolean>

  constructor(o: { isFree?: (port: number) => Promise<boolean> } = {}) {
    this.isFree = o.isFree ?? portFree
  }

  /**
   * Takes a particular block (a resumed session's old one) if it isn't taken or reserved and its first port is free.
   * Reserved before the check, like allocate, so a block can't be handed to two sessions.
   */
  async claim(base: number, taken: number[]): Promise<boolean> {
    if (taken.includes(base) || this.reserved.has(base)) return false
    this.reserved.add(base)
    let free = false
    try {
      free = await this.isFree(base)
    } finally {
      if (!free) this.reserved.delete(base)
    }
    return free
  }

  async allocate(taken: number[]): Promise<number> {
    const skip = new Set(taken)
    for (let base = PORT_RANGE.first; base <= PORT_RANGE.last; base += PORT_RANGE.size) {
      if (skip.has(base) || this.reserved.has(base)) continue
      this.reserved.add(base)
      let free = false
      try {
        free = await this.isFree(base)
      } finally {
        if (!free) this.reserved.delete(base)
      }
      if (free) return base
    }
    throw new Error(`No free port block left (${PORT_RANGE.first}–${PORT_RANGE.last + PORT_RANGE.size - 1}).`)
  }
}
