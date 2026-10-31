import type { ModeTracker } from './modes'

const ESC = 0x1b
const BEL = 0x07
/** In a buffer that dropped its oldest bytes, look this far for the start of a line. */
const SEEK = 64 * 1024

/**
 * What a newly attached terminal receives before live output: a full reset (so a terminal that showed this session
 * before doesn't show it twice), the modes the program set, then the recent output, starting at a line and without
 * old requests the terminal would act on again (see stripForReplay).
 */
export function replayBytes(recent: Buffer, wrapped: boolean, modes: ModeTracker): Buffer {
  const body = stripForReplay(trimStart(recent, wrapped))
  // Switching to the alternate screen up front when the output switches to it itself would paint the main screen's
  // output into the alternate one (and leave the main screen empty once the program leaves it).
  const alt = modes.altScreen()
  const switchesItself = alt !== null && new RegExp(`\x1b\\[\\?([0-9;]*;)?${alt}(;[0-9;]*)?h`).test(body.toString('latin1'))
  return Buffer.concat([Buffer.from('\x1bc' + modes.prefix(!switchesItself), 'latin1'), body])
}

/**
 * After the oldest bytes were dropped, the rest may start inside a line, a character or an escape sequence: start at
 * the next line, else at the next escape sequence, else at the next character.
 */
export function trimStart(b: Buffer, wrapped: boolean): Buffer {
  if (!wrapped) return b
  const nl = b.indexOf(0x0a)
  if (nl !== -1 && nl < SEEK) return b.subarray(nl + 1)
  const esc = b.indexOf(ESC)
  if (esc !== -1 && esc < SEEK) return b.subarray(esc)
  let i = 0
  while (i < b.length && i < 4 && (b[i] & 0xc0) === 0x80) i++ // UTF-8 continuation bytes
  return b.subarray(i)
}

/**
 * Removes what must not happen twice: questions to the terminal (status, device attributes, colours…), whose answers
 * would arrive as input today, and clipboard writes, which would overwrite what the user copied since.
 */
export function stripForReplay(b: Buffer): Buffer {
  const keep: Buffer[] = []
  let from = 0
  let i = b.indexOf(ESC)
  while (i !== -1) {
    const end = sequenceEnd(b, i)
    if (end === -1) break // unfinished: the live output that follows completes it
    if (isQuery(b, i, end) || isClipboard(b, i)) {
      keep.push(b.subarray(from, i))
      from = end
    }
    i = b.indexOf(ESC, end)
  }
  if (from === 0) return b
  keep.push(b.subarray(from))
  return Buffer.concat(keep)
}

const inRange = (c: number | undefined, lo: number, hi: number): boolean => c !== undefined && c >= lo && c <= hi

/** The index after the escape sequence at `i`, or -1 if `b` ends inside it. */
function sequenceEnd(b: Buffer, i: number): number {
  const c = b[i + 1]
  if (c === undefined) return -1
  if (c === 0x5b) { // CSI: parameters, intermediates, final
    let j = i + 2
    while (inRange(b[j], 0x30, 0x3f)) j++
    while (inRange(b[j], 0x20, 0x2f)) j++
    if (j >= b.length) return -1
    return inRange(b[j], 0x40, 0x7e) ? j + 1 : j
  }
  if (c === 0x5d || c === 0x50 || c === 0x5f || c === 0x5e || c === 0x58) { // OSC, DCS, APC, PM, SOS: up to ST or BEL
    for (let j = i + 2; j < b.length; j++) {
      if (b[j] === BEL) return j + 1
      if (b[j] === ESC) return b[j + 1] === undefined ? -1 : b[j + 1] === 0x5c ? j + 2 : j
    }
    return -1
  }
  if (inRange(c, 0x20, 0x2f)) { // e.g. ESC ( B
    let j = i + 1
    while (inRange(b[j], 0x20, 0x2f)) j++
    return j >= b.length ? -1 : j + 1
  }
  return i + 2
}

const REPORTING_WINDOW_OPS = new Set([11, 13, 14, 15, 16, 18, 19, 20, 21])

/** OSC 52: set (or query) the clipboard. */
function isClipboard(b: Buffer, i: number): boolean {
  return b[i + 1] === 0x5d && b[i + 2] === 0x35 && b[i + 3] === 0x32 && b[i + 4] === 0x3b
}

function isQuery(b: Buffer, i: number, end: number): boolean {
  const kind = b[i + 1]
  if (kind === 0x5b) {
    const final = b[end - 1]
    const priv = b[i + 2]
    switch (final) {
      case 0x6e: return true // n: device status report
      case 0x63: return true // c: device attributes
      case 0x70: return b[end - 2] === 0x24 // $p: mode report
      case 0x71: return priv === 0x3e // >q: terminal version
      case 0x75: return priv === 0x3f // ?u: keyboard protocol flags
      case 0x53: return priv === 0x3f // ?S: graphics attributes
      case 0x74: return REPORTING_WINDOW_OPS.has(Number(b.toString('latin1', i + 2, end - 1).split(';')[0])) // t: window reports
      default: return false
    }
  }
  if (kind === 0x5d) { // OSC ending in `?`: a colour or clipboard query
    const stop = b[end - 1] === BEL ? end - 1 : end - 2
    return b[stop - 1] === 0x3f
  }
  if (kind === 0x50) { // DCS $q / +q: setting and capability queries
    return (b[i + 2] === 0x24 || b[i + 2] === 0x2b) && b[i + 3] === 0x71
  }
  return false
}
