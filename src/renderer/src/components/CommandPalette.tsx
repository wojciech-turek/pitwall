import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { EditorView } from '@codemirror/view'
import type { AppSnapshot, FileEntry, HistoryHit } from '@shared/types'
import {
  MIN_HISTORY_QUERY, paletteActions, paletteResults, type PaletteAction, type PaletteItem, type PaletteMode
} from '../state/palette'
import { panes } from '../state/layout'
import { useUi } from '../state/ui'
import { useToast } from '../state/toast'
import { cleanIpcError } from '../state/errors'
import { useAppInfo } from '../state/appInfo'
import { checkForUpdatesNow } from '../state/updates'
import { goToNextAttention } from '../state/menuCommands'
import { focusActivePane } from './PaneLayout'
import { openInCursor } from './SessionHeader'
import StatusDot from './StatusDot'
import { ChevronIcon, FileIcon, HistoryIcon } from './Icons'

const SEARCH_DELAY_MS = 150

/** Gives the keyboard back to what had it before the palette opened (a terminal, the editor, an input). */
function restoreFocus(el: Element | null): void {
  if (!(el instanceof HTMLElement) || !el.isConnected || el === document.body) {
    focusActivePane()
    return
  }
  // CodeMirror puts its own selection back only when focused through the view.
  const cm = el.closest<HTMLElement>('.cm-editor')
  const view = cm ? EditorView.findFromDOM(cm) : null
  if (view) view.focus()
  else el.focus()
}

/** Opens a session in the active pane, or split to its right (⌘Enter; the active pane when there's no room). */
function openSession(id: string, split: boolean): void {
  const ui = useUi.getState()
  const active = ui.layout.activePaneId
  if (!split || !active) { ui.select(id); return }
  ui.dropSession(id, active, 'right')
  window.pitwall.sessionOpened(id)
}

function Highlight({ text, hits }: { text: string; hits?: number[] }): React.JSX.Element {
  if (!hits?.length) return <>{text}</>
  const on = new Set(hits)
  const parts: React.ReactNode[] = []
  for (let i = 0; i < text.length;) {
    let j = i
    while (j < text.length && on.has(j) === on.has(i)) j++
    parts.push(on.has(i) ? <mark key={i}>{text.slice(i, j)}</mark> : text.slice(i, j))
    i = j
  }
  return <>{parts}</>
}

/** ⌘K: sessions, actions, files of the active session and past sessions. ⌘P: files only. */
export default function CommandPalette({ snap, mode }: { snap: AppSnapshot; mode: PaletteMode }): React.JSX.Element {
  const activeSessionId = useUi((s) => s.selectedSessionId)
  const paneCount = useUi((s) => panes(s.layout).length)
  const rightTab = useUi((s) => s.rightTab)
  const info = useAppInfo()
  const [query, setQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [files, setFiles] = useState<{ sessionId: string; files: FileEntry[] } | null>(null)
  const [history, setHistory] = useState<HistoryHit[] | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const restoreTo = useRef<Element | null>(null)
  const restoreOnClose = useRef(true)
  const q = query.trim()

  // Remember where the keyboard was, and give it back when the palette closes (Esc, a click outside, ⌘K again).
  useLayoutEffect(() => {
    restoreTo.current = document.activeElement
    input.current?.focus()
    return () => { if (restoreOnClose.current) restoreFocus(restoreTo.current) }
  }, [])

  // ⌘P while ⌘K is open (or the other way round) starts over in the other mode.
  useEffect(() => {
    setQuery('')
    setSelectedKey(null)
    input.current?.focus()
  }, [mode])

  useEffect(() => {
    if (!activeSessionId) return
    let live = true
    window.pitwall.listFiles(activeSessionId).then(
      (r) => { if (live) setFiles({ sessionId: activeSessionId, files: r.files }) },
      () => { if (live) setFiles({ sessionId: activeSessionId, files: [] }) }
    )
    return () => { live = false }
  }, [activeSessionId])

  // Start reading transcripts now, so the first search is quick.
  useEffect(() => { void window.pitwall.searchSessions('').catch(() => {}) }, [])
  useEffect(() => {
    if (mode !== 'commands' || q.length < MIN_HISTORY_QUERY) {
      setHistory(null)
      return
    }
    let live = true
    const timer = setTimeout(() => {
      window.pitwall.searchSessions(q)
        .then((h) => { if (live) setHistory(h) })
        .catch(() => { if (live) setHistory([]) })
    }, SEARCH_DELAY_MS)
    return () => { live = false; clearTimeout(timer) }
  }, [q, mode])

  const actions = useMemo(() => paletteActions({
    snap, activeSessionId, paneCount, rightTab, canCheckUpdates: !!info?.updateFeed
  }), [snap, activeSessionId, paneCount, rightTab, info])
  const sessionFiles = files && files.sessionId === activeSessionId ? files.files : null
  const groups = useMemo(() => paletteResults({
    mode, query, snap, activeSessionId, actions, files: sessionFiles, history
  }), [mode, query, snap, activeSessionId, actions, sessionFiles, history])
  const flat = groups.flatMap((g) => g.items)
  const index = Math.max(0, flat.findIndex((i) => i.key === selectedKey))
  const current = flat[index] as PaletteItem | undefined

  useEffect(() => {
    list.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index, current?.key])

  /** Closes the palette; `restore` gives the keyboard back to where it was. */
  const close = (restore = true): void => {
    restoreOnClose.current = restore
    useUi.getState().closePalette()
  }
  /** Closes, does something that moves the view, then puts the keyboard in the active pane. */
  const thenFocusPane = (fn: () => void): void => {
    close(false)
    fn()
    setTimeout(focusActivePane, 0)
  }
  const toastError = (e: unknown): void => useToast.getState().show(cleanIpcError(e))

  const runAction = (a: PaletteAction): void => {
    const ui = useUi.getState()
    switch (a.id) {
      case 'new-session': close(); if (a.subProjectId) ui.openDialog({ type: 'new-session', subProjectId: a.subProjectId }); return
      case 'archive': close(); if (a.sessionId) ui.openDialog({ type: 'archive', sessionId: a.sessionId }); return
      case 'settings': close(); ui.openDialog({ type: 'settings' }); return
      case 'mark-unread': close(); if (a.sessionId) window.pitwall.markSessionUnread(a.sessionId).catch(toastError); return
      case 'mute': case 'unmute':
        close()
        if (a.projectId) window.pitwall.setProjectMuted(a.projectId, a.id === 'mute').catch(toastError)
        return
      case 'open-in-cursor': close(); if (a.sessionId) void openInCursor(a.sessionId); return
      case 'show-files': close(); ui.setRightTab('files'); return
      case 'show-changes': close(); ui.setRightTab('changes'); return
      case 'close-pane': thenFocusPane(() => { if (ui.layout.activePaneId) ui.closePane(ui.layout.activePaneId) }); return
      case 'next-attention': thenFocusPane(() => goToNextAttention(snap)); return
      case 'archived':
        close(false)
        ui.setArchivedOpen(true)
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-testid="archived-search"]')?.focus())
        return
      case 'check-updates': {
        close()
        const toast = useToast.getState().show
        toast('Checking for updates…')
        void checkForUpdatesNow(info).then(toast)
        return
      }
    }
  }

  const run = (item: PaletteItem | undefined, split: boolean): void => {
    if (!item) return
    switch (item.kind) {
      case 'session': thenFocusPane(() => openSession(item.session.id, split)); return
      case 'history': {
        const id = item.hit.sessionId
        if (snap.sessions.some((s) => s.id === id)) thenFocusPane(() => openSession(id, split))
        else if (snap.archived.some((s) => s.id === id)) { close(); useUi.getState().openDialog({ type: 'resume', sessionId: id }) }
        return
      }
      case 'file': {
        const sessionId = activeSessionId
        if (sessionId) thenFocusPane(() => useUi.getState().openTab(sessionId, { id: `file:${item.path}`, kind: 'file', path: item.path }))
        return
      }
      case 'action': runAction(item.action)
    }
  }

  const move = (by: number): void => {
    if (flat.length) setSelectedKey(flat[(index + by + flat.length) % flat.length].key)
  }
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const ctrl = e.ctrlKey && !e.metaKey && !e.altKey
    if (e.key === 'ArrowDown' || (ctrl && e.key === 'n')) { e.preventDefault(); move(1) }
    else if (e.key === 'ArrowUp' || (ctrl && e.key === 'p')) { e.preventDefault(); move(-1) }
    else if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); run(current, e.metaKey) }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
    else if (e.key === 'Tab') e.preventDefault()
  }

  const activeSession = snap.sessions.find((s) => s.id === activeSessionId)
  const canSplit = current?.kind === 'session' || (current?.kind === 'history' && snap.sessions.some((s) => s.id === current.hit.sessionId))
  let empty = 'No matches'
  if (mode === 'files' && !activeSession) empty = 'Select a session to search its files.'
  else if (mode === 'files' && !sessionFiles) empty = 'Loading files…'

  let row = -1
  return (
    <div className="palette-backdrop" onMouseDown={(e) => {
      if (e.target !== e.currentTarget) return
      e.preventDefault() // the click mustn't move the keyboard after it's given back
      close()
    }}>
      <div className="palette" role="dialog" aria-label={mode === 'files' ? 'Go to file' : 'Command palette'}
        data-testid="command-palette" data-mode={mode} onKeyDown={onKeyDown}>
        <input ref={input} className="palette-input" data-testid="palette-input" value={query} spellCheck={false}
          autoComplete="off" role="combobox" aria-expanded="true" aria-controls="palette-list"
          aria-activedescendant={current ? `palette-${index}` : undefined}
          placeholder={mode === 'files'
            ? activeSession ? `Go to file in ${activeSession.title}` : 'Go to file'
            : 'Search sessions, files, past conversations and actions'}
          onChange={(e) => { setQuery(e.target.value); setSelectedKey(null) }} />
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {groups.map((g) => (
            <div key={g.kind} role="group" aria-label={g.title}>
              {mode === 'commands' && <div className="palette-group">{g.title}</div>}
              {g.items.map((item) => {
                const i = ++row
                return (
                  <div key={item.key} id={`palette-${i}`} role="option" aria-selected={i === index}
                    className={`palette-item${i === index ? ' selected' : ''}`} data-testid="palette-item" data-kind={item.kind}
                    data-selected={i === index}
                    data-session-id={item.kind === 'session' ? item.session.id : item.kind === 'history' ? item.hit.sessionId : undefined}
                    data-path={item.kind === 'file' ? item.path : undefined}
                    data-action={item.kind === 'action' ? item.action.id : undefined}
                    onMouseMove={() => { if (i !== index) setSelectedKey(item.key) }}
                    onMouseDown={(e) => e.preventDefault() /* keep the keyboard in the input */}
                    onClick={(e) => run(item, e.metaKey)}>
                    <ItemBody item={item} />
                  </div>
                )
              })}
            </div>
          ))}
          {flat.length === 0 && <div className="palette-empty">{empty}</div>}
        </div>
        <div className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> open</span>
          {canSplit && <span><kbd>⌘↵</kbd> split right</span>}
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}

function ItemBody({ item }: { item: PaletteItem }): React.JSX.Element {
  switch (item.kind) {
    case 'session':
      return (
        <>
          <span className="palette-icon"><span className="header-dot"><StatusDot status={item.session.status} /></span></span>
          <span className="palette-label"><Highlight text={item.label} hits={item.labelHits} /></span>
          <span className="palette-detail">{item.detail}</span>
        </>
      )
    case 'action':
      return (
        <>
          <span className="palette-icon"><ChevronIcon /></span>
          <span className="palette-label"><Highlight text={item.label} hits={item.labelHits} /></span>
          {item.detail && <span className="palette-detail">{item.detail}</span>}
          {item.action.shortcut && <kbd className="palette-kbd">{item.action.shortcut}</kbd>}
        </>
      )
    case 'file':
      return (
        <>
          <span className="palette-icon"><FileIcon /></span>
          <span className="palette-label"><Highlight text={item.label} hits={item.labelHits} /></span>
          <span className="palette-detail palette-path"><Highlight text={item.detail ?? ''} hits={item.detailHits} /></span>
        </>
      )
    case 'history':
      return (
        <>
          <span className="palette-icon"><HistoryIcon /></span>
          <span className="palette-stack">
            <span className="palette-line">
              <span className="palette-label"><Highlight text={item.label} hits={item.labelHits} /></span>
              {item.hit.archived && <span className="tag">archived</span>}
              <span className="palette-detail">{item.detail}</span>
            </span>
            {item.hit.matchedIn === 'conversation' && item.hit.snippet && (
              <span className="palette-snippet" data-testid="palette-snippet">{item.hit.snippet}</span>
            )}
          </span>
        </>
      )
  }
}
