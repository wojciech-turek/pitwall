import { platform as currentPlatform } from '../platform'

/** Structural subset of KeyboardEvent so this module type-checks without the DOM lib. */
export interface KeyLike { metaKey: boolean; key: string; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }

/**
 * True for key events the app should handle instead of the terminal.
 * macOS: every ⌘ combo except copy, paste and select-all, so ⌘K (palette), ⌘P (go to file), ⌘J and ⌘1…⌘9 work while a
 * terminal has focus.
 * Windows: the menu's Ctrl shortcuts never get here (the main process takes them first). What remains is the
 * clipboard, as in Windows Terminal: Ctrl+V pastes (as a paste, bracketed if the program asked), Ctrl+C copies when
 * text is selected and is the interrupt otherwise; Ctrl+Shift+C / Ctrl+Shift+V always copy / paste.
 */
export function shouldPassToApp(e: KeyLike, o: { platform?: string; hasSelection?: boolean } = {}): boolean {
  if ((o.platform ?? currentPlatform()) === 'darwin') {
    if (!e.metaKey) return false
    return !['c', 'v', 'a'].includes(e.key.toLowerCase())
  }
  if (!e.ctrlKey || e.altKey || e.metaKey) return false
  const k = e.key.toLowerCase()
  if (k === 'v') return true
  if (k === 'c') return !!e.shiftKey || !!o.hasSelection
  return false
}
