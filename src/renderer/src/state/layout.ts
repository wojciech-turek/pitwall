// Pure split-view layout: a binary tree of splits whose leaves are panes, each showing one session.

export const MAX_PANES = 4
export type Zone = 'left' | 'right' | 'top' | 'bottom' | 'center'
export type PaneNode = { type: 'pane'; id: string; sessionId: string }
export type SplitNode = {
  type: 'split'
  id: string
  dir: 'row' | 'column'
  ratio: number
  a: LayoutNode
  b: LayoutNode
}
export type LayoutNode = PaneNode | SplitNode
export interface Layout {
  root: LayoutNode | null
  activePaneId: string | null
}

export const EMPTY_LAYOUT: Layout = Object.freeze({ root: null, activePaneId: null })

const MIN_RATIO = 0.15
const MAX_RATIO = 0.85
const EDGE_THRESHOLD = 0.3

function clampRatio(r: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, r))
}

function nodePanes(n: LayoutNode): PaneNode[] {
  return n.type === 'pane' ? [n] : [...nodePanes(n.a), ...nodePanes(n.b)]
}

// returns the same node when fn changes nothing, so unchanged subtrees stay shared
function mapNode(n: LayoutNode, fn: (n: LayoutNode) => LayoutNode): LayoutNode {
  if (n.type === 'split') {
    const a = mapNode(n.a, fn)
    const b = mapNode(n.b, fn)
    if (a !== n.a || b !== n.b) return fn({ ...n, a, b })
  }
  return fn(n)
}

// removes the pane leaf; its sibling takes the parent's place. Null when the node itself was the pane.
function removeLeaf(n: LayoutNode, paneId: string): LayoutNode | null {
  if (n.type === 'pane') return n.id === paneId ? null : n
  const a = removeLeaf(n.a, paneId)
  const b = removeLeaf(n.b, paneId)
  if (a === null) return b
  if (b === null) return a
  return a === n.a && b === n.b ? n : { ...n, a, b }
}

export function panes(l: Layout): PaneNode[] {
  return l.root ? nodePanes(l.root) : []
}

export function visibleSessionIds(l: Layout): string[] {
  return panes(l).map((p) => p.sessionId)
}

export function activeSessionId(l: Layout): string | null {
  return panes(l).find((p) => p.id === l.activePaneId)?.sessionId ?? null
}

export function paneOf(l: Layout, sessionId: string): PaneNode | undefined {
  return panes(l).find((p) => p.sessionId === sessionId)
}

export function focusPane(l: Layout, paneId: string): Layout {
  if (l.activePaneId === paneId) return l
  if (!panes(l).some((p) => p.id === paneId)) return l
  return { ...l, activePaneId: paneId }
}

function setPaneSession(l: Layout, paneId: string, sessionId: string): Layout {
  if (!l.root) return l
  const root = mapNode(l.root, (n) =>
    n.type === 'pane' && n.id === paneId && n.sessionId !== sessionId ? { ...n, sessionId } : n
  )
  return { root, activePaneId: paneId }
}

export function showSession(l: Layout, sessionId: string, newId: () => string): Layout {
  const existing = paneOf(l, sessionId)
  if (existing) return focusPane(l, existing.id)
  if (!l.root) {
    const id = newId()
    return { root: { type: 'pane', id, sessionId }, activePaneId: id }
  }
  const active = panes(l).find((p) => p.id === l.activePaneId) ?? panes(l)[0]
  return setPaneSession(l, active.id, sessionId)
}

export function effectiveZone(
  l: Layout,
  sessionId: string,
  targetPaneId: string,
  zone: Zone
): Zone {
  const target = panes(l).find((p) => p.id === targetPaneId)
  if (target?.sessionId === sessionId) return 'center'
  if (zone !== 'center' && panes(l).length >= MAX_PANES && !paneOf(l, sessionId)) return 'center'
  return zone
}

export function dropSession(
  l: Layout,
  sessionId: string,
  targetPaneId: string | null,
  zone: Zone,
  newId: () => string
): Layout {
  if (targetPaneId === null) return showSession(l, sessionId, newId)
  const target = panes(l).find((p) => p.id === targetPaneId)
  if (!target || !l.root) return l
  const z = effectiveZone(l, sessionId, targetPaneId, zone)
  if (target.sessionId === sessionId) return focusPane(l, targetPaneId)
  // a session lives in one pane only: moving it closes its old pane first
  const from = paneOf(l, sessionId)
  const base = from ? closePane(l, from.id) : l
  if (z === 'center') return setPaneSession(base, targetPaneId, sessionId)
  const pane: PaneNode = { type: 'pane', id: newId(), sessionId }
  const dir = z === 'left' || z === 'right' ? 'row' : 'column'
  const first = z === 'left' || z === 'top'
  const root = mapNode(base.root!, (n) =>
    n.type === 'pane' && n.id === targetPaneId
      ? { type: 'split', id: newId(), dir, ratio: 0.5, a: first ? pane : n, b: first ? n : pane }
      : n
  )
  return { root, activePaneId: pane.id }
}

export function closePane(l: Layout, paneId: string): Layout {
  if (!l.root || !panes(l).some((p) => p.id === paneId)) return l
  const root = removeLeaf(l.root, paneId)
  if (!root) return EMPTY_LAYOUT
  if (l.activePaneId !== paneId) return { ...l, root }
  // the closed pane was active: activate the first pane of the sibling subtree
  return { root, activePaneId: firstPaneOfSibling(l.root, paneId, root) }
}

// first pane of whatever replaced the closed leaf's parent
function firstPaneOfSibling(before: LayoutNode, paneId: string, after: LayoutNode): string {
  const find = (n: LayoutNode): LayoutNode | null => {
    if (n.type === 'pane') return null
    if (n.a.type === 'pane' && n.a.id === paneId) return n.b
    if (n.b.type === 'pane' && n.b.id === paneId) return n.a
    return find(n.a) ?? find(n.b)
  }
  return nodePanes(find(before) ?? after)[0].id
}

export function removeSessions(l: Layout, keep: (sessionId: string) => boolean): Layout {
  return panes(l)
    .filter((p) => !keep(p.sessionId))
    .reduce((acc, p) => closePane(acc, p.id), l)
}

export function setRatio(l: Layout, splitId: string, ratio: number): Layout {
  if (!l.root) return l
  const r = clampRatio(ratio)
  const root = mapNode(l.root, (n) =>
    n.type === 'split' && n.id === splitId && n.ratio !== r ? { ...n, ratio: r } : n
  )
  return root === l.root ? l : { ...l, root }
}

// strict structural parse; null when anything is malformed
function parseNode(raw: unknown, ids: Set<string>): LayoutNode | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || ids.has(r.id)) return null
  ids.add(r.id)
  if (r.type === 'pane') {
    if (typeof r.sessionId !== 'string') return null
    return { type: 'pane', id: r.id, sessionId: r.sessionId }
  }
  if (r.type !== 'split') return null
  if (r.dir !== 'row' && r.dir !== 'column') return null
  if (typeof r.ratio !== 'number' || !Number.isFinite(r.ratio)) return null
  const a = parseNode(r.a, ids)
  const b = parseNode(r.b, ids)
  if (!a || !b) return null
  return { type: 'split', id: r.id, dir: r.dir, ratio: clampRatio(r.ratio), a, b }
}

export function parseLayout(raw: unknown): Layout {
  if (typeof raw !== 'object' || raw === null) return EMPTY_LAYOUT
  const r = raw as Record<string, unknown>
  const root = parseNode(r.root, new Set())
  if (!root) return EMPTY_LAYOUT
  let l: Layout = { root, activePaneId: null }
  // keep the first pane of each session, then the first MAX_PANES panes
  const seen = new Set<string>()
  const extra: string[] = []
  const all = nodePanes(root)
  for (const p of all) {
    if (seen.has(p.sessionId)) extra.push(p.id)
    else seen.add(p.sessionId)
  }
  const kept = all.filter((p) => !extra.includes(p.id))
  for (const p of kept.slice(MAX_PANES)) extra.push(p.id)
  for (const id of extra) l = closePane(l, id)
  const remaining = panes(l)
  const active = remaining.find((p) => p.id === r.activePaneId) ?? remaining[0]
  return { root: l.root, activePaneId: active?.id ?? null }
}

export function zoneAt(x: number, y: number, width: number, height: number): Zone {
  if (!(width > 0) || !(height > 0)) return 'center' // not laid out yet
  const nx = x / width
  const ny = y / height
  const edges: [Zone, number][] = [
    ['left', nx],
    ['right', 1 - nx],
    ['top', ny],
    ['bottom', 1 - ny]
  ]
  let best = edges[0]
  for (const e of edges) if (e[1] < best[1]) best = e
  return best[1] > EDGE_THRESHOLD ? 'center' : best[0]
}
