export interface Draft { content: string; baseMtimeMs: number }

const drafts = new Map<string, Draft>()

/** Key for an editor tab's unsaved draft (same shape as the `dirty` map key). */
export const draftKey = (sessionId: string, path: string): string => `${sessionId}:file:${path}`

export const getDraft = (key: string): Draft | undefined => drafts.get(key)
export const setDraft = (key: string, d: Draft): void => { drafts.set(key, d) }
export const clearDraft = (key: string): void => { drafts.delete(key) }

/** Drops every unsaved draft belonging to a session. */
export const clearSessionDrafts = (sessionId: string): void => {
  for (const k of [...drafts.keys()]) if (k.startsWith(`${sessionId}:`)) drafts.delete(k)
}
