import { describe, expect, test } from 'vitest'
import {
  EMPTY_LAYOUT,
  MAX_PANES,
  activeSessionId,
  closePane,
  dropSession,
  effectiveZone,
  focusPane,
  paneOf,
  panes,
  parseLayout,
  removeSessions,
  setRatio,
  showSession,
  visibleSessionIds,
  zoneAt,
  type Layout,
  type SplitNode
} from '../../src/renderer/src/state/layout'

function mkId(): () => string {
  let n = 0
  return () => `p${++n}`
}

// builds a layout by showing the first session, then dropping the rest onto the right edge of the last pane
function build(sessions: string[]): Layout {
  const newId = mkId()
  let l = showSession(EMPTY_LAYOUT, sessions[0], newId)
  for (const s of sessions.slice(1)) {
    const last = panes(l).at(-1)!
    l = dropSession(l, s, last.id, 'right', newId)
  }
  return l
}

// runs fn and checks the input was not mutated
function pure<T>(l: Layout, fn: (l: Layout) => T): T {
  const before = structuredClone(l)
  const out = fn(l)
  expect(l).toEqual(before)
  return out
}

describe('showSession', () => {
  test('empty layout opens one active pane', () => {
    const l = pure(EMPTY_LAYOUT, (x) => showSession(x, 'A', mkId()))
    expect(l.root).toEqual({ type: 'pane', id: 'p1', sessionId: 'A' })
    expect(l.activePaneId).toBe('p1')
    expect(EMPTY_LAYOUT).toEqual({ root: null, activePaneId: null })
  })

  test('single pane keeps its id and swaps the session', () => {
    const one = showSession(EMPTY_LAYOUT, 'A', mkId())
    const l = pure(one, (x) => showSession(x, 'B', mkId()))
    expect(l.root).toEqual({ type: 'pane', id: 'p1', sessionId: 'B' })
    expect(l.activePaneId).toBe('p1')
  })

  test('visible session only changes the active pane', () => {
    const two = build(['A', 'B'])
    expect(activeSessionId(two)).toBe('B')
    const l = pure(two, (x) => showSession(x, 'A', mkId()))
    expect(l.root).toBe(two.root)
    expect(activeSessionId(l)).toBe('A')
  })

  test('replaces the active pane of a split', () => {
    const two = build(['A', 'B'])
    const l = showSession(two, 'C', mkId())
    expect(visibleSessionIds(l)).toEqual(['A', 'C'])
  })
})

describe('dropSession edges', () => {
  test('right of a single pane', () => {
    const one = showSession(EMPTY_LAYOUT, 'A', mkId())
    const l = pure(one, (x) => dropSession(x, 'B', 'p1', 'right', () => 'p2'))
    const root = l.root as SplitNode
    expect(root.type).toBe('split')
    expect(root.dir).toBe('row')
    expect(root.ratio).toBe(0.5)
    expect(root.a).toEqual({ type: 'pane', id: 'p1', sessionId: 'A' })
    expect(root.b).toEqual({ type: 'pane', id: 'p2', sessionId: 'B' })
    expect(l.activePaneId).toBe('p2')
  })

  test('left puts the new pane first', () => {
    const one = showSession(EMPTY_LAYOUT, 'A', mkId())
    const l = dropSession(one, 'B', 'p1', 'left', () => 'p2')
    const root = l.root as SplitNode
    expect(root.dir).toBe('row')
    expect(root.a).toMatchObject({ id: 'p2', sessionId: 'B' })
    expect(root.b).toMatchObject({ id: 'p1', sessionId: 'A' })
  })

  test('top and bottom make columns', () => {
    const one = showSession(EMPTY_LAYOUT, 'A', mkId())
    const top = dropSession(one, 'B', 'p1', 'top', () => 'p2').root as SplitNode
    expect(top.dir).toBe('column')
    expect(top.a).toMatchObject({ sessionId: 'B' })
    const bottom = dropSession(one, 'B', 'p1', 'bottom', () => 'p2').root as SplitNode
    expect(bottom.dir).toBe('column')
    expect(bottom.b).toMatchObject({ sessionId: 'B' })
  })

  test('nested: bottom of the right pane of a row', () => {
    const two = build(['A', 'B'])
    const right = paneOf(two, 'B')!
    const l = dropSession(two, 'C', right.id, 'bottom', mkId())
    expect(panes(l).map((p) => p.sessionId)).toEqual(['A', 'B', 'C'])
    expect(visibleSessionIds(l)).toHaveLength(3)
  })

  test('null target behaves like showSession', () => {
    const one = showSession(EMPTY_LAYOUT, 'A', mkId())
    const l = dropSession(one, 'B', null, 'right', mkId())
    expect(l.root).toMatchObject({ type: 'pane', sessionId: 'B' })
  })

  test('unknown target is a no-op', () => {
    const one = showSession(EMPTY_LAYOUT, 'A', mkId())
    expect(dropSession(one, 'B', 'nope', 'right', mkId())).toBe(one)
  })
})

describe('moving and center', () => {
  test('moving A to the right edge of B gives [B | A]', () => {
    const two = build(['A', 'B'])
    const b = paneOf(two, 'B')!
    const l = pure(two, (x) => dropSession(x, 'A', b.id, 'right', mkId()))
    expect(panes(l)).toHaveLength(2)
    expect(visibleSessionIds(l)).toEqual(['B', 'A'])
    expect(activeSessionId(l)).toBe('A')
  })

  test('dropping onto the pane that already shows it only focuses', () => {
    const two = build(['A', 'B'])
    const a = paneOf(two, 'A')!
    const l = dropSession(two, 'A', a.id, 'right', mkId())
    expect(panes(l)).toHaveLength(2)
    expect(activeSessionId(l)).toBe('A')
  })

  test('center replaces the session in the target pane', () => {
    const two = build(['A', 'B'])
    const a = paneOf(two, 'A')!
    const l = dropSession(two, 'C', a.id, 'center', mkId())
    expect(panes(l)).toHaveLength(2)
    expect(visibleSessionIds(l)).toEqual(['C', 'B'])
    expect(activeSessionId(l)).toBe('C')
  })

  test('center with a visible session moves it and closes its old pane', () => {
    const two = build(['A', 'B'])
    const a = paneOf(two, 'A')!
    const l = dropSession(two, 'B', a.id, 'center', mkId())
    expect(l.root).toMatchObject({ type: 'pane', id: a.id, sessionId: 'B' })
    expect(l.activePaneId).toBe(a.id)
  })
})

describe('max panes', () => {
  test('edge drop of a new session becomes replace', () => {
    const four = build(['A', 'B', 'C', 'D'])
    expect(panes(four)).toHaveLength(MAX_PANES)
    const target = paneOf(four, 'B')!
    expect(effectiveZone(four, 'E', target.id, 'left')).toBe('center')
    const l = pure(four, (x) => dropSession(x, 'E', target.id, 'left', mkId()))
    expect(visibleSessionIds(l)).toEqual(['A', 'E', 'C', 'D'])
  })

  test('moving a visible session to an edge still splits', () => {
    const four = build(['A', 'B', 'C', 'D'])
    const target = paneOf(four, 'B')!
    expect(effectiveZone(four, 'D', target.id, 'left')).toBe('left')
    const l = dropSession(four, 'D', target.id, 'left', mkId())
    expect(panes(l)).toHaveLength(4)
    expect(new Set(visibleSessionIds(l)).size).toBe(4)
  })

  test('target that already shows the session is center', () => {
    const two = build(['A', 'B'])
    expect(effectiveZone(two, 'A', paneOf(two, 'A')!.id, 'right')).toBe('center')
  })
})

describe('closePane / removeSessions / focusPane / setRatio', () => {
  test('closing the active pane promotes its sibling subtree', () => {
    const newId = mkId()
    let l = showSession(EMPTY_LAYOUT, 'A', newId)
    l = dropSession(l, 'B', paneOf(l, 'A')!.id, 'right', newId)
    l = dropSession(l, 'C', paneOf(l, 'B')!.id, 'bottom', newId)
    l = focusPane(l, paneOf(l, 'A')!.id)
    const out = pure(l, (x) => closePane(x, paneOf(x, 'A')!.id))
    const root = out.root as SplitNode
    expect(root.type).toBe('split')
    expect(root.dir).toBe('column')
    expect(visibleSessionIds(out)).toEqual(['B', 'C'])
    expect(activeSessionId(out)).toBe('B')
  })

  test('closing an inactive pane keeps the active one', () => {
    const two = build(['A', 'B'])
    const out = closePane(two, paneOf(two, 'A')!.id)
    expect(activeSessionId(out)).toBe('B')
  })

  test('closing the last pane empties the layout; unknown id is a no-op', () => {
    const one = showSession(EMPTY_LAYOUT, 'A', mkId())
    expect(closePane(one, 'p1')).toEqual(EMPTY_LAYOUT)
    expect(closePane(one, 'nope')).toBe(one)
  })

  test('removeSessions drops only failing panes', () => {
    const three = build(['A', 'B', 'C'])
    const out = pure(three, (x) => removeSessions(x, (id) => id !== 'B'))
    expect(visibleSessionIds(out)).toEqual(['A', 'C'])
    expect(removeSessions(three, () => true)).toBe(three)
  })

  test('focusPane ignores unknown ids and is a no-op when already active', () => {
    const two = build(['A', 'B'])
    expect(focusPane(two, 'nope')).toBe(two)
    expect(focusPane(two, two.activePaneId!)).toBe(two)
  })

  test('setRatio clamps', () => {
    const two = build(['A', 'B'])
    const id = (two.root as SplitNode).id
    expect((pure(two, (x) => setRatio(x, id, 0.01)).root as SplitNode).ratio).toBe(0.15)
    expect((setRatio(two, id, 0.99).root as SplitNode).ratio).toBe(0.85)
    expect((setRatio(two, id, 0.3).root as SplitNode).ratio).toBe(0.3)
    expect(setRatio(two, 'nope', 0.3)).toBe(two)
  })
})

describe('parseLayout', () => {
  test('garbage becomes empty', () => {
    expect(parseLayout(null)).toEqual(EMPTY_LAYOUT)
    expect(parseLayout('x')).toEqual(EMPTY_LAYOUT)
    expect(parseLayout({ root: { type: 'pane' } })).toEqual(EMPTY_LAYOUT)
  })

  test('round-trips through JSON', () => {
    const l = build(['A', 'B', 'C'])
    expect(parseLayout(JSON.parse(JSON.stringify(l)))).toEqual(l)
  })

  test('drops duplicate sessions', () => {
    const raw = {
      root: {
        type: 'split',
        id: 's1',
        dir: 'row',
        ratio: 0.5,
        a: { type: 'pane', id: 'p1', sessionId: 'A' },
        b: { type: 'pane', id: 'p2', sessionId: 'A' }
      },
      activePaneId: 'p2'
    }
    const l = parseLayout(raw)
    expect(l.root).toEqual({ type: 'pane', id: 'p1', sessionId: 'A' })
    expect(l.activePaneId).toBe('p1')
  })

  test('drops panes beyond the maximum', () => {
    const five = {
      root: {
        type: 'split',
        id: 's1',
        dir: 'row',
        ratio: 2,
        a: {
          type: 'split',
          id: 's2',
          dir: 'column',
          ratio: 0.5,
          a: { type: 'pane', id: 'p1', sessionId: 'A' },
          b: { type: 'pane', id: 'p2', sessionId: 'B' }
        },
        b: {
          type: 'split',
          id: 's3',
          dir: 'column',
          ratio: 0.5,
          a: { type: 'pane', id: 'p3', sessionId: 'C' },
          b: {
            type: 'split',
            id: 's4',
            dir: 'row',
            ratio: 0.5,
            a: { type: 'pane', id: 'p4', sessionId: 'D' },
            b: { type: 'pane', id: 'p5', sessionId: 'E' }
          }
        }
      },
      activePaneId: 'p5'
    }
    const l = parseLayout(five)
    expect(visibleSessionIds(l)).toEqual(['A', 'B', 'C', 'D'])
    expect((l.root as SplitNode).ratio).toBe(0.85)
    expect(l.activePaneId).toBe('p1')
  })

  test('bad activePaneId falls back to the first pane', () => {
    const l = build(['A', 'B'])
    const out = parseLayout({ ...JSON.parse(JSON.stringify(l)), activePaneId: 'zzz' })
    expect(out.activePaneId).toBe(panes(out)[0].id)
  })
})

describe('zoneAt', () => {
  test('edges, center and ties', () => {
    expect(zoneAt(5, 50, 100, 100)).toBe('left')
    expect(zoneAt(95, 50, 100, 100)).toBe('right')
    expect(zoneAt(50, 5, 100, 100)).toBe('top')
    expect(zoneAt(50, 95, 100, 100)).toBe('bottom')
    expect(zoneAt(50, 50, 100, 100)).toBe('center')
    expect(zoneAt(31, 50, 100, 100)).toBe('center')
    expect(zoneAt(10, 5, 100, 100)).toBe('top')
    expect(zoneAt(5, 5, 100, 100)).toBe('left')
  })

  test('zoneAt on a pane with no size yet is center', () => {
    expect(zoneAt(0, 0, 0, 0)).toBe('center')
    expect(zoneAt(5, 5, 100, 0)).toBe('center')
  })
})
