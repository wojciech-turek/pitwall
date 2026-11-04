import { describe, expect, test } from 'vitest'
import type { AppSnapshot, HistoryHit, Project, Session, SessionView, SubProject } from '@shared/types'
import {
  fuzzyMatch, paletteActions, paletteResults, type ActionContext, type PaletteGroup, type PaletteInput
} from '../../src/renderer/src/state/palette'

const score = (q: string, t: string): number => {
  const m = fuzzyMatch(q, t)
  if (!m) throw new Error(`no match: ${q} in ${t}`)
  return m.score
}

const identity = { sshKeyPath: '', ghAccount: '', gitName: '', gitEmail: '' }
const project = (id: string, o: Partial<Project> = {}): Project => ({ id, name: id, identity, extraEnv: [], createdAt: 1, ...o })
const sub = (id: string, o: Partial<SubProject> = {}): SubProject =>
  ({ id, projectId: 'p1', name: id, path: `/r/${id}`, kind: 'repo', createdAt: 1, ...o })
const session = (id: string, title: string, o: Partial<SessionView> = {}): SessionView => ({
  id, subProjectId: 'tax', title, slug: id, claudeSessionId: `c-${id}`, cwd: `/w/${id}`, branchCreatedByPitwall: true,
  createdAt: 1, lastViewedAt: 1, status: 'read', ...o
})
const archived = (id: string, title: string): Session => ({ ...session(id, title), archivedAt: 5 })
const hit = (sessionId: string, title: string, o: Partial<HistoryHit> = {}): HistoryHit => ({
  sessionId, title, archived: true, projectName: 'p1', subProjectName: 'tax', matchedIn: 'conversation',
  snippet: '…wombat…', updatedAt: 1, ...o
})

function snapOf(o: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    projects: [project('p1')], subProjects: [sub('tax')], sessions: [], archived: [],
    settings: { monoFont: '', monoFontSize: 13, checkForUpdates: true, sounds: false }, ...o
  }
}
function ctxOf(o: Partial<ActionContext> = {}): ActionContext {
  return { snap: snapOf(), activeSessionId: null, paneCount: 0, rightTab: 'files', canCheckUpdates: true, ...o }
}
function input(o: Partial<PaletteInput> = {}): PaletteInput {
  return { mode: 'commands', query: '', snap: snapOf(), activeSessionId: null, actions: [], files: null, history: null, ...o }
}
const labels = (g: PaletteGroup | undefined): string[] => g?.items.map((i) => i.label) ?? []
const kinds = (gs: PaletteGroup[]): string[] => gs.map((g) => g.kind)

describe('fuzzyMatch', () => {
  test('matches a subsequence, ignoring case; anything else is no match', () => {
    expect(fuzzyMatch('FTR', 'fix tax rounding')).not.toBeNull()
    expect(fuzzyMatch('xtf', 'fix tax rounding')).toBeNull()
    expect(fuzzyMatch('taxx', 'fix tax rounding')).toBeNull()
  })

  test('word starts beat letters in the middle of words', () => {
    expect(score('ftr', 'Fix tax rounding')).toBeGreaterThan(score('ftr', 'after rest'))
    expect(score('ex', 'Invoice export')).toBeGreaterThan(score('ex', 'Index'))
    expect(score('ip', 'invoicePdf')).toBeGreaterThan(score('ip', 'shipped'))
  })

  test('consecutive letters beat scattered ones', () => {
    expect(score('tax', 'tax rounding')).toBeGreaterThan(score('tax', 'the axe'))
    expect(score('round', 'Fix rounding')).toBeGreaterThan(score('round', 'rate of undo'))
  })

  test('every word of the query must match, in any order', () => {
    expect(fuzzyMatch('round fix', 'Fix tax rounding')).not.toBeNull()
    expect(fuzzyMatch('round zebra', 'Fix tax rounding')).toBeNull()
  })

  test('positions point at the matched letters', () => {
    expect(fuzzyMatch('tax', 'Fix tax rounding')!.positions).toEqual([4, 5, 6])
    expect(fuzzyMatch('ftr', 'Fix tax rounding')!.positions).toEqual([0, 4, 8])
  })

  test('an empty query matches everything with score 0', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, positions: [] })
    expect(fuzzyMatch('   ', 'anything')).toEqual({ score: 0, positions: [] })
  })
})

describe('paletteResults', () => {
  test('groups come in order: Sessions, Actions, Files, Past sessions', () => {
    const snap = snapOf({ sessions: [session('a', 'Wombat totals')] })
    const actions = paletteActions(ctxOf({ snap, activeSessionId: 'a', paneCount: 1 }))
    const groups = paletteResults(input({
      query: 'wo', snap, activeSessionId: 'a',
      actions: [...actions, { key: 'x', id: 'settings', label: 'Work settings' }],
      files: [{ path: 'src/wombat.ts' }],
      history: { query: 'wo', hits: [hit('old', 'Old wombat')] }
    }))
    expect(kinds(groups)).toEqual(['session', 'action', 'file', 'history'])
    expect(groups.map((g) => g.title)).toEqual(['Sessions', 'Actions', 'Files', 'Past sessions'])
  })

  test('sessions rank by match quality, ties by recency', () => {
    const snap = snapOf({
      sessions: [
        session('old', 'Fix login', { lastViewedAt: 10 }),
        session('new', 'Fix logout', { lastViewedAt: 50 }),
        session('mid', 'Refix', { lastViewedAt: 30 }),
        session('none', 'Docs')
      ]
    })
    const g = paletteResults(input({ query: 'fix', snap }))[0]
    expect(labels(g)).toEqual(['Fix logout', 'Fix login', 'Refix'])
    // recent activity counts as recency too
    const snap2 = snapOf({
      sessions: [session('a', 'Fix one', { lastViewedAt: 10, lastActivityAt: 90 }), session('b', 'Fix two', { lastViewedAt: 50 })]
    })
    expect(labels(paletteResults(input({ query: 'fix', snap: snap2 }))[0])).toEqual(['Fix one', 'Fix two'])
  })

  test('an empty query shows recent sessions (not the active one) and common actions only', () => {
    const snap = snapOf({
      sessions: [
        session('a', 'Alpha', { lastViewedAt: 10 }), session('b', 'Beta', { lastViewedAt: 30 }), session('c', 'Gamma', { lastViewedAt: 20 })
      ],
      archived: [archived('z', 'Zed')]
    })
    const actions = paletteActions(ctxOf({ snap, activeSessionId: 'b', paneCount: 2 }))
    const groups = paletteResults(input({
      snap, activeSessionId: 'b', actions, files: [{ path: 'a.ts' }], history: { query: '', hits: [hit('z', 'Zed')] }
    }))
    expect(kinds(groups)).toEqual(['session', 'action'])
    expect(labels(groups[0])).toEqual(['Gamma', 'Alpha'])
    const common = actions.filter((a) => a.common).map((a) => a.label)
    expect(labels(groups[1])).toEqual(common)
    expect(common.length).toBeGreaterThan(0)
    expect(common.length).toBeLessThan(actions.length)
  })

  test('files mode shows only files of the active session; changed files first when nothing is typed', () => {
    const snap = snapOf({ sessions: [session('a', 'Readme work')] })
    const files = [{ path: 'README.md' }, { path: 'src/app.ts', status: 'M' as const }, { path: 'docs/read.txt' }]
    const empty = paletteResults(input({ mode: 'files', snap, activeSessionId: 'a', files, actions: paletteActions(ctxOf({ snap })) }))
    expect(kinds(empty)).toEqual(['file'])
    expect(empty[0].items.map((i) => i.kind === 'file' && i.path)).toEqual(['src/app.ts', 'README.md', 'docs/read.txt'])
    const typed = paletteResults(input({ mode: 'files', query: 'read', snap, activeSessionId: 'a', files, history: { query: 'read', hits: [hit('x', 'read')] } }))
    expect(kinds(typed)).toEqual(['file'])
    expect(typed[0].items.map((i) => i.kind === 'file' && i.path)).toEqual(['README.md', 'docs/read.txt'])
  })

  test('files: a match in the file name beats one spread over the folders', () => {
    const files = [{ path: 'apps/legacy/index.ts' }, { path: 'src/renderer/App.tsx' }]
    const g = paletteResults(input({ query: 'app', files }))[0]
    expect(g.items.map((i) => i.kind === 'file' && i.path)).toEqual(['src/renderer/App.tsx', 'apps/legacy/index.ts'])
    expect(g.items[0]).toMatchObject({ label: 'App.tsx', detail: 'src/renderer', labelHits: [0, 1, 2] })
  })

  test('past sessions need two characters and skip sessions already listed', () => {
    const snap = snapOf({ sessions: [session('a', 'Wombat totals')] })
    const hits = [hit('a', 'Wombat totals', { archived: false }), hit('z', 'Invoices')]
    expect(paletteResults(input({ query: 'w', snap, history: { query: 'w', hits } })).map((g) => g.kind)).toEqual(['session'])
    const g = paletteResults(input({ query: 'wombat ', snap, history: { query: 'wombat', hits } }))
    expect(kinds(g)).toEqual(['session', 'history'])
    expect(labels(g[1])).toEqual(['Invoices'])
    expect(g[1].items[0]).toMatchObject({ kind: 'history', hit: { sessionId: 'z', snippet: '…wombat…' } })
  })

  test('past sessions found for an earlier query are never offered', () => {
    const history = { query: 'wombat', hits: [hit('z', 'Invoices')] }
    expect(kinds(paletteResults(input({ query: 'wombat', history })))).toEqual(['history'])
    // typed on: until the new answer arrives there is nothing to pick by mistake
    expect(paletteResults(input({ query: 'wombatx', history }))).toEqual([])
    expect(paletteResults(input({ query: 'womba', history }))).toEqual([])
  })

  test('the same files and query rank the same, without ranking again', () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ path: `src/f${i}/file${i}.ts` }))
    const a = paletteResults(input({ mode: 'files', query: 'file1', files }))
    const b = paletteResults(input({ mode: 'files', query: 'file1', files, snap: snapOf({ sessions: [session('x', 'X')] }) }))
    expect(b[0].items).toBe(a[0].items) // a snapshot push alone doesn't re-rank
    const c = paletteResults(input({ mode: 'files', query: 'file1', files: [...files] }))
    expect(c[0].items).not.toBe(a[0].items)
    expect(c[0].items).toEqual(a[0].items)
  })

  test('actions match their label or keywords', () => {
    const actions = paletteActions(ctxOf())
    expect(labels(paletteResults(input({ query: 'settings', actions }))[0])).toEqual(['Settings…'])
    expect(labels(paletteResults(input({ query: 'preferences', actions }))[0])).toEqual(['Settings…'])
    expect(labels(paletteResults(input({ query: 'pref', actions }))[0])).toEqual(['Settings…'])
    expect(labels(paletteResults(input({ query: 'settings font', actions }))[0])).toEqual(['Settings…'])
    // keywords match from the start of a word only
    const repo = paletteActions(ctxOf({ snap: snapOf({ sessions: [session('a', 'Alpha')] }), activeSessionId: 'a' }))
    expect(labels(paletteResults(input({ query: 'diff', actions: repo }))[0])).toEqual(['Show Changes'])
    expect(labels(paletteResults(input({ query: 'iff', actions: repo }))[0])).not.toContain('Show Changes')
  })

  test('long lists are capped per group', () => {
    const files = Array.from({ length: 500 }, (_, i) => ({ path: `src/file${i}.ts` }))
    expect(paletteResults(input({ query: 'file', files }))[0].items.length).toBeLessThanOrEqual(8)
    expect(paletteResults(input({ mode: 'files', query: 'file', files }))[0].items.length).toBe(50)
  })
})

describe('paletteActions', () => {
  const ids = (c: ActionContext): string[] => paletteActions(c).map((a) => a.id)

  test('with no active session only global actions apply', () => {
    const a = ids(ctxOf())
    expect(a).toEqual(expect.arrayContaining(['new-session', 'settings', 'check-updates']))
    for (const x of ['archive', 'mark-unread', 'mute', 'unmute', 'open-in-cursor', 'show-files', 'show-changes', 'close-pane', 'archived', 'next-attention']) {
      expect(a).not.toContain(x)
    }
  })

  test('session actions apply to the active session', () => {
    const snap = snapOf({ sessions: [session('a', 'Alpha', { status: 'read' })] })
    const a = ids(ctxOf({ snap, activeSessionId: 'a', paneCount: 1 }))
    expect(a).toEqual(expect.arrayContaining(['archive', 'mark-unread', 'mute', 'open-in-cursor', 'show-changes']))
    expect(a).not.toContain('show-files') // already showing
    expect(a).not.toContain('close-pane') // only pane
    expect(a).not.toContain('unmute')
  })

  test('each action only when it applies', () => {
    const snap = snapOf({
      projects: [project('p1', { muted: true })],
      subProjects: [sub('tax'), sub('notes', { kind: 'folder' })],
      sessions: [session('a', 'Alpha', { status: 'working', subProjectId: 'notes' }), session('b', 'Beta', { status: 'needs_you' })],
      archived: [archived('z', 'Old')]
    })
    const a = ids(ctxOf({ snap, activeSessionId: 'a', paneCount: 2, rightTab: 'changes', canCheckUpdates: false }))
    expect(a).toEqual(expect.arrayContaining(['unmute', 'close-pane', 'archived', 'next-attention']))
    expect(a).not.toContain('mute')
    expect(a).not.toContain('mark-unread') // not read
    expect(a).not.toContain('show-changes') // a plain folder has no changes
    expect(a).not.toContain('show-files') // changes isn't shown for a folder, so files already is
    expect(a).not.toContain('check-updates')
  })

  test('sounds: "Turn sounds on" while they are off, "Turn sounds off" while on', () => {
    const off = paletteActions(ctxOf())
    expect(off.map((a) => a.id)).toContain('sounds-on')
    expect(off.map((a) => a.id)).not.toContain('sounds-off')
    const snap = snapOf({ settings: { ...snapOf().settings, sounds: true } })
    const on = ids(ctxOf({ snap }))
    expect(on).toContain('sounds-off')
    expect(on).not.toContain('sounds-on')
    // Found by what people would type to silence it during a call.
    expect(labels(paletteResults(input({ query: 'mute sound', actions: paletteActions(ctxOf({ snap })) }))[0])[0]).toBe('Turn sounds off')
    expect(labels(paletteResults(input({ query: 'sound', actions: off }))[0])[0]).toBe('Turn sounds on')
  })

  test('new session is offered per folder, the active session\'s folder first and common', () => {
    const snap = snapOf({
      subProjects: [sub('api'), sub('tax')],
      sessions: [session('a', 'Alpha', { subProjectId: 'tax' })]
    })
    const news = paletteActions(ctxOf({ snap, activeSessionId: 'a' })).filter((x) => x.id === 'new-session')
    expect(news.map((x) => [x.label, x.subProjectId, !!x.common])).toEqual([
      ['New session in tax…', 'tax', true], ['New session in api…', 'api', false]
    ])
  })

  test('next session that needs you skips the active one', () => {
    const snap = snapOf({ sessions: [session('a', 'Alpha', { status: 'needs_you' }), session('b', 'Beta')] })
    expect(ids(ctxOf({ snap, activeSessionId: 'a' }))).not.toContain('next-attention')
    expect(ids(ctxOf({ snap, activeSessionId: 'b' }))).toContain('next-attention')
  })

  test('action keys are unique', () => {
    const snap = snapOf({ subProjects: [sub('api'), sub('tax')], sessions: [session('a', 'Alpha')], archived: [archived('z', 'Z')] })
    const keys = paletteActions(ctxOf({ snap, activeSessionId: 'a', paneCount: 3 })).map((a) => a.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
