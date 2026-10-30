// Characters a shell never splits or expands; anything else gets single quotes.
const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/

export function shellEscapePath(p: string): string {
  return SAFE.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`
}

/** Files dropped on a terminal: escaped absolute paths, space-separated, with a trailing space like Terminal.app. */
export function formatDroppedPaths(paths: string[]): string {
  return paths.map(shellEscapePath).join(' ') + ' '
}

function fileUrlPath(line: string): string | null {
  try {
    const u = new URL(line)
    return u.protocol === 'file:' ? decodeURIComponent(u.pathname) : null
  } catch {
    return null
  }
}

/**
 * What a drop on a terminal pastes: real files' paths (Finder, screenshots), else file links (a drag from
 * Cursor's file list), else dragged text as-is, like Terminal.app.
 */
export function dropText(d: { filePaths: string[]; uriList: string; text: string }): string {
  let paths = d.filePaths.filter(Boolean)
  if (paths.length === 0) {
    paths = d.uriList.split(/\r?\n/).map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map(fileUrlPath)
      .filter((p): p is string => !!p)
  }
  return paths.length ? formatDroppedPaths(paths) : d.text
}
