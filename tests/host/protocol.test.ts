import { describe, expect, test } from 'vitest'
import {
  DATA_CHUNK, encodeData, encodeDataChunks, encodeJson, FrameDecoder, MAX_FRAME, parseClientMessage, parseHostMessage,
  PROTOCOL, ProtocolError, type Frame
} from '../../src/host/protocol'

const decodeAll = (bytes: Buffer, chunk: number): Frame[] => {
  const d = new FrameDecoder()
  const out: Frame[] = []
  for (let i = 0; i < bytes.length; i += chunk) out.push(...d.push(bytes.subarray(i, i + chunk)))
  expect(d.pending).toBe(0)
  return out
}

describe('framing', () => {
  const stream = Buffer.concat([
    encodeJson({ t: 'hello', protocol: PROTOCOL, appVersion: '1.2.3' }),
    encodeData(7, Buffer.from('héllo ❯\r\n')),
    encodeJson({ t: 'list', id: 1 }),
    encodeData(0xffffffff, Buffer.alloc(0))
  ])
  const want: Frame[] = [
    { type: 'json', msg: { t: 'hello', protocol: PROTOCOL, appVersion: '1.2.3' } },
    { type: 'data', ch: 7, data: Buffer.from('héllo ❯\r\n') },
    { type: 'json', msg: { t: 'list', id: 1 } },
    { type: 'data', ch: 0xffffffff, data: Buffer.alloc(0) }
  ]

  test('frames survive any chunking: whole, byte by byte, odd sizes', () => {
    for (const size of [stream.length, 1, 2, 3, 5, 7, 13]) expect(decodeAll(stream, size)).toEqual(want)
  })

  test('a partial frame waits for the rest', () => {
    const d = new FrameDecoder()
    const f = encodeJson({ t: 'list', id: 9 })
    expect(d.push(f.subarray(0, 3))).toEqual([])
    expect(d.push(f.subarray(3, f.length - 1))).toEqual([])
    expect(d.pending).toBe(f.length - 1)
    expect(d.push(f.subarray(f.length - 1))).toEqual([{ type: 'json', msg: { t: 'list', id: 9 } }])
  })

  test('large data is split into frames of at most DATA_CHUNK bytes and reassembles', () => {
    const data = Buffer.alloc(DATA_CHUNK * 2 + 10, 0x61)
    const frames = encodeDataChunks(3, data)
    expect(frames).toHaveLength(3)
    const got = decodeAll(Buffer.concat(frames), 4096)
    expect(Buffer.concat(got.map((f) => (f.type === 'data' ? f.data : Buffer.alloc(0))))).toEqual(data)
  })

  test('an oversize frame is rejected from its header, before its body is buffered', () => {
    const d = new FrameDecoder(1024)
    const header = Buffer.alloc(4)
    header.writeUInt32BE(1025)
    expect(() => d.push(header)).toThrow(ProtocolError)
    expect(d.pending).toBe(0)
    expect(() => d.push(encodeJson({ t: 'list', id: 1 }))).toThrow(ProtocolError) // stays failed
  })

  test('the default limit is MAX_FRAME', () => {
    const header = Buffer.alloc(4)
    header.writeUInt32BE(MAX_FRAME + 1)
    expect(() => new FrameDecoder().push(header)).toThrow(/out of range/)
    expect(() => encodeData(1, Buffer.alloc(MAX_FRAME))).toThrow(ProtocolError)
  })

  test('zero length, unknown types, bad JSON and channel-less data frames are rejected', () => {
    const frame = (type: number, body: Buffer): Buffer => {
      const b = Buffer.alloc(5 + body.length)
      b.writeUInt32BE(body.length + 1)
      b[4] = type
      body.copy(b, 5)
      return b
    }
    expect(() => new FrameDecoder().push(Buffer.alloc(4))).toThrow(/out of range/)
    expect(() => new FrameDecoder().push(frame(9, Buffer.from('{}')))).toThrow(/unknown frame type/)
    expect(() => new FrameDecoder().push(frame(1, Buffer.from('{nope')))).toThrow(/did not parse/)
    expect(() => new FrameDecoder().push(frame(1, Buffer.from('[1]')))).toThrow(/not an object/)
    expect(() => new FrameDecoder().push(frame(2, Buffer.from([0, 1])))).toThrow(/no channel/)
  })
})

describe('messages', () => {
  test('valid client messages pass, with defaults', () => {
    expect(parseClientMessage({ t: 'hello', protocol: 1, appVersion: '0.3.0' })).toEqual({ t: 'hello', protocol: 1, appVersion: '0.3.0' })
    expect(parseClientMessage({ t: 'new', id: 1, name: 'pw-a', cwd: '/tmp/a b', argv: ['x', 'y'] }))
      .toEqual({ t: 'new', id: 1, name: 'pw-a', cwd: '/tmp/a b', argv: ['x', 'y'], env: {} })
    expect(parseClientMessage({ t: 'send', id: 2, name: 'pw-a', keys: ['C-u', 'Enter'] }))
      .toEqual({ t: 'send', id: 2, name: 'pw-a', keys: ['C-u', 'Enter'], literal: false })
    expect(parseClientMessage({ t: 'attach', id: 3, name: 'pw-a', ch: 1, cols: 80, rows: 24 }))
      .toEqual({ t: 'attach', id: 3, name: 'pw-a', ch: 1, cols: 80, rows: 24 })
    expect(parseClientMessage({ t: 'resize', ch: 1, cols: 100, rows: 40 })).toEqual({ t: 'resize', ch: 1, cols: 100, rows: 40 })
  })

  test.each([
    [{ t: 'nope' }, /unknown message/],
    [{ t: 'list' }, /id/],
    [{ t: 'has', id: 1, name: '' }, /empty/],
    [{ t: 'has', id: 1, name: 'x'.repeat(257) }, /name/],
    [{ t: 'new', id: 1, name: 'a', cwd: '/', argv: [] }, /argv/],
    [{ t: 'new', id: 1, name: 'a', cwd: '/', argv: ['x', 1] }, /argv/],
    [{ t: 'new', id: 1, name: 'a', cwd: '/', argv: ['x'], env: { A: 1 } }, /env/],
    [{ t: 'attach', id: 1, name: 'a', ch: 0, cols: 80, rows: 24 }, /ch/],
    [{ t: 'attach', id: 1, name: 'a', ch: 1, cols: 0, rows: 24 }, /cols/],
    [{ t: 'resize', ch: 1, cols: 80, rows: 1e9 }, /rows/],
    [{ t: 'kill', id: -1, name: 'a' }, /id/],
    ['hello', /object/]
  ])('rejects %j', (msg, err) => {
    expect(() => parseClientMessage(msg)).toThrow(err)
  })

  test('host messages', () => {
    expect(parseHostMessage({ t: 'hello', protocol: 1, appVersion: 'x', pid: 5 })).toEqual({ t: 'hello', protocol: 1, appVersion: 'x', pid: 5 })
    expect(parseHostMessage({ t: 'res', id: 1, ok: true, value: ['a'] })).toEqual({ t: 'res', id: 1, ok: true, value: ['a'] })
    expect(parseHostMessage({ t: 'res', id: 1, ok: false, error: 'no', code: 'no-session' }))
      .toEqual({ t: 'res', id: 1, ok: false, error: 'no', code: 'no-session' })
    expect(parseHostMessage({ t: 'exit', ch: 2, code: 0 })).toEqual({ t: 'exit', ch: 2, code: 0 })
    expect(() => parseHostMessage({ t: 'res', id: 1, ok: false })).toThrow(ProtocolError)
    expect(() => parseHostMessage({ t: 'hello', protocol: 1, appVersion: 'x' })).toThrow(/pid/)
  })
})
