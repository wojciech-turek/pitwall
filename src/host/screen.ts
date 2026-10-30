/** Lines kept while rendering; older ones scroll away. */
const MAX_LINES = 5000

interface Cursor { row: number; col: number }

/**
 * Plain text of a terminal's visible screen, from the output that drew it: what `tmux capture-pane -p` gives.
 * An approximation good for finding text: lines are kept unwrapped and wrapped at `cols` at the end, colours and
 * attributes are dropped, and wide characters count as one column.
 */
export function screenText(output: string, cols: number, rows: number): string {
  const s = new TextScreen(rows)
  s.write(output)
  return s.render(cols)
}

class TextScreen {
  private lines: string[][] = [[]]
  private cur: Cursor = { row: 0, col: 0 }
  private saved: Cursor = { row: 0, col: 0 }
  private main: { lines: string[][]; cur: Cursor } | null = null // set while on the alternate screen

  constructor(private readonly rows: number) {}

  write(s: string): void {
    const n = s.length
    let i = 0
    while (i < n) {
      const c = s.charCodeAt(i)
      if (c === 0x1b) {
        i = this.escape(s, i)
      } else if (c < 0x20 || c === 0x7f) {
        this.control(c)
        i++
      } else if (c >= 0x80 && c <= 0x9f) {
        i++ // C1 controls
      } else {
        const ch = c >= 0xd800 && c <= 0xdbff && i + 1 < n ? s.slice(i, i + 2) : s[i]
        this.put(ch)
        i += ch.length
      }
    }
  }

  render(cols: number): string {
    const out: string[] = []
    for (const line of this.lines.slice(-this.rows)) {
      if (line.length === 0) out.push('')
      for (let k = 0; k < line.length; k += cols) out.push(line.slice(k, k + cols).join(''))
    }
    return out.slice(-this.rows).map((l) => l.trimEnd()).join('\n') + '\n'
  }

  private top(): number {
    return Math.max(0, this.lines.length - this.rows)
  }

  private line(): string[] {
    while (this.lines.length <= this.cur.row) this.lines.push([])
    return this.lines[this.cur.row]
  }

  private put(ch: string): void {
    const line = this.line()
    while (line.length < this.cur.col) line.push(' ')
    line[this.cur.col++] = ch
  }

  private lineFeed(): void {
    this.cur.row++
    this.line()
    if (this.lines.length > MAX_LINES) {
      const drop = this.lines.length - MAX_LINES + 1000
      this.lines.splice(0, drop)
      this.cur.row = Math.max(0, this.cur.row - drop)
      this.saved.row = Math.max(0, this.saved.row - drop)
    }
  }

  private control(c: number): void {
    if (c === 0x0a || c === 0x0b || c === 0x0c) this.lineFeed()
    else if (c === 0x0d) this.cur.col = 0
    else if (c === 0x08) this.cur.col = Math.max(0, this.cur.col - 1)
    else if (c === 0x09) this.cur.col = (Math.floor(this.cur.col / 8) + 1) * 8
  }

  /** Applies the escape sequence at `i`; returns the index after it. */
  private escape(s: string, i: number): number {
    const next = s[i + 1]
    if (next === undefined) return s.length
    if (next === '[') {
      let j = i + 2
      const priv = '?>=<'.includes(s[j] ?? 'x') ? s[j++] : ''
      const start = j
      while (j < s.length && /[0-9;:]/.test(s[j])) j++
      const params = s.slice(start, j)
      while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++
      if (j >= s.length) return s.length
      this.csi(priv, params.split(';').map((p) => parseInt(p, 10)), s[j])
      return j + 1
    }
    if (']P_^X'.includes(next)) { // strings: up to BEL or ST
      for (let j = i + 2; j < s.length; j++) {
        if (s[j] === '\x07') return j + 1
        if (s[j] === '\x1b') return s[j + 1] === '\\' ? j + 2 : j
      }
      return s.length
    }
    switch (next) {
      case 'c': this.reset(); break
      case '7': this.saved = { ...this.cur }; break
      case '8': this.cur = { ...this.saved }; break
      case 'D': this.lineFeed(); break
      case 'E': this.cur.col = 0; this.lineFeed(); break
      case 'M': this.cur.row = Math.max(0, this.cur.row - 1); break
      default: {
        let j = i + 1
        while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++ // e.g. ESC ( B
        return Math.min(s.length, j + 1)
      }
    }
    return i + 2
  }

  private csi(priv: string, p: number[], final: string): void {
    const n = (k = 0, def = 1): number => (Number.isFinite(p[k]) && p[k] > 0 ? p[k] : def)
    const cur = this.cur
    if (priv === '?') {
      if ((final === 'h' || final === 'l') && p.some((m) => m === 1049 || m === 1047 || m === 47)) this.altScreen(final === 'h')
      return
    }
    if (priv) return
    switch (final) {
      case 'A': cur.row = Math.max(0, cur.row - n()); break
      case 'B': cur.row += n(); break
      case 'C': cur.col += n(); break
      case 'D': cur.col = Math.max(0, cur.col - n()); break
      case 'E': cur.row += n(); cur.col = 0; break
      case 'F': cur.row = Math.max(0, cur.row - n()); cur.col = 0; break
      case 'G': case '`': cur.col = n() - 1; break
      case 'H': case 'f': cur.row = this.top() + n(0) - 1; cur.col = n(1) - 1; break
      case 'd': cur.row = this.top() + n() - 1; break
      case 'J': this.eraseDisplay(Number.isFinite(p[0]) ? p[0] : 0); break
      case 'K': this.eraseLine(Number.isFinite(p[0]) ? p[0] : 0); break
      case 'X': { const l = this.line(); for (let k = cur.col; k < Math.min(l.length, cur.col + n()); k++) l[k] = ' '; break }
      case 'P': this.line().splice(cur.col, n()); break
      case '@': { const l = this.line(); if (cur.col < l.length) l.splice(cur.col, 0, ...Array<string>(n()).fill(' ')); break }
      case 'L': this.lines.splice(cur.row, 0, ...Array.from({ length: n() }, () => [])); break
      case 'M': this.lines.splice(cur.row, n()); this.line(); break
      case 's': this.saved = { ...cur }; break
      case 'u': this.cur = { ...this.saved }; break
    }
    this.line()
  }

  private eraseLine(mode: number): void {
    const l = this.line()
    if (mode === 0) l.length = Math.min(l.length, this.cur.col)
    else if (mode === 1) for (let k = 0; k <= Math.min(this.cur.col, l.length - 1); k++) l[k] = ' '
    else l.length = 0
  }

  private eraseDisplay(mode: number): void {
    if (mode === 0) {
      this.eraseLine(0)
      this.lines.length = this.cur.row + 1
    } else if (mode === 1) {
      for (let r = this.top(); r < this.cur.row; r++) this.lines[r] = []
      this.eraseLine(1)
    } else if (mode === 2) {
      const rel = Math.max(0, this.cur.row - this.top())
      this.lines = Array.from({ length: this.rows }, () => [])
      this.cur.row = Math.min(rel, this.rows - 1)
    } else if (mode === 3) {
      const top = this.top()
      this.lines.splice(0, top)
      this.cur.row = Math.max(0, this.cur.row - top)
    }
  }

  private altScreen(on: boolean): void {
    if (on && !this.main) {
      this.main = { lines: this.lines, cur: { ...this.cur } }
      this.lines = Array.from({ length: this.rows }, () => [])
      this.cur = { row: 0, col: 0 }
    } else if (!on && this.main) {
      this.lines = this.main.lines
      this.cur = this.main.cur
      this.main = null
    }
  }

  private reset(): void {
    this.lines = [[]]
    this.cur = { row: 0, col: 0 }
    this.saved = { row: 0, col: 0 }
    this.main = null
  }
}
