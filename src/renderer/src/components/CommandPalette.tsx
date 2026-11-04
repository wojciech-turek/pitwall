import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { modDown, shortcut } from '../platform'
import { focusActivePane } from './PaneLayout'
import { openInCursor } from './SessionHeader'
import StatusIcon from './StatusIcon'
import { ChevronIcon, FileIcon, HistoryIcon } from './Icons'

const SEARCH_DELAY_MS = 150
const NO_SNAP: AppSnapshot = {
  projects: [], subProjects: [], sessions: [], archived: [], settings: { monoFont: '', monoFontSize: 13, checkForUpdates: false }
}
const NO_ACTIONS: PaletteAction[] = []
const MAX_FILES_NOTE = 'Showing the first 20,000 files.'

/**
 * Gives the keyboard back to what had it before the palette opened (a terminal, the editor, an input), unless
 * another pane became the active one meanwhile (a notification click): then to the active pane.
 */
function restoreFocus(el: Element | null): void {
  const pane = el?.closest('.pane[data-pane-id]')
  const movedAway = pane && pane.getAttribute('data-pane-id') !== useUi.getState().layout.activePaneId
  if (!(el instanceof HTMLElement) || !el.isConnected || el === document.body || movedAway) {
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
  const [files, setFiles] = useState<{ sessionId: string; files: FileEntry[]; truncated: boolean } | null>(null)
  const [history, setHistory] = useState<{ query: string; hits: HistoryHit[] } | null>(null)
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
      (r) => { if (live) setFiles({ sessionId: activeSessionId, files: r.files, truncated: r.truncated }) },
      () => { if (live) setFiles({ sessionId: activeSessionId, files: [], truncated: false }) }
    )
    return () => { live = false }
  }, [activeSessionId])

  // Start reading transcripts once a search for past sessions begins, ahead of its debounced query. Not on open:
  // indexing every transcript then made terminals stutter for a palette mostly used to switch sessions.
  const warmed = useRef(false)
  useEffect(() => {
    if (warmed.current || mode !== 'commands' || q.length < MIN_HISTORY_QUERY) return
    warmed.current = true
    void window.pitwall.searchSessions('').catch(() => {})
  }, [q, mode])
  useEffect(() => {
    if (mode !== 'commands' || q.length < MIN_HISTORY_QUERY) {
      setHistory(null)
      return
    }
    let live = true
    const timer = setTimeout(() => {
      window.pitwall.searchSessions(q)
        .then((hits) => { if (live) setHistory({ query: q, hits }) })
        .catch(() => { if (live) setHistory({ query: q, hits: [] }) })
    }, SEARCH_DELAY_MS)
    return () => { live = false; clearTimeout(timer) }
  }, [q, mode])

  const actions = useMemo(() => paletteActions({
    snap, activeSessionId, paneCount, rightTab, canCheckUpdates: !!info?.updateFeed
  }), [snap, activeSessionId, paneCount, rightTab, info])
  const mine = files && files.sessionId === activeSessionId ? files : null
  const sessionFiles = mine?.files ?? null
  // Ranking a big repo's files takes tens of ms: typing stays smooth while it catches up, and in ⌘P mode
  // snapshot pushes (status changes) don't re-rank at all.
  const deferredQuery = useDeferredValue(query)
  const commands = mode === 'commands'
  const rankSnap = commands ? snap : NO_SNAP
  const rankActions = commands ? actions : NO_ACTIONS
  const rankHistory = commands ? history : null
  const resultsFor = (text: string): ReturnType<typeof paletteResults> => paletteResults({
    mode, query: text, snap: rankSnap, activeSessionId, actions: rankActions, files: sessionFiles, history: rankHistory
  })
  const groups = useMemo(() => paletteResults({
    mode, query: deferredQuery, snap: rankSnap, activeSessionId, actions: rankActions, files: sessionFiles, history: rankHistory
  }), [mode, deferredQuery, rankSnap, activeSessionId, rankActions, sessionFiles, rankHistory])
  const flat = groups.flatMap((g) => g.items)
  const index = Math.max(0, flat.findIndex((i) => i.key === selectedKey))
  const current = flat[index] as PaletteItem | undefined
  /** What Enter opens: the selection, or, when the list hasn't caught up with the typing yet, the top result now. */
  const enterTarget = (): PaletteItem | undefined =>
    deferredQuery === query ? current : resultsFor(query)[0]?.items[0]

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
    // Ctrl+N/P move here; they never reach the app's own shortcuts (new session, go to file on Windows).
    if (e.key === 'ArrowDown' || (ctrl && e.key === 'n')) { e.preventDefault(); e.stopPropagation(); move(1) }
    else if (e.key === 'ArrowUp' || (ctrl && e.key === 'p')) { e.preventDefault(); e.stopPropagation(); move(-1) }
    else if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); run(enterTarget(), modDown(e)) }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
    else if (e.key === 'Tab') e.preventDefault()
  }

  const activeSession = snap.sessions.find((s) => s.id === activeSessionId)
  const canSplit = current?.kind === 'session' || (current?.kind === 'history' && snap.sessions.some((s) => s.id === current.hit.sessionId))
  let empty = 'No matches'
  if (mode === 'files' && !activeSession) empty = 'Select a session to search its files.'
  else if (mode === 'files' && !sessionFiles) empty = 'Loading files…'
  else if (deferredQuery !== query) empty = 'Searching…'

  let row = -1
  return (
    <div className="palette-backdrop" onMouseDown={(e) => {
      if (e.target !== e.currentTarget) return
      e.preventDefault() // the click mustn't move the keyboard after it's given back
      close()
    }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={mode === 'files' ? 'Go to file' : 'Command palette'}
        data-testid="command-palette" data-mode={mode} onKeyDown={onKeyDown}
        // a click on a heading, the footer or a hint must not take the keyboard from the input
        onMouseDown={(e) => { if (e.target !== input.current) e.preventDefault() }}>
        <input ref={input} className="palette-input" data-testid="palette-input" value={query} spellCheck={false}
          autoComplete="off" role="combobox" aria-expanded="true" aria-controls="palette-list"
          aria-activedescendant={current ? `palette-${index}` : undefined}
          placeholder={mode === 'files'
            ? activeSession ? `Go to file in ${activeSession.title}` : 'Go to file'
            : 'Search sessions, files, past conversations and actions'}
          onChange={(e) => { setQuery(e.target.value); setSelectedKey(null) }} />
        {mode === 'files' && mine?.truncated && <div className="palette-note" data-testid="palette-truncated">{MAX_FILES_NOTE}</div>}
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
                    onClick={(e) => run(item, modDown(e))}>
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
          {canSplit && <span><kbd>{shortcut('↵')}</kbd> split right</span>}
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
          <span className="palette-icon"><StatusIcon status={item.session.status} exitCode={item.session.exitCode} /></span>
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
