import { describe, expect, test } from 'vitest'
import { keyBytes, pasteBytes, sendKeysBytes } from '../../src/host/keys'
import { ModeTracker } from '../../src/host/modes'
import { hostPidFile, hostSocketPath } from '../../src/host/paths'
import { replayBytes, stripForReplay, trimStart } from '../../src/host/replay'
import { screenText } from '../../src/host/screen'

const feed = (m: ModeTracker, ...chunks: string[]): ModeTracker => {
  for (const c of chunks) m.feed(Buffer.from(c, 'latin1'))
  return m
}

describe('ModeTracker', () => {
  test('follows private modes, keypad and reset', () => {
    const m = feed(new ModeTracker(), 'hi\x1b[?2004h\x1b[?1;1004hx\x1b[?25l\x1b=')
    expect(m.bracketedPaste).toBe(true)
    expect(m.appCursorKeys).toBe(true)
    expect(m.isSet(25)).toBe(false)
    expect(m.prefix()).toBe('\x1b[?2004h\x1b[?1h\x1b[?1004h\x1b[?25l\x1b=')
    feed(m, '\x1b[?1l')
    expect(m.appCursorKeys).toBe(false)
    feed(m, '\x1bc')
    expect(m.prefix()).toBe('')
    expect(m.isSet(25)).toBe(true)
  })

  test('a sequence split across chunks still counts', () => {
    const m = feed(new ModeTracker(), 'abc\x1b', '[', '?20', '04', 'h tail')
    expect(m.bracketedPaste).toBe(true)
  })

  test('the alternate screen comes first in the prefix; untracked modes are ignored', () => {
    const m = feed(new ModeTracker(), '\x1b[?2004h\x1b[?1049h\x1b[?12h\x1b[?7l')
    expect(m.prefix()).toBe('\x1b[?1049h\x1b[?2004h')
  })
})

describe('replay', () => {
  test('starts with a full reset and the current modes', () => {
    const m = feed(new ModeTracker(), '\x1b[?2004h')
    expect(replayBytes(Buffer.from('hello\r\n'), false, m).toString()).toBe('\x1bc\x1b[?2004hhello\r\n')
  })

  test('after dropping bytes it starts at a line, or at least at a character', () => {
    expect(trimStart(Buffer.from('[31mtail of line\r\nnext'), true).toString()).toBe('next')
    expect(trimStart(Buffer.from('[31mtail of line\r\nnext'), false).toString()).toBe('[31mtail of line\r\nnext')
    const cut = Buffer.from('é❯x').subarray(1) // starts inside é
    expect(trimStart(cut, true).toString()).toBe('❯x')
  })

  test("drops the program's old questions to the terminal and clipboard writes, and keeps everything else", () => {
    const keep = 'a\x1b[31mred\x1b[0m\x1b]0;title\x07\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\\x1b[2 q\x1b[>1u\x1b[8;24;80t\x1b(Bz'
    const queries = '\x1b[6n\x1b[c\x1b[>0c\x1b[?6n\x1b[?2004$p\x1b[>q\x1b[?u\x1b[14t\x1b]11;?\x07\x1b]4;1;?\x1b\\\x1b]52;c;?\x07\x1bP$qm\x1b\\\x1bP+q544e\x1b\\'
    const clipboard = '\x1b]52;c;aGVsbG8=\x07'
    const out = stripForReplay(Buffer.from(keep.slice(0, 9) + queries + clipboard + keep.slice(9))).toString()
    expect(out).toBe(keep)
  })

  test('an unfinished sequence at the end is left for the live output to complete', () => {
    expect(stripForReplay(Buffer.from('x\x1b[6')).toString()).toBe('x\x1b[6')
    expect(stripForReplay(Buffer.from('x\x1b]11;?')).toString()).toBe('x\x1b]11;?')
  })
})

describe('screenText', () => {
  test('lines, carriage returns, backspace and erase-line', () => {
    expect(screenText('hello\r\nworld\rW\r\nab\bc\r\nxyz\x1b[2D\x1b[K!', 80, 24)).toBe('hello\nWorld\nac\nx!\n')
  })

  test('colours and other sequences leave no trace', () => {
    expect(screenText('\x1b[1;31mred\x1b[0m \x1b]0;title\x07\x1b[?25lok\x1b(B', 80, 24)).toBe('red ok\n')
  })

  test('shows the last `rows` lines, wrapped at `cols`', () => {
    const out = screenText(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\r\n'), 80, 5)
    expect(out).toBe('line 25\nline 26\nline 27\nline 28\nline 29\n')
    expect(screenText('abcdefgh', 3, 24)).toBe('abc\ndef\ngh\n')
  })

  test('a tty erasing a line (C-u with echoke) leaves an empty prompt', () => {
    expect(screenText('> typed\b \b\b \b\b \b\b \b\b \b', 80, 24)).toBe('>\n')
  })

  test('clearing the screen and cursor moves', () => {
    expect(screenText('old\r\nstuff\x1b[2J\x1b[Hnew', 80, 3)).toBe('new\n\n\n')
    expect(screenText('aaa\r\nbbb\r\nccc\x1b[2A\x1b[1Gx', 80, 24)).toBe('xaa\nbbb\nccc\n')
  })

  test('the alternate screen hides the main one until it ends', () => {
    expect(screenText('main\x1b[?1049hfull screen', 80, 2)).toBe('full screen\n\n')
    expect(screenText('main\x1b[?1049hfull screen\x1b[?1049l', 80, 24)).toBe('main\n')
  })

  test('UTF-8 text', () => {
    expect(screenText('got:héllo ❯ 👋', 80, 24)).toBe('got:héllo ❯ 👋\n')
  })
})

describe('keys', () => {
  test('tmux key names become bytes; anything else is text', () => {
    expect(sendKeysBytes(['typed', 'Enter'], false)).toBe('typed\r')
    expect(sendKeysBytes(['C-u', 'closed', 'Enter'], false)).toBe('\x15closed\r')
    expect(sendKeysBytes(['Enter'], true)).toBe('Enter')
    expect(sendKeysBytes(['Escape', 'Tab', 'BSpace', 'Space', 'C-c', 'M-x', 'F5', 'DC'], false)).toBe('\x1b\t\x7f \x03\x1bx\x1b[15~\x1b[3~')
    expect(keyBytes('enter')).toBe('\r')
    expect(keyBytes('C-[')).toBe('\x1b')
    expect(keyBytes('C-Space')).toBe('\x00')
    expect(keyBytes('C-ute')).toBeNull()
  })

  test('arrows follow application cursor mode', () => {
    expect(keyBytes('Up')).toBe('\x1b[A')
    expect(keyBytes('Up', true)).toBe('\x1bOA')
    expect(keyBytes('Home', true)).toBe('\x1bOH')
  })

  test('paste: line feeds become carriage returns, bracketed on request, markers inside dropped', () => {
    expect(pasteBytes('a\nb\r\nc', false)).toBe('a\rb\rc')
    expect(pasteBytes('@x', true)).toBe('\x1b[200~@x\x1b[201~')
    expect(pasteBytes('x\x1b[201~\x1b[200~y', true)).toBe('\x1b[200~xy\x1b[201~')
  })
})

describe('host paths', () => {
  test('a socket in the data dir; a short one in the temp dir when that would be too long', () => {
    expect(hostSocketPath('/Users/me/Library/Application Support/pitwall', { platform: 'darwin' }))
      .toBe('/Users/me/Library/Application Support/pitwall/host.sock')
    const long = `/Users/me/${'x'.repeat(100)}/pitwall`
    expect(hostSocketPath(long, { platform: 'darwin', tmp: '/tmp/me' })).toMatch(/^\/tmp\/me\/pitwall-host-[0-9a-f]{16}\.sock$/)
    expect(hostSocketPath(long, { platform: 'darwin', tmp: '/tmp/me' })).not.toBe(hostSocketPath(`${long}-dev`, { platform: 'darwin', tmp: '/tmp/me' }))
  })

  test('Windows: a named pipe per user and data dir (dev and packaged differ)', () => {
    const a = hostSocketPath('C:\\Users\\Zoë Ågren\\AppData\\Roaming\\pitwall', { platform: 'win32', user: 'Zoë Ågren' })
    const b = hostSocketPath('C:\\Users\\Zoë Ågren\\AppData\\Roaming\\pitwall-dev', { platform: 'win32', user: 'Zoë Ågren' })
    expect(a).toMatch(/^\\\\\.\\pipe\\pitwall-Zo___gren-[0-9a-f]{16}$/)
    expect(a).not.toBe(b)
  })

  test('pidfile beside the socket', () => {
    expect(hostPidFile('/d')).toBe('/d/host.pid')
  })
})
