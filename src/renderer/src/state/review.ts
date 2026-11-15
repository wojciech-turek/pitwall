import { create } from 'zustand'
import type { ReviewComment } from '../../../shared/types'

const KEY = 'pitwall.review.v1'

function load(): Record<string, ReviewComment[]> {
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
    const v = raw == null ? null : JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

function store(byId: Record<string, ReviewComment[]>): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(byId))
  } catch { /* storage unavailable or full */ }
}

let seq = 0
const newId = (): string => `${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`

interface ReviewState {
  /** Comments not yet sent, per session id. */
  byId: Record<string, ReviewComment[]>
  add(sessionId: string, c: Omit<ReviewComment, 'id'>): void
  remove(sessionId: string, id: string): void
  clear(sessionId: string): void
}

export const useReview = create<ReviewState>((set, get) => {
  const commit = (byId: Record<string, ReviewComment[]>): void => {
    set({ byId })
    store(byId)
  }
  return {
    byId: load(),
    add: (sessionId, c) => {
      const byId = get().byId
      commit({ ...byId, [sessionId]: [...(byId[sessionId] ?? []), { ...c, id: newId() }] })
    },
    remove: (sessionId, id) => {
      const byId = get().byId
      commit({ ...byId, [sessionId]: (byId[sessionId] ?? []).filter((x) => x.id !== id) })
    },
    clear: (sessionId) => {
      const { [sessionId]: _gone, ...rest } = get().byId
      commit(rest)
    }
  }
})
