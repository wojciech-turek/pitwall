import type { ReactNode } from 'react'

/**
 * A small Markdown subset for release notes: headings, bullet and numbered lists, paragraphs, fenced code, and
 * inline **bold**, `code`, [links](https://…) and bare https:// URLs. The text is untrusted: everything is rendered
 * as React text (HTML in it shows literally) and only http(s) targets become links, opened through onOpenLink.
 */
export default function Markdown({ text, onOpenLink }: { text: string; onOpenLink: (url: string) => void }): React.JSX.Element {
  return <div className="markdown">{blocks(text).map((b, i) => renderBlock(b, i, onOpenLink))}</div>
}

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'para'; text: string }

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const BULLET = /^\s*[-*+]\s+(.*)$/
const NUMBERED = /^\s*\d{1,9}[.)]\s+(.*)$/
const FENCE = /^\s*(```|~~~)/

function blocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    const fence = FENCE.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++])
      i++ // the closing fence (or the end)
      out.push({ kind: 'code', text: body.join('\n') })
      continue
    }
    const h = HEADING.exec(line)
    if (h) {
      out.push({ kind: 'heading', level: h[1].length, text: h[2] })
      i++
      continue
    }
    const ordered = NUMBERED.test(line)
    if (ordered || BULLET.test(line)) {
      const item = ordered ? NUMBERED : BULLET
      const items: string[] = []
      while (i < lines.length && lines[i].trim()) {
        const l = lines[i]
        const m = item.exec(l)
        if (m) items.push(m[1].trim())
        else if (/^\s/.test(l) && items.length > 0 && !HEADING.test(l.trim()) && !FENCE.test(l)) {
          items[items.length - 1] += ` ${l.trim()}` // a wrapped item
        } else break
        i++
      }
      out.push({ kind: 'list', ordered, items })
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !HEADING.test(lines[i]) && !FENCE.test(lines[i])
      && !BULLET.test(lines[i]) && !NUMBERED.test(lines[i])) {
      para.push(lines[i++].trim())
    }
    out.push({ kind: 'para', text: para.join(' ') })
  }
  return out
}

function renderBlock(b: Block, key: number, open: (url: string) => void): ReactNode {
  switch (b.kind) {
    case 'heading': {
      // The dialog's own headings come first: # is h3, ## is h4, …
      const Tag = (['h3', 'h4', 'h5', 'h6'] as const)[Math.min(b.level, 4) - 1]
      return <Tag key={key}>{inline(b.text, open)}</Tag>
    }
    case 'list': {
      const items = b.items.map((t, j) => <li key={j}>{inline(t, open)}</li>)
      return b.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>
    }
    case 'code': return <pre key={key}><code>{b.text}</code></pre>
    case 'para': return <p key={key}>{inline(b.text, open)}</p>
  }
}

// `code` | **bold** | [label](target, may hold one level of parens) | bare http(s) URL, without trailing punctuation
const INLINE = /(`[^`\n]+`)|\*\*([^*\n]+?)\*\*|\[([^\]\n]+)\]\(\s*((?:[^()\s]|\([^()\s]*\))*)\s*\)|(https?:\/\/[^\s<>()[\]"'`]*[^\s<>()[\]"'`.,;:!?*_])/g

function inline(text: string, open: (url: string) => void, bold = true): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let k = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index
    if (at > last) out.push(text.slice(last, at))
    last = at + m[0].length
    const [, code, strong, label, target, bare] = m
    if (code !== undefined) out.push(<code key={k++}>{code.slice(1, -1)}</code>)
    else if (strong !== undefined) out.push(bold ? <strong key={k++}>{inline(strong, open, false)}</strong> : m[0])
    else if (label !== undefined) out.push(isWebUrl(target) ? link(target, label, k++, open) : label)
    else if (bare !== undefined) out.push(link(bare, bare, k++, open))
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const isWebUrl = (u: string): boolean => /^https?:\/\/[^\s]+$/i.test(u)

function link(url: string, label: string, key: number, open: (url: string) => void): ReactNode {
  return (
    <a key={key} href={url} onClick={(e) => { e.preventDefault(); open(url) }}>{label}</a>
  )
}
