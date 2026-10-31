/** What it takes to tell whether the user is looking at a window (a BrowserWindow has all three). */
export interface WindowState {
  isFocused(): boolean
  isMinimized(): boolean
  isVisible(): boolean
}

/**
 * The user is looking at the window: focused, and neither minimized nor hidden. Focus alone isn't enough: on Windows,
 * Electron can call a window focused while it is minimized (minimizing doesn't always deactivate it), so a session
 * that finished then would be marked read, with no notification and no badge.
 */
export function isViewing(w: WindowState | null | undefined): boolean {
  return !!w && w.isFocused() && !w.isMinimized() && w.isVisible()
}

export type ViewingEvent = 'focus' | 'blur' | 'minimize' | 'hide' | 'restore' | 'show'

/** Whether the window counts as viewed after one of its events. */
export function viewingAfter(event: ViewingEvent, w: WindowState): boolean {
  switch (event) {
    case 'blur':
    case 'minimize':
    case 'hide':
      return false
    case 'focus':
      return !w.isMinimized() && w.isVisible()
    case 'restore':
    case 'show':
      return isViewing(w)
  }
}
