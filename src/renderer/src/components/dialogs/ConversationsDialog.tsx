import { useEffect, useRef, useState } from 'react'
import type { ConversationItem, ConversationList, StartResult, StartStep } from '@shared/types'
import Dialog from './Dialog'
import StartProgressList, { type StepInfo } from '../StartProgressList'
import { relativeTime } from '../HoverCard'
import { useUi } from '../../state/ui'
import { refreshSnapshot, useSnapshot } from '../../state/snapshot'
import { cleanIpcError } from '../../state/errors'
import { activeMinutesAgo, conversationRows, MIN_TEXT_SEARCH, type ConversationSearch } from '../../state/conversations'
import { requestFocus } from '../../terminal/termCache'

const SEARCH_DELAY_MS = 200

type Phase = 'list' | 'starting' | 'failed'

/**
 * A folder's past conversations, newest first: its archived sessions (picking one opens the Resume dialog) and the
 * ones run with plain `claude` outside Pitwall (picking one continues it in a new session, with the same progress as
 * starting one).
 */
export default function ConversationsDialog({ subProjectId }: { subProjectId: string }): React.JSX.Element {
  const close = useUi((s) => s.closeDialog)
  const snap = useSnapshot()
  const sub = snap?.subProjects.find((s) => s.id === subProjectId)
  const name = sub?.name ?? ''
  const [list, setList] = useState<ConversationList | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<ConversationSearch | null>(null)
  const [selected, setSelected] = useState(0)
  // An outside conversation used minutes ago, waiting for "Continue anyway".
  const [confirm, setConfirm] = useState<ConversationItem | null>(null)
  const [phase, setPhase] = useState<Phase>('list')
  const [picked, setPicked] = useState<ConversationItem | null>(null)
  const [steps, setSteps] = useState<Partial<Record<StartStep, StepInfo>>>({})
  const requestId = useRef('')
  const input = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const q = query.trim()

  useEffect(() => {
    let live = true
    window.pitwall.listConversations(subProjectId)
      .then((l) => { if (live) setList(l) })
      .catch((e) => { if (live) setLoadError(cleanIpcError(e)) })
    return () => { live = false }
  }, [subProjectId])

  useEffect(() => {
    if (q.length < MIN_TEXT_SEARCH) return
    let live = true
    const timer = setTimeout(() => {
      window.pitwall.searchConversations(subProjectId, q)
        .then((matches) => { if (live) setSearch({ query: q, matches }) })
        .catch(() => { if (live) setSearch({ query: q, matches: [] }) })
    }, SEARCH_DELAY_MS)
    return () => { live = false; clearTimeout(timer) }
  }, [subProjectId, q])

  useEffect(() => window.pitwall.onStartProgress((p) => {
    if (p.requestId !== requestId.current) return
    setSteps((cur) => ({ ...cur, [p.step]: { state: p.state, message: p.message } }))
  }), [])

  const rows = list ? conversationRows(list.items, query, search) : []
  const index = Math.min(selected, Math.max(0, rows.length - 1))

  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const start = async (item: ConversationItem): Promise<void> => {
    requestId.current = crypto.randomUUID()
    setConfirm(null)
    setPicked(item)
    setSteps({})
    setPhase('starting')
    let res: StartResult
    try {
      res = await window.pitwall.continueConversation(subProjectId, item.id, requestId.current)
    } catch (e) {
      res = { ok: false, step: 'identity', error: cleanIpcError(e) }
    }
    if (!res.ok) {
      setSteps((cur) => ({ ...cur, [res.step]: { state: 'failed', message: res.error } }))
      setPhase('failed')
      return
    }
    // The reply can beat the debounced snapshot push; make sure the session exists before selecting it.
    await refreshSnapshot().catch(() => {})
    requestFocus(res.sessionId, 'claude')
    const ui = useUi.getState()
    ui.select(res.sessionId)
    ui.setActiveTab(res.sessionId, 'claude')
    ui.closeDialog()
  }

  const pick = (item: ConversationItem | undefined): void => {
    if (!item) return
    if (item.kind === 'archived') useUi.getState().openDialog({ type: 'resume', sessionId: item.id })
    else if (item.recentlyActive) setConfirm(item)
    else void start(item)
  }

  const backToList = (): void => {
    setConfirm(null)
    requestAnimationFrame(() => input.current?.focus())
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (rows.length) setSelected((index + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length)
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      pick(rows[index]?.item)
    }
  }

  let empty: string | null = null
  if (!list) empty = loadError ? null : 'Looking for conversations…'
  else if (list.items.length === 0) empty = `No past conversations in ${name} yet.`
  else if (rows.length === 0) empty = q.length >= MIN_TEXT_SEARCH && search?.query !== q ? 'Searching…' : 'No matches'
  // A worktree starts from the branch's last commit; a folder without git is continued in place.
  const showNote = sub?.kind === 'repo' && !!list?.items.some((i) => i.kind === 'outside')
  const now = Date.now()

  return (
    <Dialog title={name ? `Continue a conversation · ${name}` : 'Continue a conversation'} testId="conversations-dialog"
      onClose={() => { if (phase !== 'starting') close() }} width={560}>
      {phase !== 'list' ? (
        <div className="form">
          <p className="muted-text">{picked?.title}</p>
          <StartProgressList steps={steps} folder={sub?.kind === 'folder'} />
          {phase === 'failed' && (
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={close}>Close</button>
              <button type="button" className="btn primary" data-testid="retry-continue"
                onClick={() => { if (picked) void start(picked) }}>Retry</button>
            </div>
          )}
        </div>
      ) : confirm ? (
        <div className="form">
          <p className="muted-text">{confirm.title}</p>
          <p className="conversations-warning" role="alert" data-testid="conversation-recent">
            {`This conversation was active ${activeMinutesAgo(confirm.updatedAt)} min ago and may still be open in a terminal. ` +
              'Continuing it in two places at once mixes them up.'}
          </p>
          <div className="dialog-actions">
            <button type="button" className="btn" autoFocus onClick={backToList}>Cancel</button>
            <button type="button" className="btn primary" data-testid="continue-anyway" onClick={() => void start(confirm)}>
              Continue anyway
            </button>
          </div>
        </div>
      ) : (
        <div className="conversations">
          <input ref={input} data-autofocus data-testid="conversations-search" placeholder="Search titles and conversations"
            value={query} spellCheck={false} autoComplete="off" role="combobox" aria-expanded="true"
            aria-controls="conversations-list" aria-activedescendant={rows.length ? `conversation-${index}` : undefined}
            onKeyDown={onKeyDown}
            onChange={(e) => { setQuery(e.target.value); setSelected(0) }} />
          <div className="conversations-list" id="conversations-list" role="listbox" aria-label="Conversations" ref={listRef}>
            {rows.map(({ item, snippet }, i) => (
              <div key={`${item.kind}:${item.id}`} id={`conversation-${i}`} className={`conversation-row${i === index ? ' selected' : ''}`}
                role="option" aria-selected={i === index} data-selected={i === index}
                data-testid="conversation-row" data-kind={item.kind} data-id={item.id} title={item.title}
                onMouseMove={() => { if (i !== index) setSelected(i) }} onClick={() => pick(item)}>
                <div className="conversation-head">
                  <span className="conversation-title">{item.title}</span>
                  {item.kind === 'outside' && <span className="tag">outside Pitwall</span>}
                </div>
                {snippet && <div className="conversation-snippet" data-testid="conversation-snippet">{snippet}</div>}
                <div className="conversation-meta">{[relativeTime(item.updatedAt, now), item.branch].filter(Boolean).join(' · ')}</div>
              </div>
            ))}
            {empty && <div className="conversations-empty">{empty}</div>}
            {loadError && <div className="form-error" role="alert">{loadError}</div>}
          </div>
          {list?.truncated && <p className="muted-text help">Showing the 200 most recent.</p>}
          {showNote && (
            <p className="conversations-note">
              {`A conversation from outside Pitwall continues in a new session on its own branch. Changes you haven't committed in ${name} stay there.`}
            </p>
          )}
        </div>
      )}
    </Dialog>
  )
}
