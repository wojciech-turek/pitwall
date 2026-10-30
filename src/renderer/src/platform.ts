/**
 * The OS the app runs on, from the preload (synchronous). Shortcut labels, pasted paths and the title bar differ on
 * Windows. Without a window (unit tests): macOS.
 */
export function platform(): string {
  return (globalThis as { window?: { pitwall?: { platform?: string } } }).window?.pitwall?.platform ?? 'darwin'
}

export const isMac = (p: string = platform()): boolean => p === 'darwin'

/** How the menu's modifier is written before a key: ⌘ on macOS, Ctrl+ elsewhere (the menu uses CmdOrCtrl). */
export const modKey = (p: string = platform()): string => (isMac(p) ? '⌘' : 'Ctrl+')

/** A shortcut's label: `shortcut('K')` is ⌘K on macOS, Ctrl+K on Windows. */
export const shortcut = (key: string, p: string = platform()): string => `${modKey(p)}${key}`

/** The menu's modifier is held: ⌘ on macOS, Ctrl elsewhere. */
export const modDown = (e: { metaKey: boolean; ctrlKey: boolean }, p: string = platform()): boolean => (isMac(p) ? e.metaKey : e.ctrlKey)
