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

/** Questions a starting program may wait on: primary device attributes (`CSI c`) and status (`CSI 5 n`). */
export type Query = 'da1' | 'dsr5'

/** What a terminal answers to each Query (a VT100 with advanced video; "OK"). */
export const ANSWERS: Record<Query, string> = { da1: '\x1b[?1;2c', dsr5: '\x1b[0n' }

const inRange = (c: number | undefined, lo: number, hi: number): boolean => c !== undefined && c >= lo && c <= hi

/**
 * Follows the terminal modes a program sets (`CSI ? Pm h|l`, keypad `ESC =`/`ESC >`, reset `ESC c`) and notices the
 * questions it asks (see Query), whatever the chunking. Cheap on output with no escape sequences, which is most of it.
 */
export class ModeTracker {
  private modes = new Map<number, boolean>()
  private keypad = false
  private tail: Buffer | null = null

  /** Returns the questions in this chunk, in order. */
  feed(chunk: Buffer): Query[] {
    const b = this.tail ? Buffer.concat([this.tail, chunk]) : chunk
    this.tail = null
    const queries: Query[] = []
    let i = b.indexOf(ESC)
    while (i !== -1) {
      const next = this.parse(b, i, queries)
      if (next === -1) {
        if (b.length - i <= MAX_TAIL) this.tail = Buffer.from(b.subarray(i))
        break
      }
      i = b.indexOf(ESC, next)
    }
    return queries
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

  /** The alternate-screen mode in effect (1049, 1047 or 47), if any. */
  altScreen(): number | null {
    return ALT_SCREEN.find((m) => this.modes.get(m)) ?? null
  }

  /**
   * Sequences that put a freshly reset terminal into the current modes. The alternate screen comes first, and only
   * with `altScreen` (leave it out when the output being replayed switches to it itself).
   */
  prefix(altScreen = true): string {
    let out = ''
    if (altScreen) for (const m of ALT_SCREEN) if (this.modes.get(m)) out += `\x1b[?${m}h`
    for (const [m, on] of this.modes) {
      if (ALT_SCREEN.includes(m) || on === DEFAULT_ON.has(m)) continue
      out += `\x1b[?${m}${on ? 'h' : 'l'}`
    }
    if (this.keypad) out += '\x1b='
    return out
  }

  /** Returns the index after the sequence at `i`, or -1 if the chunk ends inside it. */
  private parse(b: Buffer, i: number, queries: Query[]): number {
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
    let j = i + 2
    const priv = inRange(b[j], 0x3c, 0x3f) ? b[j++] : 0
    const start = j
    while (inRange(b[j], 0x30, 0x3b)) j++
    const end = j
    while (inRange(b[j], 0x20, 0x2f)) j++ // intermediates
    if (j >= b.length) return -1
    if (!inRange(b[j], 0x40, 0x7e)) return j // malformed: resume at the odd byte
    const final = b[j]
    const params = b.toString('latin1', start, end)
    const plain = priv === 0 && end === j // no private marker, no intermediates
    if (priv === 0x3f && (final === 0x68 || final === 0x6c)) {
      const on = final === 0x68
      for (const p of params.split(';')) {
        const m = Number(p)
        if (p !== '' && TRACKED.has(m)) this.modes.set(m, on)
      }
    } else if (plain && final === 0x63 && (params === '' || params === '0')) {
      queries.push('da1')
    } else if (plain && final === 0x6e && params === '5') {
      queries.push('dsr5')
    }
    return j + 1
  }
}
