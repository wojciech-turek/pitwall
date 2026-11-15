import { formatAgentReference } from './agent-ref'
import { plainText } from './plain-text'
import type { ReviewComment } from './types'

const indent = (s: string): string => s.split('\n').map((l) => `   ${l}`).join('\n')

/** The one message that sends every review comment to the agent (pasted, so no control characters). '' when there is nothing to send. */
export function formatReview(comments: ReviewComment[], platform?: string): string {
  if (comments.length === 0) return ''
  const items = comments.map((c, i) => {
    const ref = formatAgentReference(c.path, { fromLine: c.fromLine, toLine: c.toLine }, platform).trim()
    const quote = c.quote.split('\n').map((l) => `   > ${l}`).join('\n')
    return `${i + 1}. ${ref}\n${quote}\n${indent(c.note)}`
  })
  const n = comments.length
  return plainText(`Review of your changes (${n} ${n === 1 ? 'comment' : 'comments'}):\n\n${items.join('\n\n')}\n\nPlease address each comment, then say briefly what you changed.`)
}
