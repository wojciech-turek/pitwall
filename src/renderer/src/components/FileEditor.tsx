import { useCallback, useEffect, useRef, useState } from 'react'
import { formatAgentReference } from '@shared/agent-ref'
import type { AppSnapshot } from '@shared/types'
import { clearDraft, draftKey, getDraft, setDraft } from '../editor/drafts'
import { createEditor, type EditorHandle } from '../editor/codemirror'
import { cleanIpcError } from '../state/errors'
import { useDiskRefresh } from '../state/refresh'
import { useToast } from '../state/toast'
import { useUi } from '../state/ui'
import { requestFocus } from '../terminal/termCache'

type Load =
  | { kind: 'loading' } | { kind: 'text' } | { kind: 'binary' }
  | { kind: 'too_large'; size: number } | { kind: 'error'; message: string }

const savers = new Map<string, () => Promise<void>>()
const focusers = new Map<string, () => void>()

/** Saves the active file tab of a session, if it is an editor. Used by the ⌘S menu command. */
export async function saveActiveFile(sessionId: string): Promise<void> {
  const tab = useUi.getState().activeTab[sessionId]
  if (tab) await savers.get(`${sessionId}:${tab}`)?.()
}

/** Focuses the editor of a session's active file tab. False when there is none (or it hasn't loaded yet). */
export function focusActiveFile(sessionId: string): boolean {
  const tab = useUi.getState().activeTab[sessionId]
  const focus = tab ? focusers.get(`${sessionId}:${tab}`) : undefined
  focus?.()
  return !!focus
}

export default function FileEditor({ snap, sessionId, path, active }: {
  snap: AppSnapshot; sessionId: string; path: string; active: boolean
}): React.JSX.Element {
  const tabKey = draftKey(sessionId, path)
  const tick = useDiskRefresh(snap, sessionId)
  const setDirty = useUi((s) => s.setDirty)
  const toast = useToast((s) => s.show)
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [conflict, setConflict] = useState(false)
  const host = useRef<HTMLDivElement>(null)
  const handle = useRef<EditorHandle | null>(null)
  const initial = useRef('')
  const mtime = useRef(0)
  const dirty = useRef(false)
  const markDirty = useCallback((d: boolean) => { dirty.current = d; setDirty(tabKey, d) }, [setDirty, tabKey])

  const read = useCallback(async (): Promise<void> => {
    try {
      clearDraft(tabKey)
      const r = await window.pitwall.readFile(sessionId, path)
      if (r.kind === 'text') {
        mtime.current = r.mtimeMs
        if (handle.current) handle.current.setDoc(r.content)
        else { initial.current = r.content; setLoad({ kind: 'text' }) }
      } else setLoad(r)
    } catch (e) {
      setLoad({ kind: 'error', message: cleanIpcError(e) })
    }
  }, [sessionId, path, tabKey])

  useEffect(() => {
    // A draft survives unmounts (e.g. switching sessions): restore it, keep it dirty and keep its base mtime.
    const d = getDraft(tabKey)
    if (d) {
      initial.current = d.content
      mtime.current = d.baseMtimeMs
      markDirty(true)
      setLoad({ kind: 'text' })
    } else void read()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read])

  const save = useCallback(async (force = false): Promise<void> => {
    const h = handle.current
    if (!h) return
    try {
      const r = await window.pitwall.writeFile(sessionId, path, h.getDoc(), force ? undefined : mtime.current)
      if (r.ok) { mtime.current = r.mtimeMs; clearDraft(tabKey); setConflict(false); markDirty(false) } else setConflict(true)
    } catch (e) {
      toast(`Could not save ${path}: ${cleanIpcError(e)}`)
    }
  }, [sessionId, path, tabKey, markDirty, toast])
  const saveRef = useRef(save)
  saveRef.current = save

  // Create the editor once the text has loaded.
  useEffect(() => {
    if (load.kind !== 'text' || !host.current) return
    const h = createEditor({
      parent: host.current, doc: initial.current, path,
      fontFamily: snap.settings.monoFont, fontSize: snap.settings.monoFontSize,
      onChange: () => { markDirty(true); setDraft(tabKey, { content: h.getDoc(), baseMtimeMs: mtime.current }) }, onSave: () => { void saveRef.current() }
    })
    handle.current = h
    savers.set(tabKey, () => saveRef.current())
    focusers.set(tabKey, () => h.view.focus())
    return () => { h.destroy(); handle.current = null; savers.delete(tabKey); focusers.delete(tabKey) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load.kind, tabKey])

  // Clean editors follow the disk silently.
  useEffect(() => {
    if (tick === 0 || !handle.current || dirty.current) return
    void (async () => {
      try {
        const r = await window.pitwall.readFile(sessionId, path)
        if (r.kind === 'text' && r.mtimeMs !== mtime.current && !dirty.current) {
          mtime.current = r.mtimeMs
          if (r.content !== handle.current?.getDoc()) handle.current?.setDoc(r.content)
        }
      } catch { /* file may have been deleted; keep the buffer */ }
    })()
  }, [tick, sessionId, path])

  // Only the active pane's editor takes the keyboard (a pane that moves remounts its editors).
  useEffect(() => {
    if (active && useUi.getState().selectedSessionId === sessionId) handle.current?.view.focus()
  }, [active, load.kind, sessionId])
  useEffect(() => { handle.current?.setFont(snap.settings.monoFont, snap.settings.monoFontSize) }, [snap.settings.monoFont, snap.settings.monoFontSize, load.kind])

  return (
    <div className="file-editor" style={{ display: active ? 'flex' : 'none' }} data-testid={`editor-${path}`}>
      <div className="editor-head">
        <span className="editor-path" title={path}>{path}</span>
        <button className="btn primary" data-testid="send-to-agent" disabled={load.kind !== 'text'}
          onClick={() => void sendToAgent()}>Send to agent</button>
      </div>
      {conflict && (
        <div className="banner warn editor-banner" role="alert" data-testid="changed-on-disk">
          <span>This file changed on disk.</span>
          <button className="btn" onClick={() => { setConflict(false); markDirty(false); void read() }}>Reload</button>
          <button className="btn" onClick={() => void save(true)}>Overwrite</button>
        </div>
      )}
      {load.kind === 'loading' && <div className="main-hint editor-msg">Loading…</div>}
      {load.kind === 'binary' && <div className="main-hint editor-msg">Binary file — not shown.</div>}
      {load.kind === 'too_large' && (
        <div className="main-hint editor-msg">File is too large to open here ({(load.size / (1024 * 1024)).toFixed(1)} MB).</div>
      )}
      {load.kind === 'error' && <div className="main-hint editor-msg" role="alert">{load.message}</div>}
      {load.kind === 'text' && <div className="editor-host" ref={host} />}
    </div>
  )

  async function sendToAgent(): Promise<void> {
    const sel = handle.current?.selectedLines()
    try {
      await window.pitwall.sendToAgent(sessionId, formatAgentReference(path, sel))
      requestFocus(sessionId, 'claude')
      useUi.getState().setActiveTab(sessionId, 'claude')
    } catch (e) {
      toast(`Could not send to the agent: ${cleanIpcError(e)}`)
    }
  }
}
