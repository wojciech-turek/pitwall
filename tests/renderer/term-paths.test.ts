import { describe, expect, test } from 'vitest'
import { dropText, formatDroppedPaths, shellEscapePath } from '../../src/renderer/src/terminal/paths'

describe('dropped file paths', () => {
  test('plain paths stay as they are', () => {
    expect(shellEscapePath('/Users/w/src/a-b_c.v2/x.ts')).toBe('/Users/w/src/a-b_c.v2/x.ts')
  })

  test('anything a shell would split or expand is single-quoted', () => {
    expect(shellEscapePath('/Users/w/My Repo/a b.png')).toBe("'/Users/w/My Repo/a b.png'")
    expect(shellEscapePath('/tmp/$HOME*?.txt')).toBe("'/tmp/$HOME*?.txt'")
    expect(shellEscapePath("/tmp/it's.txt")).toBe("'/tmp/it'\\''s.txt'")
    expect(shellEscapePath('/tmp/zdjęcie 🧾.png')).toBe("'/tmp/zdjęcie 🧾.png'")
  })

  test('several files: space-separated, trailing space, never a newline', () => {
    const out = formatDroppedPaths(['/a/b.txt', '/c/d e.txt'])
    expect(out).toBe("/a/b.txt '/c/d e.txt' ")
    expect(out).not.toMatch(/[\r\n]/)
  })

  test('dropText: real files first, else file links (a drag from Cursor), else plain text as-is', () => {
    expect(dropText({ filePaths: ['/a/b.txt', ''], uriList: 'file:///ignored', text: 'x' })).toBe('/a/b.txt ')
    expect(dropText({
      filePaths: [], uriList: '# comment\r\nfile:///Users/w/My%20Repo/a.ts\r\nhttps://example.com/x\r\nfile:///tmp/z%C4%99.png', text: ''
    })).toBe("'/Users/w/My Repo/a.ts' '/tmp/zę.png' ")
    expect(dropText({ filePaths: [], uriList: 'https://example.com/x', text: 'some words' })).toBe('some words')
    expect(dropText({ filePaths: [], uriList: '', text: '' })).toBe('')
  })
})
