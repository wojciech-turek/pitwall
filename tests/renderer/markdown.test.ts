import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import Markdown from '../../src/renderer/src/components/Markdown'

/** The component's markup, without its wrapper element. */
const md = (text: string): string => {
  const html = renderToStaticMarkup(createElement(Markdown, { text, onOpenLink: () => undefined }))
  const m = /^<div class="markdown">([\s\S]*)<\/div>$/.exec(html)
  if (!m) throw new Error(`unexpected wrapper: ${html}`)
  return m[1]
}

describe('Markdown', () => {
  test('headings', () => {
    expect(md('# Pitwall 0.2.0\n## Added\n### Small things')).toBe('<h3>Pitwall 0.2.0</h3><h4>Added</h4><h5>Small things</h5>')
    expect(md('#### Deep\n###### Deeper')).toBe('<h6>Deep</h6><h6>Deeper</h6>')
    expect(md('#hashtag')).toBe('<p>#hashtag</p>')
  })

  test('bullet and numbered lists', () => {
    expect(md('- one\n- two\n* three')).toBe('<ul><li>one</li><li>two</li><li>three</li></ul>')
    expect(md('- one\n  continued\n- two')).toBe('<ul><li>one continued</li><li>two</li></ul>')
    expect(md('1. first\n2. second')).toBe('<ol><li>first</li><li>second</li></ol>')
    expect(md('## Fixed\n- a\n\nThanks')).toBe('<h4>Fixed</h4><ul><li>a</li></ul><p>Thanks</p>')
  })

  test('paragraphs join their lines; blank lines separate them; CRLF is fine', () => {
    expect(md('First line\ncontinues\n\nSecond')).toBe('<p>First line continues</p><p>Second</p>')
    expect(md('One\r\n\r\nTwo\r\n')).toBe('<p>One</p><p>Two</p>')
    expect(md('')).toBe('')
  })

  test('bold, inline code and links', () => {
    expect(md('**bold** and `code` and [the docs](https://example.com/docs)')).toBe(
      '<p><strong>bold</strong> and <code>code</code> and <a href="https://example.com/docs">the docs</a></p>'
    )
    expect(md('- **see [docs](http://example.com)**')).toBe('<ul><li><strong>see <a href="http://example.com">docs</a></strong></li></ul>')
    expect(md('`**not bold**`')).toBe('<p><code>**not bold**</code></p>')
  })

  test('bare http(s) URLs become links, without trailing punctuation', () => {
    expect(md('**Full Changelog**: https://github.com/o/r/compare/v0.1.0...v0.2.0.')).toBe(
      '<p><strong>Full Changelog</strong>: <a href="https://github.com/o/r/compare/v0.1.0...v0.2.0">https://github.com/o/r/compare/v0.1.0...v0.2.0</a>.</p>'
    )
  })

  test('fenced code blocks keep their text as is', () => {
    expect(md('```sh\npnpm install\n<b>x</b>\n```')).toBe('<pre><code>pnpm install\n&lt;b&gt;x&lt;/b&gt;</code></pre>')
  })

  test('HTML in the notes stays literal text', () => {
    const html = md('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n- <iframe src="evil.html"></iframe>')
    expect(html).not.toMatch(/<script|<img|<iframe/i)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&lt;iframe src=&quot;evil.html&quot;&gt;&lt;/iframe&gt;')
    expect(md('# <b>hi</b>')).toBe('<h3>&lt;b&gt;hi&lt;/b&gt;</h3>')
  })

  test('only http(s) targets become links: javascript:, data: and the like stay text', () => {
    for (const target of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'vbscript:x', '/relative', '#top']) {
      const html = md(`[click me](${target})`)
      expect(html, target).not.toMatch(/<a|href/i)
      expect(html, target).toBe('<p>click me</p>')
    }
    expect(md('javascript:alert(1)')).toBe('<p>javascript:alert(1)</p>')
  })
})
