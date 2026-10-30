import { create } from 'zustand'
import type { AddFolderResult } from '@shared/api'
import { clearDraft, clearSessionDrafts } from '../editor/drafts'
import * as L from './layout'
import type { Layout, Zone } from './layout'

export type MainTab = { id: 'claude' } | { id: 'shell' } | { id: string; kind: 'file' | 'diff'; path: string }

export type DialogState =
  | { type: 'project'; projectId?: string }
  | { type: 'identity-confirm'; projectId: string; result: Extract<AddFolderResult, { status: 'needs_identity_confirm' }> }
  | { type: 'new-session'; subProjectId: string }
  | { type: 'archive'; sessionId: string }
  | { type: 'resume'; sessionId: string }
  | { type: 'subproject-settings'; subProjectId: string }
  | { type: 'settings' }
  | { type: 'update' }
  | { type: 'discard-file'; sessionId: string; tabId: string; name: string }

export interface UiState {
  layout: Layout
  /** Sessions shown in a pane (derived from layout). */
  visibleSessionIds: string[]
  /** The active pane's session (derived from layout). */
  selectedSessionId: string | null
  draggingSessionId: string | null
  tabs: Record<string, MainTab[]>
  activeTab: Record<string, string>
  rightTab: 'files' | 'changes'
  dialog: DialogState | null
  dirty: Record<string, boolean>
  diffMode: 'split' | 'unified'
  setDiffMode(m: 'split' | 'unified'): void
  /** Show a session: activates its pane, or shows it in the active pane. */
  select(id: string): void
  dropSession(sessionId: string, targetPaneId: string | null, zone: Zone): void
  focusPane(paneId: string): void
  closePane(paneId: string): void
  /** persist=false while a divider is being dragged; persistLayout() saves at the end. */
  setRatio(splitId: string, ratio: number, persist?: boolean): void
  persistLayout(): void
  /** Close the panes of sessions that are gone. */
  pruneSessions(liveIds: Set<string>): void
  setDraggingSession(id: string | null): void
  openTab(sessionId: string, tab: MainTab): void
  closeTab(sessionId: string, tabId: string): void
  setActiveTab(sessionId: string, tabId: string): void
  setRightTab(t: 'files' | 'changes'): void
  openDialog(d: DialogState): void
  closeDialog(): void
  setDirty(tabKey: string, dirty: boolean): void
  /** Forget tabs, drafts and dirty flags of a session that no longer exists (archived). */
  forgetSession(sessionId: string): void
}

const defaultTabs = (): MainTab[] => [{ id: 'claude' }, { id: 'shell' }]

const LAYOUT_KEY = 'pitwall.layout.v1'

/** Where the pane layout is kept between runs. Tests replace load/save. */
export const layoutStorage = {
  load(): unknown {
    try {
      const raw = globalThis.localStorage?.getItem(LAYOUT_KEY)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  },
  save(l: Layout): void {
    try {
      globalThis.localStorage?.setItem(LAYOUT_KEY, JSON.stringify(l))
    } catch { /* storage unavailable or full */ }
  }
}

// Pane ids are saved with the layout, so they must stay unique across restarts.
const newId = (): string => crypto.randomUUID()

type LayoutFields = Pick<UiState, 'layout' | 'visibleSessionIds' | 'selectedSessionId' | 'tabs' | 'activeTab'>

/** Derived fields for a layout, plus default tabs for every visible session. */
function layoutFields(layout: Layout, s: Pick<UiState, 'visibleSessionIds' | 'tabs' | 'activeTab'>): LayoutFields {
  const ids = L.visibleSessionIds(layout)
  const same = ids.length === s.visibleSessionIds.length && ids.every((id, i) => id === s.visibleSessionIds[i])
  let { tabs, activeTab } = s
  for (const id of ids) {
    if (!tabs[id]) tabs = { ...tabs, [id]: defaultTabs() }
    if (!activeTab[id]) activeTab = { ...activeTab, [id]: 'claude' }
  }
  return { layout, visibleSessionIds: same ? s.visibleSessionIds : ids, selectedSessionId: L.activeSessionId(layout), tabs, activeTab }
}

function applyLayout(s: UiState, layout: Layout, persist = true): UiState | LayoutFields {
  if (layout === s.layout) return s
  if (persist) layoutStorage.save(layout)
  return layoutFields(layout, s)
}

/** The user opened a session on purpose (sidebar, pane click): main clears "marked as unread". */
const opened = (id: string | null): void => {
  const api = (globalThis as { window?: { pitwall?: { sessionOpened(id: string): void } } }).window?.pitwall
  if (id) api?.sessionOpened(id)
}

export const useUi = create<UiState>()((set, get) => ({
  ...layoutFields(L.parseLayout(layoutStorage.load()), { visibleSessionIds: [], tabs: {}, activeTab: {} }),
  draggingSessionId: null,
  rightTab: 'files',
  dialog: null,
  dirty: {},
  diffMode: 'split',
  setDiffMode: (diffMode) => set({ diffMode }),
  select: (id) => {
    set((s) => applyLayout(s, L.showSession(s.layout, id, newId)))
    opened(id)
  },
  dropSession: (sessionId, targetPaneId, zone) =>
    set((s) => applyLayout(s, L.dropSession(s.layout, sessionId, targetPaneId, zone, newId))),
  focusPane: (paneId) => {
    set((s) => applyLayout(s, L.focusPane(s.layout, paneId)))
    opened(get().selectedSessionId)
  },
  closePane: (paneId) => set((s) => applyLayout(s, L.closePane(s.layout, paneId))),
  setRatio: (splitId, ratio, persist = true) => set((s) => applyLayout(s, L.setRatio(s.layout, splitId, ratio), persist)),
  persistLayout: () => layoutStorage.save(get().layout),
  pruneSessions: (liveIds) => set((s) => applyLayout(s, L.removeSessions(s.layout, (id) => liveIds.has(id)))),
  setDraggingSession: (draggingSessionId) => set({ draggingSessionId }),
  openTab: (sessionId, tab) =>
    set((s) => {
      const cur = s.tabs[sessionId] ?? defaultTabs()
      const tabs = cur.some((t) => t.id === tab.id) ? cur : [...cur, tab]
      return {
        tabs: { ...s.tabs, [sessionId]: tabs },
        activeTab: { ...s.activeTab, [sessionId]: tab.id }
      }
    }),
  closeTab: (sessionId, tabId) =>
    set((s) => {
      if (tabId === 'claude' || tabId === 'shell') return s
      const cur = s.tabs[sessionId]
      const idx = cur?.findIndex((t) => t.id === tabId) ?? -1
      if (!cur || idx < 0) return s
      const tabs = cur.filter((t) => t.id !== tabId)
      const activeTab =
        s.activeTab[sessionId] === tabId
          ? { ...s.activeTab, [sessionId]: tabs[idx - 1].id }
          : s.activeTab
      const dirty = { ...s.dirty }
      delete dirty[`${sessionId}:${tabId}`]
      clearDraft(`${sessionId}:${tabId}`)
      return { tabs: { ...s.tabs, [sessionId]: tabs }, activeTab, dirty }
    }),
  setActiveTab: (sessionId, tabId) => set((s) => ({ activeTab: { ...s.activeTab, [sessionId]: tabId } })),
  setRightTab: (rightTab) => set({ rightTab }),
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
  setDirty: (tabKey, dirty) => set((s) => ({ dirty: { ...s.dirty, [tabKey]: dirty } })),
  forgetSession: (sessionId) =>
    set((s) => {
      clearSessionDrafts(sessionId)
      const tabs = { ...s.tabs }
      const activeTab = { ...s.activeTab }
      delete tabs[sessionId]
      delete activeTab[sessionId]
      const dirty = Object.fromEntries(Object.entries(s.dirty).filter(([k]) => !k.startsWith(`${sessionId}:`)))
      return { tabs, activeTab, dirty }
    })
}))
