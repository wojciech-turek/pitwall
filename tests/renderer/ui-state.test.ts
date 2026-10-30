import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { layoutStorage, useUi } from '../../src/renderer/src/state/ui'
import { EMPTY_LAYOUT, panes, parseLayout, type Layout } from '../../src/renderer/src/state/layout'

const file = (p: string) => ({ id: `file:${p}`, kind: 'file' as const, path: p })
const paneIds = (): string[] => panes(useUi.getState().layout).map((p) => p.id)

let saved: Layout[] = []

beforeEach(() => {
  saved = []
  layoutStorage.load = () => null
  layoutStorage.save = (l) => { saved.push(l) }
  useUi.setState({
    layout: EMPTY_LAYOUT, visibleSessionIds: [], selectedSessionId: null, draggingSessionId: null,
    tabs: {}, activeTab: {}, dialog: null, palette: null, dirty: {}
  })
})

describe('ui state', () => {
  test('claude and shell tabs cannot be closed', () => {
    const ui = useUi.getState()
    ui.select('s1')
    ui.closeTab('s1', 'claude')
    ui.closeTab('s1', 'shell')
    expect(useUi.getState().tabs['s1'].map((t) => t.id)).toEqual(['claude', 'shell'])
  })

  test('closing the active tab activates its left neighbour', () => {
    const ui = useUi.getState()
    ui.openTab('s1', file('a.ts'))
    ui.openTab('s1', file('b.ts'))
    ui.setActiveTab('s1', 'file:a.ts')
    ui.closeTab('s1', 'file:a.ts')
    expect(useUi.getState().activeTab['s1']).toBe('shell')
    ui.openTab('s1', file('c.ts'))
    ui.closeTab('s1', 'file:c.ts')
    expect(useUi.getState().activeTab['s1']).toBe('file:b.ts')
  })

  test('openTab dedups by id and activates it', () => {
    const ui = useUi.getState()
    ui.openTab('s1', file('a.ts'))
    ui.openTab('s1', file('b.ts'))
    ui.openTab('s1', file('a.ts'))
    const s = useUi.getState()
    expect(s.tabs['s1'].filter((t) => t.id === 'file:a.ts')).toHaveLength(1)
    expect(s.activeTab['s1']).toBe('file:a.ts')
  })

  test('tabs are per session', () => {
    const ui = useUi.getState()
    ui.openTab('s1', file('a.ts'))
    ui.openTab('s2', file('b.ts'))
    const s = useUi.getState()
    expect(s.tabs['s1'].map((t) => t.id)).toEqual(['claude', 'shell', 'file:a.ts'])
    expect(s.tabs['s2'].map((t) => t.id)).toEqual(['claude', 'shell', 'file:b.ts'])
    expect(s.activeTab['s1']).toBe('file:a.ts')
  })
})

describe('panes', () => {
  test('select shows the session in one pane, with default tabs', () => {
    useUi.getState().select('s1')
    const s = useUi.getState()
    expect(panes(s.layout)).toHaveLength(1)
    expect(s.selectedSessionId).toBe('s1')
    expect(s.visibleSessionIds).toEqual(['s1'])
    expect(s.tabs['s1'].map((t) => t.id)).toEqual(['claude', 'shell'])
    expect(s.activeTab['s1']).toBe('claude')
  })

  test('select keeps tabs a session already has', () => {
    const ui = useUi.getState()
    ui.openTab('s1', file('a.ts'))
    ui.select('s1')
    expect(useUi.getState().tabs['s1'].map((t) => t.id)).toEqual(['claude', 'shell', 'file:a.ts'])
    expect(useUi.getState().activeTab['s1']).toBe('file:a.ts')
  })

  test('select with one pane replaces its session', () => {
    const ui = useUi.getState()
    ui.select('s1')
    ui.select('s2')
    const s = useUi.getState()
    expect(s.visibleSessionIds).toEqual(['s2'])
    expect(s.selectedSessionId).toBe('s2')
  })

  test('dropSession splits; the new pane is active and gets default tabs', () => {
    const ui = useUi.getState()
    ui.select('s1')
    const [left] = paneIds()
    ui.dropSession('s2', left, 'right')
    const s = useUi.getState()
    expect(s.visibleSessionIds).toEqual(['s1', 's2'])
    expect(s.selectedSessionId).toBe('s2')
    expect(s.tabs['s2'].map((t) => t.id)).toEqual(['claude', 'shell'])
    expect(s.activeTab['s2']).toBe('claude')
    const ids = paneIds()
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(ids[0]).toBe(left)
  })

  test('focusPane makes that pane’s session the selected one', () => {
    const ui = useUi.getState()
    ui.select('s1')
    const [left] = paneIds()
    ui.dropSession('s2', left, 'right')
    ui.focusPane(left)
    expect(useUi.getState().selectedSessionId).toBe('s1')
    expect(useUi.getState().layout.activePaneId).toBe(left)
  })

  test('a sidebar click on a visible session activates its pane', () => {
    const ui = useUi.getState()
    ui.select('s1')
    ui.dropSession('s2', paneIds()[0], 'right')
    ui.select('s1')
    const s = useUi.getState()
    expect(s.visibleSessionIds).toEqual(['s1', 's2'])
    expect(s.selectedSessionId).toBe('s1')
  })

  test('closePane closes the pane; the other one becomes active', () => {
    const ui = useUi.getState()
    ui.select('s1')
    ui.dropSession('s2', paneIds()[0], 'right')
    ui.closePane(paneIds()[1])
    const s = useUi.getState()
    expect(s.visibleSessionIds).toEqual(['s1'])
    expect(s.selectedSessionId).toBe('s1')
  })

  test('pruneSessions drops panes of sessions that no longer exist', () => {
    const ui = useUi.getState()
    ui.select('s1')
    ui.dropSession('s2', paneIds()[0], 'right')
    ui.focusPane(paneIds()[0])
    ui.pruneSessions(new Set(['s2']))
    const s = useUi.getState()
    expect(s.visibleSessionIds).toEqual(['s2'])
    expect(s.selectedSessionId).toBe('s2')
    ui.pruneSessions(new Set())
    expect(useUi.getState().layout.root).toBeNull()
    expect(useUi.getState().selectedSessionId).toBeNull()
    expect(useUi.getState().visibleSessionIds).toEqual([])
  })

  test('setRatio changes the split ratio (clamped)', () => {
    const ui = useUi.getState()
    ui.select('s1')
    ui.dropSession('s2', paneIds()[0], 'bottom')
    const root = useUi.getState().layout.root!
    ui.setRatio(root.id, 0.99)
    const after = useUi.getState().layout.root!
    expect(after.type === 'split' && after.ratio).toBe(0.85)
  })

  test('dragging a divider saves the layout once, at the end', () => {
    const ui = useUi.getState()
    ui.select('s1')
    ui.dropSession('s2', paneIds()[0], 'right')
    const root = useUi.getState().layout.root!
    const before = saved.length
    ui.setRatio(root.id, 0.3, false)
    ui.setRatio(root.id, 0.4, false)
    expect(saved.length).toBe(before)
    ui.persistLayout()
    expect(saved.length).toBe(before + 1)
    const last = saved.at(-1)!.root!
    expect(last.type === 'split' && last.ratio).toBe(0.4)
  })

  test('visibleSessionIds keeps its identity while the visible set is unchanged', () => {
    const ui = useUi.getState()
    ui.select('s1')
    const [left] = paneIds()
    ui.dropSession('s2', left, 'right')
    const before = useUi.getState().visibleSessionIds
    ui.focusPane(left)
    expect(useUi.getState().visibleSessionIds).toBe(before)
  })

  test('setDraggingSession', () => {
    useUi.getState().setDraggingSession('s1')
    expect(useUi.getState().draggingSessionId).toBe('s1')
    useUi.getState().setDraggingSession(null)
    expect(useUi.getState().draggingSessionId).toBeNull()
    expect(saved).toHaveLength(0)
  })
})

describe('layout persistence', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  test('every layout change is saved; the saved layout restores the same panes', () => {
    const ui = useUi.getState()
    ui.select('s1')
    ui.dropSession('s2', paneIds()[0], 'right')
    ui.focusPane(paneIds()[0])
    const last = saved[saved.length - 1]
    expect(last).toBe(useUi.getState().layout)
    const restored = parseLayout(JSON.parse(JSON.stringify(last)))
    expect(restored).toEqual(useUi.getState().layout)
  })

  test('actions that change nothing do not save', () => {
    const ui = useUi.getState()
    ui.select('s1')
    const n = saved.length
    ui.select('s1')
    ui.focusPane(paneIds()[0])
    ui.pruneSessions(new Set(['s1']))
    ui.closePane('nope')
    expect(saved).toHaveLength(n)
  })

  test('a store created from localStorage restores the panes, the active pane and default tabs', async () => {
    const ui = useUi.getState()
    ui.select('s1')
    ui.dropSession('s2', paneIds()[0], 'right')
    const layout = useUi.getState().layout
    const data = new Map([['pitwall.layout.v1', JSON.stringify(layout)]])
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => { data.set(k, v) }
    })
    vi.resetModules()
    const fresh = (await import('../../src/renderer/src/state/ui')).useUi
    const s = fresh.getState()
    expect(s.layout).toEqual(layout)
    expect(s.visibleSessionIds).toEqual(['s1', 's2'])
    expect(s.selectedSessionId).toBe('s2')
    expect(s.tabs['s1'].map((t) => t.id)).toEqual(['claude', 'shell'])
    expect(s.activeTab['s2']).toBe('claude')

    s.focusPane(panes(layout)[0].id)
    expect(JSON.parse(data.get('pitwall.layout.v1')!).activePaneId).toBe(panes(layout)[0].id)
  })

  test('a malformed or missing saved layout starts empty', async () => {
    vi.stubGlobal('localStorage', { getItem: () => '{not json', setItem: () => { throw new Error('full') } })
    vi.resetModules()
    const fresh = (await import('../../src/renderer/src/state/ui')).useUi
    expect(fresh.getState().layout.root).toBeNull()
    expect(fresh.getState().selectedSessionId).toBeNull()
    fresh.getState().select('s1') // a failing save must not throw
    expect(fresh.getState().selectedSessionId).toBe('s1')

    vi.stubGlobal('localStorage', undefined)
    vi.resetModules()
    const bare = (await import('../../src/renderer/src/state/ui')).useUi
    expect(bare.getState().layout.root).toBeNull()
    bare.getState().select('s1')
    expect(bare.getState().visibleSessionIds).toEqual(['s1'])
  })
})

describe('palette', () => {
  test('dialogs and the palette never stack', () => {
    const ui = useUi.getState()
    ui.openPalette('commands')
    expect(useUi.getState().palette).toBe('commands')
    ui.openDialog({ type: 'settings' }) // e.g. an action that opens a dialog
    expect(useUi.getState().palette).toBeNull()
    expect(useUi.getState().dialog).toEqual({ type: 'settings' })
    ui.openPalette('files') // suppressed while a dialog is open
    expect(useUi.getState().palette).toBeNull()
    ui.closeDialog()
    ui.openPalette('files')
    expect(useUi.getState().palette).toBe('files')
    ui.closePalette()
    expect(useUi.getState().palette).toBeNull()
  })
})
