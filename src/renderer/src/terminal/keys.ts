/**
 * True for key events the app (menu accelerators) should handle instead of the
 * terminal: every ⌘ combo except copy, paste and select-all.
 */
/** Structural subset of KeyboardEvent so this module type-checks without the DOM lib. */
export interface KeyLike { metaKey: boolean; key: string }

export function shouldPassToApp(e: KeyLike): boolean {
  if (!e.metaKey) return false
  return !['c', 'v', 'a'].includes(e.key.toLowerCase())
}
