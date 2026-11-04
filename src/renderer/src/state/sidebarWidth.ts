import { create } from 'zustand'

export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = 480
export const SIDEBAR_DEFAULT = 260
const KEY = 'pitwall.sidebarWidth.v1'

export function clampSidebarWidth(w: number): number {
  if (!Number.isFinite(w)) return SIDEBAR_DEFAULT
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)))
}

function load(): number {
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
    return raw == null ? SIDEBAR_DEFAULT : clampSidebarWidth(Number(JSON.parse(raw)))
  } catch {
    return SIDEBAR_DEFAULT
  }
}

function store(w: number): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(w))
  } catch { /* storage unavailable or full */ }
}

interface SidebarWidthState {
  width: number
  /** While dragging: the width follows the pointer, unsaved. */
  setWidth(w: number): void
  /** The drag ended: the next run starts at this width. */
  save(): void
  /** Back to the default width (double-click on the edge). */
  reset(): void
}

export const useSidebarWidth = create<SidebarWidthState>((set, get) => ({
  width: load(),
  setWidth: (w) => set({ width: clampSidebarWidth(w) }),
  save: () => store(get().width),
  reset: () => {
    set({ width: SIDEBAR_DEFAULT })
    store(SIDEBAR_DEFAULT)
  }
}))
