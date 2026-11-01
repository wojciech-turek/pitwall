// The "Continue a conversation" dialog's rows: a folder's past conversations, filtered as you type. Pure.
import type { ConversationItem, ConversationMatch } from '@shared/types'

/** Searching the conversations' text starts from this many characters (titles are filtered from the first). */
export const MIN_TEXT_SEARCH = 2

export interface ConversationRow { item: ConversationItem; snippet?: string }

/** What searchConversations answered, and for which query. */
export interface ConversationSearch { query: string; matches: ConversationMatch[] }

const key = (kind: string, id: string): string => `${kind}:${id}`

/**
 * The rows to show for `query`: the conversations whose title has every word of it (all of them for none), in the
 * order given, then the ones the search found in their text, with the snippet. A search for another query adds nothing.
 */
export function conversationRows(items: ConversationItem[], query: string, search: ConversationSearch | null): ConversationRow[] {
  const q = query.trim()
  if (!q) return items.map((item) => ({ item }))
  const terms = q.toLowerCase().split(/\s+/)
  const rows: ConversationRow[] = items.filter((i) => terms.every((t) => i.title.toLowerCase().includes(t))).map((item) => ({ item }))
  if (q.length < MIN_TEXT_SEARCH || search?.query !== q) return rows
  const shown = new Set(rows.map((r) => key(r.item.kind, r.item.id)))
  const byKey = new Map(items.map((i) => [key(i.kind, i.id), i]))
  for (const m of search.matches) {
    const k = key(m.kind, m.id)
    const item = byKey.get(k)
    if (!item || shown.has(k)) continue
    shown.add(k)
    rows.push({ item, snippet: m.matchedIn === 'conversation' && m.snippet ? m.snippet : undefined })
  }
  return rows
}

/** For "active <N> min ago": whole minutes since `updatedAt`, at least 1. */
export function activeMinutesAgo(updatedAt: number, now: number = Date.now()): number {
  return Math.max(1, Math.round((now - updatedAt) / 60_000))
}
