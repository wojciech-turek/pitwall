import { platform as currentPlatform } from '../platform'

// Characters a shell never splits or expands; anything else gets single quotes.
const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/
// Windows, into Claude's prompt: the same, with backslashes. Anything else gets double quotes, which Claude reads as
// one path (a Windows path can't contain a double quote).
const SAFE_WINDOWS = /^[A-Za-z0-9_@%+=:,./\\-]+$/
// Windows, into the Shell tab (PowerShell): fewer characters stay bare (a comma makes a list, @ splats). Anything else
// gets single quotes, where nothing expands; a quote inside (PowerShell counts ‘ ’ ‚ ‛ as quotes too) is doubled.
const SAFE_POWERSHELL = /^[A-Za-z0-9_.:/\\-]+$/

/** `target`: where the text goes; on Windows Claude's prompt (the default) and PowerShell quote differently. */
export function shellEscapePath(p: string, platform: string = currentPlatform(), target: 'claude' | 'shell' = 'claude'): string {
  if (platform === 'win32' && target === 'shell') return SAFE_POWERSHELL.test(p) ? p : `'${p.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`
  if (platform === 'win32') return SAFE_WINDOWS.test(p) ? p : `"${p}"`
  return SAFE.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`
}

/** Files dropped on a terminal: escaped absolute paths, space-separated, with a trailing space like Terminal.app. */
export function formatDroppedPaths(paths: string[], platform: string = currentPlatform(), target: 'claude' | 'shell' = 'claude'): string {
  return paths.map((p) => shellEscapePath(p, platform, target)).join(' ') + ' '
}

/** A file: link's path; on Windows as Windows writes it (`file:///C:/a%20b` → `C:\a b`, `file://host/share` → UNC). */
function fileUrlPath(line: string, platform: string): string | null {
  try {
    const u = new URL(line)
    if (u.protocol !== 'file:') return null
    const path = decodeURIComponent(u.pathname)
    if (platform !== 'win32') return path
    if (u.hostname) return `\\\\${u.hostname}${path.replace(/\//g, '\\')}`
    return path.replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\')
  } catch {
    return null
  }
}

/**
 * What a drop on a terminal pastes: real files' paths (Finder, Explorer, screenshots), else file links (a drag from
 * Cursor's file list), else dragged text as-is, like Terminal.app.
 */
export function dropText(
  d: { filePaths: string[]; uriList: string; text: string }, platform: string = currentPlatform(), target: 'claude' | 'shell' = 'claude'
): string {
  let paths = d.filePaths.filter(Boolean)
  if (paths.length === 0) {
    paths = d.uriList.split(/\r?\n/).map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => fileUrlPath(l, platform))
      .filter((p): p is string => !!p)
  }
  return paths.length ? formatDroppedPaths(paths, platform, target) : d.text
}
