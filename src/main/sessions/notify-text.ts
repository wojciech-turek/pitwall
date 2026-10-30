import type { DisplayStatus, SessionRuntime } from '@shared/types'

export function notificationBody(status: DisplayStatus, rt: SessionRuntime): string {
  if (status === 'unread') return rt.lastMessage ? rt.lastMessage.slice(0, 120) : 'Finished'
  switch (rt.needsInput) {
    case 'permission': return 'Needs your permission'
    case 'question': return 'Has a question for you'
    default: return 'Needs you'
  }
}
