import { app, nativeImage, Notification, type BrowserWindow, type NativeImage } from 'electron'
import { badgeBitmap, badgeDescription, withDot } from './badge'
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
 *
 * macOS also puts a red dot on the Dock icon (`dockIcon`: the plain icon to draw it on) while the count is above
 * zero, since the badge itself can be turned off in System Settings and then nothing shows. Not when `quiet`.
 */
export function electronNotifier(
  onClick: (sessionId: string) => void,
  disabled: boolean,
  o: { platform?: NodeJS.Platform; window?: () => BrowserWindow | null; quiet?: boolean; dockIcon?: () => NativeImage | null } = {}
): Notifier & { refresh(): void } {
  const platform = o.platform ?? process.platform
  const window = (): BrowserWindow | null => {
    const w = o.window?.() ?? null
    return w && !w.isDestroyed() ? w : null
  }
  let count = 0
  // The plain and dotted Dock icons, made the first time the dot shows (null: no icon to draw on).
  let icons: { plain: NativeImage; dotted: NativeImage } | null | undefined
  let dotShown = false
  const showDot = (on: boolean): void => {
    if (platform !== 'darwin' || o.quiet || on === dotShown) return
    if (icons === undefined) {
      const plain = o.dockIcon?.() ?? null
      const { width, height } = plain?.getSize() ?? { width: 0, height: 0 }
      icons = plain && width > 0
        ? { plain, dotted: nativeImage.createFromBitmap(withDot({ width, height, data: plain.toBitmap() }), { width, height }) }
        : null
    }
    if (!icons) return
    app.dock?.setIcon(on ? icons.dotted : icons.plain)
    dotShown = on
  }
  const showBadge = (): void => {
    if (platform !== 'win32') {
      app.setBadgeCount(count)
      showDot(count > 0)
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
