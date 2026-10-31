import type { AppSnapshot, DisplayStatus, HookEvent, SessionRuntime, SessionView } from './types'

export const initialRuntime: SessionRuntime = { activity: 'starting', firstEventSeen: false }

function clearNeeds(rt: SessionRuntime): SessionRuntime {
  const { needsInput: _n, ...rest } = rt
  return rest
}

function apply(rt: SessionRuntime, ev: HookEvent): SessionRuntime {
  const busy = rt.activity === 'working' || rt.activity === 'needs_input'
  switch (ev.e) {
    case 'SessionStart':
      return ev.src === 'compact' ? rt : { ...clearNeeds(rt), activity: 'idle' }
    case 'UserPromptSubmit': {
      const { lastError: _e, ...rest } = clearNeeds(rt)
      return { ...rest, activity: 'working' }
    }
    case 'PreToolUse':
      return ev.tool === 'AskUserQuestion'
        ? { ...rt, activity: 'needs_input', needsInput: 'question' }
        : { ...clearNeeds(rt), activity: 'working' }
    case 'PermissionRequest':
      // AskUserQuestion raises a PermissionRequest too (observed in Claude Code 2.1.314): it is still a question.
      return { ...rt, activity: 'needs_input', needsInput: ev.tool === 'AskUserQuestion' ? 'question' : 'permission' }
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return { ...clearNeeds(rt), activity: 'working' }
    case 'Notification':
      switch (ev.nt) {
        case 'permission_prompt':
          // Carries no tool and arrives ~6 s after the PermissionRequest: keep a reason that is already known.
          return { ...rt, activity: 'needs_input', needsInput: (rt.activity === 'needs_input' && rt.needsInput) || 'permission' }
        case 'elicitation_dialog':
        case 'agent_needs_input':
          return { ...rt, activity: 'needs_input', needsInput: 'other' }
        case 'idle_prompt':
          return busy ? { ...clearNeeds(rt), activity: 'idle', lastFinishedAt: ev.t } : rt
        default:
          return rt
      }
    case 'Stop': {
      const { lastMessage: _m, lastError: _e, ...rest } = clearNeeds(rt)
      const next: SessionRuntime = { ...rest, activity: 'idle', lastFinishedAt: ev.t }
      if (ev.msg != null) next.lastMessage = ev.msg
      return next
    }
    case 'StopFailure': {
      const { lastMessage: _m, ...rest } = clearNeeds(rt)
      return { ...rest, activity: 'idle', lastFinishedAt: ev.t, lastError: ev.err ?? 'Claude stopped with an error' }
    }
    case 'SessionEnd':
      return ev.reason === 'clear' || ev.reason === 'resume' ? rt : { ...clearNeeds(rt), activity: 'exited' }
    case 'pitwall:launch': {
      // A new run of Claude: its launcher reports its warnings again after this.
      const { exitCode: _x, warnings: _w, ...rest } = clearNeeds(rt)
      return { ...rest, activity: 'starting' }
    }
    case 'pitwall:warning':
      return ev.msg ? { ...rt, warnings: { ...rt.warnings, [ev.kind || 'other']: ev.msg } } : rt
    case 'pitwall:exited': {
      const next: SessionRuntime = { ...clearNeeds(rt), activity: 'exited' }
      if (ev.code != null) next.exitCode = ev.code
      return next
    }
    case 'pitwall:user-esc':
      return busy ? { ...clearNeeds(rt), activity: 'idle' } : rt
    case 'pitwall:user-input':
      return rt.activity === 'needs_input' ? { ...clearNeeds(rt), activity: 'working' } : rt
    default:
      return rt
  }
}

export function reduceRuntime(rt: SessionRuntime, ev: HookEvent): SessionRuntime {
  const next = { ...apply(rt, ev) }
  if (ev.sid) next.claudeSessionId = ev.sid
  next.lastEventAt = ev.t
  if (!ev.e.startsWith('pitwall:')) next.firstEventSeen = true
  return next
}

export function displayStatus(rt: SessionRuntime, lastViewedAt: number): DisplayStatus {
  switch (rt.activity) {
    case 'working': return 'working'
    case 'needs_input': return 'needs_you'
    case 'exited': return 'exited'
    case 'starting': return 'starting'
    case 'idle': return (rt.lastFinishedAt ?? 0) > lastViewedAt ? 'unread' : 'read'
  }
}

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  starting: 'Starting', working: 'Working', needs_you: 'Needs you', unread: 'Unread', read: 'Read', exited: 'Exited'
}

export function countStatuses(sessions: { status: DisplayStatus }[]): { needsYou: number; unread: number; working: number } {
  const c = { needsYou: 0, unread: 0, working: 0 }
  for (const s of sessions) {
    if (s.status === 'needs_you') c.needsYou++
    else if (s.status === 'unread') c.unread++
    else if (s.status === 'working') c.working++
  }
  return c
}

export function sidebarOrder(s: Pick<AppSnapshot, 'projects' | 'subProjects' | 'sessions'>): SessionView[] {
  const out: SessionView[] = []
  const projects = [...s.projects].sort((a, b) => a.createdAt - b.createdAt)
  for (const p of projects) {
    const subs = s.subProjects
      .filter((sp) => sp.projectId === p.id)
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    for (const sp of subs) {
      out.push(...s.sessions.filter((x) => x.subProjectId === sp.id).sort((a, b) => a.createdAt - b.createdAt))
    }
  }
  return out
}

export function nextAttention(ordered: { id: string; status: DisplayStatus }[], currentId: string | null): string | null {
  const idx = ordered.findIndex((s) => s.id === currentId)
  const rotated = idx < 0 ? ordered : [...ordered.slice(idx + 1), ...ordered.slice(0, idx)]
  return (
    rotated.find((s) => s.status === 'needs_you')?.id ??
    rotated.find((s) => s.status === 'unread')?.id ??
    null
  )
}
