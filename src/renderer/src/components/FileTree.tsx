import { useMemo } from 'react'
import type { FileEntry } from '@shared/types'

interface Node { name: string; path: string; dir: boolean; status?: FileEntry['status']; children: Node[] }

function build(files: FileEntry[]): Node[] {
  const root: Node = { name: '', path: '', dir: true, children: [] }
  for (const f of files) {
    let cur = root
    const parts = f.path.split('/')
    parts.forEach((name, i) => {
      const path = parts.slice(0, i + 1).join('/')
      const last = i === parts.length - 1
      let next = cur.children.find((c) => c.name === name && c.dir === !last)
      if (!next) {
        next = { name, path, dir: !last, children: [], ...(last && f.status ? { status: f.status } : {}) }
        cur.children.push(next)
      }
      cur = next
    })
  }
  const sort = (n: Node): void => {
    n.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    n.children.forEach(sort)
  }
  sort(root)
  return root.children
}

const STATUS_COLOR: Record<NonNullable<FileEntry['status']>, string> = {
  M: 'var(--st-needs)', A: 'var(--st-unread)', '?': 'var(--st-unread)', D: 'var(--st-exited)'
}

/** Open state: explicit toggles win; otherwise only first-level directories are open. */
export const isOpen = (toggles: Record<string, boolean>, path: string): boolean =>
  toggles[path] ?? !path.includes('/')

export default function FileTree({ files, toggles, onToggle, onOpen, activePath }: {
  files: FileEntry[]; toggles: Record<string, boolean>
  onToggle(path: string, open: boolean): void; onOpen(path: string): void; activePath?: string
}): React.JSX.Element {
  const tree = useMemo(() => build(files), [files])
  const rows: React.JSX.Element[] = []
  const emit = (nodes: Node[], depth: number): void => {
    for (const n of nodes) {
      const pad = { paddingLeft: 8 + depth * 14 }
      if (n.dir) {
        const open = isOpen(toggles, n.path)
        rows.push(
          <div key={`d:${n.path}`} className="ft-row ft-dir" style={pad} data-testid={`dir-${n.path}`}
            onClick={() => onToggle(n.path, !open)}>
            <span className="ft-caret">{open ? '▾' : '▸'}</span>
            <span className="ft-name">{n.name}</span>
          </div>
        )
        if (open) emit(n.children, depth + 1)
      } else {
        rows.push(
          <div key={`f:${n.path}`} className={`ft-row${activePath === n.path ? ' active' : ''}`} style={pad}
            data-testid={`file-${n.path}`} title={n.path} onClick={() => onOpen(n.path)}>
            <span className="ft-caret" />
            <span className="ft-name" style={n.status === 'D' ? { textDecoration: 'line-through', opacity: 0.7 } : undefined}>{n.name}</span>
            {n.status && <span className="ft-status" style={{ color: STATUS_COLOR[n.status] }}>{n.status}</span>}
          </div>
        )
      }
    }
  }
  emit(tree, 0)
  return <div className="file-tree" role="tree">{rows}</div>
}
