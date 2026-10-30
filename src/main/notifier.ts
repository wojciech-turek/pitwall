import { app, Notification } from 'electron'

export interface Notifier {
  notify(n: { sessionId: string; title: string; body: string }): void
  setBadge(count: number): void
}

/** macOS notifications and the dock badge. `disabled` (PITWALL_DISABLE_NOTIFICATIONS) silences notifications only. */
export function electronNotifier(onClick: (sessionId: string) => void, disabled: boolean): Notifier {
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
    setBadge(count) {
      app.setBadgeCount(count)
    }
  }
}
