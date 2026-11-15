import { useEffect, useState } from 'react'
import type { StrayWorktree } from '@shared/types'
import Dialog from './Dialog'
import { relativeTime } from '../HoverCard'
import { useSnapshot } from '../../state/snapshot'
import { useUi } from '../../state/ui'
import { useToast } from '../../state/toast'
import { cleanIpcError } from '../../state/errors'
import { baseName, blockedReason, formatBytes, removable, removeLabel, removeSummary } from '../../state/strays'

const SIZE_AT_A_TIME = 2

/**
 * A repo folder's worktrees no session owns (agents made them with `git worktree add`). Merged, clean, idle ones are
 * picked at first; one with changes, one in use and one not merged can't be picked.
 */
export default function StrayWorktreesDialog({ subProjectId }: { subProjectId: string }): React.JSX.Element {
  const close = useUi((s) => s.closeDialog)
  const toast = useToast((s) => s.show)
  const snap = useSnapshot()
  const name = snap?.subProjects.find((s) => s.id === subProjectId)?.name ?? ''
  const [list, setList] = useState<StrayWorktree[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  // path -> bytes; null: couldn't be measured; absent: not measured yet
  const [sizes, setSizes] = useState<Record<string, number | null>>({})
  const [deleteBranches, setDeleteBranches] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    window.pitwall.listStrayWorktrees(subProjectId).then(
      (l) => {
        if (!live) return
        setList(l)
        setPicked(new Set(l.filter(removable).map((w) => w.path)))
      },
      (e) => { if (live) setError(cleanIpcError(e)) }
    )
    return () => { live = false }
  }, [subProjectId])

  // Sizes load in the background, two `du` at a time; the dialog is usable meanwhile.
  useEffect(() => {
    if (!list) return
    let live = true
    let next = 0
    const worker = async (): Promise<void> => {
      while (live && next < list.length) {
        const path = list[next++].path
        const size = await window.pitwall.worktreeSize(subProjectId, path).catch(() => null)
        if (live) setSizes((cur) => ({ ...cur, [path]: size }))
      }
    }
    for (let i = 0; i < SIZE_AT_A_TIME; i++) void worker()
    return () => { live = false }
  }, [list, subProjectId])

  const toggle = (path: string): void =>
    setPicked((cur) => {
      const next = new Set(cur)
      if (!next.delete(path)) next.add(path)
      return next
    })

  const paths = (list ?? []).filter((w) => picked.has(w.path) && removable(w)).map((w) => w.path)

  const remove = async (): Promise<void> => {
    setBusy(true)
    try {
      const results = await window.pitwall.removeStrayWorktrees(subProjectId, paths, deleteBranches)
      toast(removeSummary(results))
      close()
    } catch (e) {
      setError(cleanIpcError(e))
      setBusy(false)
    }
  }

  return (
    <Dialog title={`Clean up worktrees${name ? ` · ${name}` : ''}`} testId="stray-dialog" onClose={close} width={620}>
      <p className="muted-text help">
        Worktrees agents made themselves with <code>git worktree add</code>, outside Pitwall. Ones with uncommitted
        changes, ones something is running in and ones not merged are never removed. Removing a worktree also deletes
        its ignored files, such as .env files, local databases and build output.
      </p>
      {error && <div className="banner error" data-testid="stray-error">{error}</div>}
      {!list && !error && <p className="muted-text">Looking…</p>}
      {list && list.length === 0 && <p className="muted-text" data-testid="stray-empty">No stray worktrees.</p>}
      {list && list.length > 0 && (
        <div className="stray-list">
          {list.map((w) => {
            const reason = blockedReason(w)
            const size = sizes[w.path]
            return (
              <label key={w.path} className={`stray-row${removable(w) ? '' : ' blocked'}`} data-testid="stray-row" title={w.path}>
                <input type="checkbox" data-testid="stray-check" disabled={!removable(w) || busy}
                  checked={picked.has(w.path) && removable(w)} onChange={() => toggle(w.path)} />
                <span className="stray-name">{baseName(w.path)}</span>
                <span className="stray-branch">{w.branch ?? 'detached'}</span>
                <span className="stray-flags">
                  {reason ?? 'merged'}
                </span>
                <span className="stray-age">{w.lastCommitAt ? relativeTime(w.lastCommitAt) : ''}</span>
                <span className="stray-size">{size === undefined ? '…' : size === null ? '' : formatBytes(size)}</span>
              </label>
            )
          })}
        </div>
      )}
      {list && list.length > 0 && (
        <label className="check-row stray-branches">
          <input type="checkbox" data-testid="stray-delete-branches" checked={deleteBranches} disabled={busy}
            onChange={(e) => setDeleteBranches(e.target.checked)} />
          Also delete their merged branches
        </label>
      )}
      <div className="dialog-actions">
        <button className="btn" onClick={close}>Close</button>
        {list && list.length > 0 && (
          <button className="btn danger" data-testid="stray-remove" disabled={paths.length === 0 || busy} onClick={() => void remove()}>
            {removeLabel(paths.length, paths.map((p) => sizes[p]))}
          </button>
        )}
      </div>
    </Dialog>
  )
}
