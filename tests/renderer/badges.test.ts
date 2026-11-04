import { describe, expect, test } from 'vitest'
import { prChecksMark, prGlyph, prTooltip, rowFaded, rowLineCounts, statusLook } from '../../src/renderer/src/state/badges'
import type { PrInfo, SessionView } from '../../src/shared/types'

const pr = (x: Partial<PrInfo> = {}): PrInfo =>
  ({ number: 12, url: 'u', title: 't', state: 'OPEN', checks: 'none', updatedAt: 1, ...x })

describe('status icon', () => {
  test('each status has its own icon, so it reads without knowing the colours', () => {
    expect(statusLook('needs_you')).toMatchObject({ glyph: 'hand', tone: 'needs', label: 'Needs you' })
    expect(statusLook('working')).toMatchObject({ glyph: 'spinner', tone: 'working', label: 'Working' })
    expect(statusLook('unread')).toMatchObject({ glyph: 'check', tone: 'unread', label: 'Unread' })
    expect(statusLook('read')).toMatchObject({ glyph: 'check', tone: 'read', label: 'Read' })
    expect(statusLook('starting')).toMatchObject({ glyph: 'starting', tone: 'read', label: 'Starting' })
  })

  test('quitting Claude is calm; any other exit is a warning', () => {
    expect(statusLook('exited', 0)).toMatchObject({ glyph: 'stopped', tone: 'read', label: 'Exited' })
    expect(statusLook('exited', 137)).toMatchObject({ glyph: 'warning', tone: 'exited', label: 'Exited (code 137)' })
    expect(statusLook('exited')).toMatchObject({ glyph: 'warning', tone: 'exited', label: 'Exited' })
  })
})

describe('PR chip', () => {
  test('icon by state: open, draft, merged, closed', () => {
    expect(prGlyph(pr())).toBe('open')
    expect(prGlyph(pr({ draft: true }))).toBe('draft')
    expect(prGlyph(pr({ state: 'MERGED' }))).toBe('merged')
    expect(prGlyph(pr({ state: 'CLOSED', draft: true }))).toBe('closed')
  })

  test('checks mark only for an open PR that has checks', () => {
    expect(prChecksMark(pr({ checks: 'passing' }))).toBe('pass')
    expect(prChecksMark(pr({ checks: 'failing' }))).toBe('fail')
    expect(prChecksMark(pr({ checks: 'pending', draft: true }))).toBe('pending')
    expect(prChecksMark(pr({ checks: 'none' }))).toBeNull()
    expect(prChecksMark(pr({ state: 'MERGED', checks: 'failing' }))).toBeNull()
    expect(prChecksMark(pr({ state: 'CLOSED', checks: 'passing' }))).toBeNull()
  })

  test('tooltip spells it out', () => {
    expect(prTooltip(pr({ checks: 'failing' }))).toBe('PR #12 · Open · checks failing')
    expect(prTooltip(pr({ draft: true, checks: 'pending' }))).toBe('PR #12 · Draft · checks pending')
    expect(prTooltip(pr({ state: 'MERGED', checks: 'passing' }))).toBe('PR #12 · Merged')
    expect(prTooltip(pr({ state: 'CLOSED' }))).toBe('PR #12 · Closed')
  })
})

describe('session row', () => {
  const s = (x: Partial<SessionView>): SessionView => ({ status: 'read', ...x }) as SessionView

  test('line counts until a PR exists, then the PR chip takes their place', () => {
    const diffStat = { additions: 3, deletions: 1 }
    expect(rowLineCounts(s({ diffStat }))).toEqual(diffStat)
    expect(rowLineCounts(s({ diffStat, pr: pr() }))).toBeNull()
    expect(rowLineCounts(s({}))).toBeNull()
  })

  test('a merged session fades once there is nothing waiting in it', () => {
    const merged = pr({ state: 'MERGED' })
    expect(rowFaded(s({ pr: merged, status: 'read' }))).toBe(true)
    expect(rowFaded(s({ pr: merged, status: 'exited' }))).toBe(true)
    for (const status of ['needs_you', 'unread', 'working', 'starting'] as const) expect(rowFaded(s({ pr: merged, status }))).toBe(false)
    expect(rowFaded(s({ pr: pr(), status: 'read' }))).toBe(false)
    expect(rowFaded(s({ status: 'read' }))).toBe(false)
  })
})
