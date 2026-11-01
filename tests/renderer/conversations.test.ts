import { describe, expect, test } from 'vitest'
import type { ConversationItem, ConversationMatch } from '@shared/types'
import { activeMinutesAgo, conversationRows } from '../../src/renderer/src/state/conversations'

const item = (kind: ConversationItem['kind'], id: string, title: string, o: Partial<ConversationItem> = {}): ConversationItem =>
  ({ kind, id, title, updatedAt: 1, ...o })
const match = (kind: ConversationMatch['kind'], id: string, o: Partial<ConversationMatch> = {}): ConversationMatch =>
  ({ kind, id, matchedIn: 'conversation', snippet: '…pelican…', ...o })

const items = [
  item('outside', 'o1', 'Fix the flaky login test'),
  item('archived', 'a1', 'Invoice export'),
  item('outside', 'o2', 'Tidy up the release SCRIPT'),
  // An archived session and an outside conversation can't share an id, but the kinds are told apart anyway.
  item('archived', 'o2', 'Login page copy')
]
const ids = (rows: ReturnType<typeof conversationRows>): string[] => rows.map((r) => `${r.item.kind}:${r.item.id}`)

describe('conversationRows', () => {
  test('no query: every conversation, in the order given (newest first)', () => {
    expect(ids(conversationRows(items, '  ', null))).toEqual(['outside:o1', 'archived:a1', 'outside:o2', 'archived:o2'])
  })

  test('typing filters titles at once: every word, any case', () => {
    expect(ids(conversationRows(items, 'login', null))).toEqual(['outside:o1', 'archived:o2'])
    expect(ids(conversationRows(items, 'script TIDY', null))).toEqual(['outside:o2'])
    expect(conversationRows(items, 'L', null).every((r) => r.snippet === undefined)).toBe(true)
  })

  test("the search's text matches follow the title matches, with their snippet; nothing twice", () => {
    const search = {
      query: 'login',
      matches: [
        match('outside', 'o1', { matchedIn: 'title', snippet: '' }),
        match('archived', 'a1', { snippet: '…the login cookie…' }),
        match('archived', 'o2', { matchedIn: 'title', snippet: '' })
      ]
    }
    const rows = conversationRows(items, ' login ', search)
    expect(ids(rows)).toEqual(['outside:o1', 'archived:o2', 'archived:a1'])
    expect(rows.map((r) => r.snippet)).toEqual([undefined, undefined, '…the login cookie…'])
  })

  test('a search for another query, or a match not in the list, adds nothing', () => {
    const stale = { query: 'logi', matches: [match('archived', 'a1')] }
    expect(ids(conversationRows(items, 'login', stale))).toEqual(['outside:o1', 'archived:o2'])
    const unknown = { query: 'pelican', matches: [match('outside', 'gone'), match('archived', 'o1'), match('outside', 'o1')] }
    expect(ids(conversationRows(items, 'pelican', unknown))).toEqual(['outside:o1'])
  })

  test('a match without a snippet shows none', () => {
    const rows = conversationRows(items, 'pelican', { query: 'pelican', matches: [match('outside', 'o2', { snippet: '' })] })
    expect(rows).toEqual([{ item: items[2], snippet: undefined }])
  })
})

describe('activeMinutesAgo', () => {
  test('whole minutes, never less than 1', () => {
    const now = 10_000_000
    expect(activeMinutesAgo(now, now)).toBe(1)
    expect(activeMinutesAgo(now + 5000, now)).toBe(1) // a clock a little ahead
    expect(activeMinutesAgo(now - 20_000, now)).toBe(1)
    expect(activeMinutesAgo(now - 100_000, now)).toBe(2)
    expect(activeMinutesAgo(now - 5 * 60_000, now)).toBe(5)
  })
})
