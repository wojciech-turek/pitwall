import type { MenuCommand } from '@shared/api'
import { platform as currentPlatform } from '../platform'

/** Structural subset of KeyboardEvent so this module type-checks without the DOM lib. */
export interface KeyLike {
  metaKey: boolean; key: string; code?: string; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean
}

// The menu's shortcuts by physical key, so they work on any keyboard layout. Never S: Ctrl+S is the editor's save.
const APP_KEYS: Record<string, MenuCommand> = {
  KeyK: { type: 'command-palette' }, KeyP: { type: 'quick-open' }, KeyN: { type: 'new-session' },
  KeyW: { type: 'close-tab' }, KeyJ: { type: 'next-attention' }, Comma: { type: 'settings' }
}

/**
 * Windows: the app's shortcut for a key press, or null. The menu doesn't register its Ctrl shortcuts there (they'd
 * take keys from programs and editors), so the renderer maps them itself: in a terminal Ctrl+Shift+<key> (plain
 * Ctrl+<key> goes to the program), elsewhere Ctrl+<key> (Shift allowed). Ctrl+Alt is AltGr on many layouts (Polish,
 * German): those keys type characters, never shortcuts. Elsewhere (macOS): null; the menu takes ⌘ shortcuts.
 */
export function appShortcutFor(e: KeyLike, o: { platform?: string; inTerminal: boolean }): MenuCommand | null {
  if ((o.platform ?? currentPlatform()) !== 'win32') return null
  if (!e.ctrlKey || e.altKey || e.metaKey) return null
  if (o.inTerminal && !e.shiftKey) return null
  const digit = /^Digit([1-9])$/.exec(e.code ?? '')
  if (digit) return { type: 'select-index', index: Number(digit[1]) - 1 }
  return APP_KEYS[e.code ?? ''] ?? null
}

/**
 * True for key events the app should handle instead of the terminal.
 * macOS: every ⌘ combo except copy, paste and select-all, so ⌘K (palette), ⌘P (go to file), ⌘J and ⌘1…⌘9 work while a
 * terminal has focus.
 * Windows: Ctrl+Shift+<the app's keys> (see appShortcutFor); plain Ctrl+<letter> stays with the program. And the
 * clipboard, as in Windows Terminal: Ctrl+V pastes (as a paste, bracketed if the program asked), Ctrl+C copies when
 * text is selected and is the interrupt otherwise; Ctrl+Shift+C / Ctrl+Shift+V always copy / paste.
 */
export function shouldPassToApp(e: KeyLike, o: { platform?: string; hasSelection?: boolean } = {}): boolean {
  const p = o.platform ?? currentPlatform()
  if (p === 'darwin') {
    if (!e.metaKey) return false
    return !['c', 'v', 'a'].includes(e.key.toLowerCase())
  }
  if (!e.ctrlKey || e.altKey || e.metaKey) return false
  if (appShortcutFor(e, { platform: p, inTerminal: true })) return true
  const k = e.key.toLowerCase()
  if (k === 'v') return true
  if (k === 'c') return !!e.shiftKey || !!o.hasSelection
  return false
}
