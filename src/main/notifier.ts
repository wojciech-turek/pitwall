import { app, nativeImage, Notification, type BrowserWindow } from 'electron'
import { badgeBitmap, badgeDescription } from './badge'
import { isViewing } from './viewing'

export interface Notifier {
  notify(n: { sessionId: string; title: string; body: string }): void
  setBadge(count: number): void
  /** A session started needing you (Windows flashes the taskbar button until the window is focused). */
  attention?(): void
}

/**
 * Notifications and the waiting count: the Dock badge on macOS, an overlay badge on the taskbar button on Windows
 * (which also flashes when a session needs you, unless `quiet`: tests). `disabled` (PITWALL_DISABLE_NOTIFICATIONS)
 * silences notifications only. `refresh()` puts the badge on a new window.
 */
export function electronNotifier(
  onClick: (sessionId: string) => void,
  disabled: boolean,
  o: { platform?: NodeJS.Platform; window?: () => BrowserWindow | null; quiet?: boolean } = {}
): Notifier & { refresh(): void } {
  const platform = o.platform ?? process.platform
  const window = (): BrowserWindow | null => {
    const w = o.window?.() ?? null
    return w && !w.isDestroyed() ? w : null
  }
  let count = 0
  const showBadge = (): void => {
    if (platform !== 'win32') {
      app.setBadgeCount(count)
      return
    }
    const w = window()
    if (!w) return // shown when the window comes (refresh)
    const bitmap = badgeBitmap(count)
    w.setOverlayIcon(
      bitmap ? nativeImage.createFromBitmap(bitmap.data, { width: bitmap.width, height: bitmap.height, scaleFactor: 2 }) : null,
      bitmap ? badgeDescription(count) : ''
    )
  }
  // Electron may garbage-collect a Notification before the user clicks it; hold it until it is done.
  const live = new Set<Notification>()
  return {
    notify({ sessionId, title, body }) {
      if (disabled || !Notification.isSupported()) return
      const n = new Notification({ title, body })
      live.add(n)
      const release = () => { live.delete(n) }
      n.on('click', () => { release(); onClick(sessionId) })
      n.on('close', release)
      n.on('failed', release)
      n.show()
    },
    setBadge(c) {
      count = c
      showBadge()
    },
    attention() {
      if (platform !== 'win32' || o.quiet) return // quiet: tests never draw the eye
      const w = window()
      if (w && !isViewing(w)) w.flashFrame(true) // minimized counts as away, even when Windows still calls it focused
    },
    refresh: showBadge
  }
}
