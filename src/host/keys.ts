/** tmux key names (as `send-keys` takes them) for keys that aren't a single character. */
const NAMED: Record<string, string> = {
  enter: '\r', escape: '\x1b', esc: '\x1b', tab: '\t', btab: '\x1b[Z', bspace: '\x7f', space: ' ',
  home: '\x1b[H', end: '\x1b[F', ic: '\x1b[2~', insert: '\x1b[2~', dc: '\x1b[3~', delete: '\x1b[3~',
  ppage: '\x1b[5~', pageup: '\x1b[5~', pgup: '\x1b[5~', npage: '\x1b[6~', pagedown: '\x1b[6~', pgdn: '\x1b[6~',
  f1: '\x1bOP', f2: '\x1bOQ', f3: '\x1bOR', f4: '\x1bOS', f5: '\x1b[15~', f6: '\x1b[17~', f7: '\x1b[18~',
  f8: '\x1b[19~', f9: '\x1b[20~', f10: '\x1b[21~', f11: '\x1b[23~', f12: '\x1b[24~'
}
const ARROWS: Record<string, string> = { up: 'A', down: 'B', right: 'C', left: 'D' }
const APP_CURSOR: Record<string, string> = { home: '\x1bOH', end: '\x1bOF' }

function ctrl(ch: string): string | null {
  if (ch.length !== 1) return null
  const c = ch.toUpperCase().charCodeAt(0)
  if (ch === ' ' || ch === '@' || ch === '2') return '\x00'
  if (ch === '?') return '\x7f'
  if (c >= 0x40 && c <= 0x5f) return String.fromCharCode(c & 0x1f) // A–Z [ \ ] ^ _
  return null
}

/** One tmux key name as bytes, or null when it isn't a key name (tmux then sends it as text). */
export function keyBytes(key: string, appCursorKeys = false): string | null {
  if (key.length === 0) return null
  const lower = key.toLowerCase()
  if (ARROWS[lower]) return (appCursorKeys ? '\x1bO' : '\x1b[') + ARROWS[lower]
  if (appCursorKeys && APP_CURSOR[lower]) return APP_CURSOR[lower]
  if (NAMED[lower]) return NAMED[lower]
  const mod = /^([CMS])-(.+)$/i.exec(key)
  if (mod) {
    const [, m, rest] = mod
    if (m.toUpperCase() === 'C') {
      if (rest.length === 1) return ctrl(rest)
      return rest.toLowerCase() === 'space' ? '\x00' : null
    }
    if (m.toUpperCase() === 'M') {
      const inner = rest.length === 1 ? rest : keyBytes(rest, appCursorKeys)
      return inner === null ? null : '\x1b' + inner
    }
    return rest.length === 1 ? rest.toUpperCase() : null
  }
  return null
}

/** What `tmux send-keys [-l] -- keys…` types: key names become their bytes, anything else (or everything, with `literal`) is text. */
export function sendKeysBytes(keys: string[], literal: boolean, appCursorKeys = false): string {
  if (literal) return keys.join('')
  return keys.map((k) => keyBytes(k, appCursorKeys) ?? k).join('')
}

/**
 * What `tmux paste-buffer -p` types: line feeds become carriage returns, wrapped in bracketed-paste markers when the
 * program asked for them. Markers inside the text are dropped, so it can't end the paste early.
 */
export function pasteBytes(text: string, bracketed: boolean): string {
  const body = text.replace(/\x1b\[20[01]~/g, '').replace(/\r?\n/g, '\r')
  return bracketed ? `\x1b[200~${body}\x1b[201~` : body
}
