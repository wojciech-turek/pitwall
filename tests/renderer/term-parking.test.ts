import { describe, expect, test, vi } from 'vitest'
import { ParkingLot, PARK_AFTER_MS } from '../../src/renderer/src/terminal/parking'

function setup() {
  const timers = new Map<number, () => void>()
  let next = 1
  const park = vi.fn()
  const lot = new ParkingLot({
    afterMs: 100,
    park,
    setTimer: (fn) => { timers.set(next, fn); return next++ },
    clearTimer: (t) => { timers.delete(t as number) }
  })
  const fire = () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn() } }
  return { lot, park, fire, timers }
}

describe('ParkingLot', () => {
  test('exports a one-minute default', () => {
    expect(PARK_AFTER_MS).toBe(60_000)
  })

  test('parks a key hidden for afterMs', () => {
    const { lot, park, fire } = setup()
    lot.shown('a'); lot.hidden('a')
    fire()
    expect(park).toHaveBeenCalledTimes(1)
    expect(park).toHaveBeenCalledWith('a')
    expect(lot.parked('a')).toBe(true)
  })

  test('showing again before the timer cancels it', () => {
    const { lot, park, fire } = setup()
    lot.shown('a'); lot.hidden('a'); lot.shown('a')
    fire()
    expect(park).not.toHaveBeenCalled()
  })

  test('a key shown twice parks only after both hide', () => {
    const { lot, park, fire } = setup()
    lot.shown('a'); lot.shown('a'); lot.hidden('a')
    fire()
    expect(park).not.toHaveBeenCalled()
    lot.hidden('a')
    fire()
    expect(park).toHaveBeenCalledWith('a')
  })

  test('forget cancels and resets', () => {
    const { lot, park, fire } = setup()
    lot.shown('a'); lot.hidden('a'); lot.forget('a')
    fire()
    expect(park).not.toHaveBeenCalled()
    expect(lot.parked('a')).toBe(false)
  })

  test('hidden without shown is ignored', () => {
    const { lot, timers } = setup()
    lot.hidden('a')
    expect(timers.size).toBe(0)
  })

  test('shown after parked clears parked', () => {
    const { lot, fire } = setup()
    lot.shown('a'); lot.hidden('a'); fire()
    expect(lot.parked('a')).toBe(true)
    lot.shown('a')
    expect(lot.parked('a')).toBe(false)
  })
})

describe('ParkingLot hidden twice', () => {
  test('hidden on an already hidden key does not re-arm the timer', () => {
    const { lot, park, fire, timers } = setup()
    lot.shown('a'); lot.hidden('a'); fire()
    expect(park).toHaveBeenCalledTimes(1)
    lot.hidden('a')
    expect(timers.size).toBe(0)
    fire()
    expect(park).toHaveBeenCalledTimes(1)
  })
})
