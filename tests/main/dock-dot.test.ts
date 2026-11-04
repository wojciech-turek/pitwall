import { expect, test } from 'vitest'
import { DOT_RED, withDot } from '../../src/main/badge'

// An icon-sized bitmap, premultiplied BGRA as nativeImage.toBitmap gives it: dark grey, opaque, with transparent
// corners like the real icon's.
function icon(size = 100): { width: number; height: number; data: Buffer } {
  const data = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if ((x < 10 || x >= 90) && (y < 10 || y >= 90)) continue // a transparent corner
      data.set([0x20, 0x20, 0x20, 0xff], (y * size + x) * 4)
    }
  }
  return { width: size, height: size, data }
}
const px = (b: { width: number; data: Buffer }, x: number, y: number) => [...b.data.subarray((y * b.width + x) * 4, (y * b.width + x) * 4 + 4)]

test('a red dot over the icon\'s top-right corner, where macOS puts its badge', () => {
  const base = icon()
  const dotted = { ...base, data: withDot(base) }
  expect(px(dotted, 84, 16)).toEqual([...DOT_RED, 255]) // its middle: solid red
  expect(px(dotted, 90, 9)).toEqual([...DOT_RED, 255]) // over the transparent corner too
  expect(px(dotted, 50, 50)).toEqual([0x20, 0x20, 0x20, 0xff]) // the rest of the icon is untouched
  expect(px(dotted, 3, 3)).toEqual([0, 0, 0, 0])
  expect(px(dotted, 60, 16)).toEqual([0x20, 0x20, 0x20, 0xff]) // left of the dot
})

test('its edge is smooth, and the bitmap stays premultiplied', () => {
  const base = icon()
  const d = withDot(base)
  let blended = 0
  for (let i = 0; i < d.length; i += 4) {
    expect(Math.max(d[i], d[i + 1], d[i + 2])).toBeLessThanOrEqual(d[i + 3])
    const same = d.subarray(i, i + 4).equals(base.data.subarray(i, i + 4))
    const red = d[i] === DOT_RED[0] && d[i + 1] === DOT_RED[1] && d[i + 2] === DOT_RED[2] && d[i + 3] === 255
    if (!same && !red) blended++
  }
  expect(blended).toBeGreaterThan(20)
})

test('the icon it was given is left as it was', () => {
  const base = icon()
  const before = Buffer.from(base.data)
  withDot(base)
  expect(base.data.equals(before)).toBe(true)
})
