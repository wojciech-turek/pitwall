import { PARK_AFTER_MS } from '@shared/parking'

export { PARK_AFTER_MS }

type Timer = unknown

/**
 * Tracks which terminals are on screen and tells us when one has been hidden for
 * `afterMs`. A key can be mounted more than once, so it counts mounts and only
 * starts the clock when the last one goes away.
 */
export class ParkingLot {
  private counts = new Map<string, number>()
  private timers = new Map<string, Timer>()
  private parkedKeys = new Set<string>()
  private afterMs: number
  private park: (key: string) => void
  private setTimer: (fn: () => void, ms: number) => Timer
  private clearTimer: (t: Timer) => void

  constructor(o: {
    afterMs: number
    park: (key: string) => void
    setTimer?: (fn: () => void, ms: number) => unknown
    clearTimer?: (t: unknown) => void
  }) {
    this.afterMs = o.afterMs
    this.park = o.park
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  }

  shown(key: string): void {
    this.cancel(key)
    this.parkedKeys.delete(key)
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1)
  }

  hidden(key: string): void {
    const n = this.counts.get(key)
    if (n === undefined) return
    if (n > 1) { this.counts.set(key, n - 1); return }
    this.counts.set(key, 0)
    this.cancel(key)
    this.timers.set(key, this.setTimer(() => {
      this.timers.delete(key)
      this.parkedKeys.add(key)
      this.park(key)
    }, this.afterMs))
  }

  forget(key: string): void {
    this.cancel(key)
    this.counts.delete(key)
    this.parkedKeys.delete(key)
  }

  /** True from the moment a key is parked until it is shown again. */
  parked(key: string): boolean {
    return this.parkedKeys.has(key)
  }

  private cancel(key: string): void {
    const t = this.timers.get(key)
    if (t === undefined) return
    this.clearTimer(t)
    this.timers.delete(key)
  }
}
