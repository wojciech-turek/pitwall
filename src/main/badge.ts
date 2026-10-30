/**
 * The taskbar overlay badge on Windows (macOS shows the count on the Dock icon instead): a red disc with the count in
 * white, 1–9 or "9+". Drawn here as a raw bitmap (premultiplied BGRA, what nativeImage.createFromBitmap takes), so no
 * image files or libraries are needed. Pure, for tests.
 */

// 5×7 glyphs, one string per row.
const GLYPHS: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000']
}

const RED = [0x5c, 0x67, 0xe5] // #e5675c as B, G, R
const WHITE = [0xff, 0xff, 0xff]

export function badgeText(count: number): string | null {
  if (!(count > 0)) return null
  return count > 9 ? '9+' : String(Math.floor(count))
}

/** What a screen reader says about the badge. */
export function badgeDescription(count: number): string {
  return count === 1 ? '1 session needs you' : `${count} sessions need you`
}

/**
 * The badge at `size`×`size` pixels (32 for a 16-DIP overlay at 200%), or null for no badge. Each glyph pixel is
 * `scale` pixels wide, centred in the disc.
 */
export function badgeBitmap(count: number, size = 32): { width: number; height: number; data: Buffer } | null {
  const text = badgeText(count)
  if (!text) return null
  const data = Buffer.alloc(size * size * 4)
  const r = size / 2
  // The disc, anti-aliased by 4×4 supersampling.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inside = 0
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const dx = x + (sx + 0.5) / 4 - r
          const dy = y + (sy + 0.5) / 4 - r
          if (dx * dx + dy * dy <= r * r) inside++
        }
      }
      const a = inside / 16
      const i = (y * size + x) * 4
      data[i] = Math.round(RED[0] * a)
      data[i + 1] = Math.round(RED[1] * a)
      data[i + 2] = Math.round(RED[2] * a)
      data[i + 3] = Math.round(255 * a)
    }
  }
  // The text, in whole glyph pixels.
  const glyphs = [...text].map((ch) => GLYPHS[ch])
  const cols = glyphs.length * 5 + (glyphs.length - 1)
  const scale = Math.max(1, Math.floor((size * 0.72) / Math.max(cols, 7)))
  const left = Math.floor((size - cols * scale) / 2)
  const top = Math.floor((size - 7 * scale) / 2)
  glyphs.forEach((g, n) => {
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (g[row][col] !== '1') continue
        for (let py = 0; py < scale; py++) {
          for (let px = 0; px < scale; px++) {
            const x = left + (n * 6 + col) * scale + px
            const y = top + row * scale + py
            const i = (y * size + x) * 4
            data[i] = WHITE[0]
            data[i + 1] = WHITE[1]
            data[i + 2] = WHITE[2]
            data[i + 3] = 255
          }
        }
      }
    }
  })
  return { width: size, height: size, data }
}
