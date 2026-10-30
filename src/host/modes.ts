const ESC = 0x1b
/** An unfinished sequence longer than this at the end of a chunk isn't one we track. */
const MAX_TAIL = 64

/** DEC private modes a program sets that the terminal must know after a replay. */
const ALT_SCREEN = [1049, 1047, 47]
const TRACKED = new Set([
  1, // application cursor keys
  25, // cursor visible (on by default)
  ...ALT_SCREEN,
  1000, 1002, 1003, 1004, 1005, 1006, 1015, // mouse and focus reporting
  2004 // bracketed paste
])
const DEFAULT_ON = new Set([25])

/**
 * Follows the terminal modes a program sets (`CSI ? Pm h|l`, keypad `ESC =`/`ESC >`, reset `ESC c`), whatever the
 * chunking. Cheap on output with no escape sequences, which is most of it.
 */
export class ModeTracker {
  private modes = new Map<number, boolean>()
  private keypad = false
  private tail: Buffer | null = null

  feed(chunk: Buffer): void {
    const b = this.tail ? Buffer.concat([this.tail, chunk]) : chunk
    this.tail = null
    let i = b.indexOf(ESC)
    while (i !== -1) {
      const next = this.parse(b, i)
      if (next === -1) {
        if (b.length - i <= MAX_TAIL) this.tail = Buffer.from(b.subarray(i))
        return
      }
      i = b.indexOf(ESC, next)
    }
  }

  isSet(mode: number): boolean {
    return this.modes.get(mode) ?? DEFAULT_ON.has(mode)
  }

  get bracketedPaste(): boolean {
    return this.isSet(2004)
  }

  get appCursorKeys(): boolean {
    return this.isSet(1)
  }

  /** Sequences that put a freshly reset terminal into the current modes (alternate screen first). */
  prefix(): string {
    let out = ''
    for (const m of ALT_SCREEN) if (this.modes.get(m)) out += `\x1b[?${m}h`
    for (const [m, on] of this.modes) {
      if (ALT_SCREEN.includes(m) || on === DEFAULT_ON.has(m)) continue
      out += `\x1b[?${m}${on ? 'h' : 'l'}`
    }
    if (this.keypad) out += '\x1b='
    return out
  }

  /** Returns the index after the sequence at `i`, or -1 if the chunk ends inside it. */
  private parse(b: Buffer, i: number): number {
    if (i + 1 >= b.length) return -1
    const c = b[i + 1]
    if (c === 0x63) { // ESC c: full reset
      this.modes.clear()
      this.keypad = false
      return i + 2
    }
    if (c === 0x3d || c === 0x3e) { // ESC = / ESC >
      this.keypad = c === 0x3d
      return i + 2
    }
    if (c !== 0x5b) return i + 1 // not CSI
    if (i + 2 >= b.length) return -1
    if (b[i + 2] !== 0x3f) return i + 2 // not a private-mode CSI
    let j = i + 3
    while (j < b.length && ((b[j] >= 0x30 && b[j] <= 0x39) || b[j] === 0x3b)) j++
    if (j >= b.length) return -1
    const final = b[j]
    if (final === 0x68 || final === 0x6c) {
      const on = final === 0x68
      for (const p of b.toString('latin1', i + 3, j).split(';')) {
        const m = Number(p)
        if (p !== '' && TRACKED.has(m)) this.modes.set(m, on)
      }
    }
    return j + 1
  }
}
