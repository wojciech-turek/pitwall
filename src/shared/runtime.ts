import type { AppSnapshot, DisplayStatus, HookEvent, SessionRuntime, SessionView, SubagentRun } from './types'

export const initialRuntime: SessionRuntime = { activity: 'starting', firstEventSeen: false }

/** Claude's own words for a usage limit, for when its error type isn't `rate_limit`. */
const LIMIT_TEXT = /\b(rate|usage) limit|limit (reached|hit)|hit your limit/i

function clearLimit(rt: SessionRuntime): SessionRuntime {
  const { limitHit: _l, ...rest } = rt
  return rest
}

function clearNeeds(rt: SessionRuntime): SessionRuntime {
  const { needsInput: _n, ...rest } = rt
  return rest
}

function clearRuns(rt: SessionRuntime): SessionRuntime {
  const { subagents: _s, agentDescs: _d, ...rest } = rt
  return rest
}

function clearPending(rt: SessionRuntime): SessionRuntime {
  const { promptPending: _p, ...rest } = rt
  return rest
}

const MAX_RUNS = 30
const MAX_DESCS = 20
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'PermissionRequest'])

/** A permission prompt or question raised from inside a subagent still needs the user. */
function needsUser(ev: HookEvent): boolean {
  return ev.e === 'PermissionRequest' ||
    (ev.e === 'Notification' && (ev.nt === 'permission_prompt' || ev.nt === 'elicitation_dialog' || ev.nt === 'agent_needs_input'))
}

function withRun(rt: SessionRuntime, id: string, patch: (r: SubagentRun) => SubagentRun): SessionRuntime {
  if (!rt.subagents?.some((x) => x.id === id)) return rt
  return { ...rt, subagents: rt.subagents.map((x) => (x.id === id ? patch(x) : x)) }
}

/** Subagent bookkeeping. Returns null for events that are not about a subagent. */
function applySubagent(rt: SessionRuntime, ev: HookEvent): SessionRuntime | null {
  const id = ev.aid
  if (ev.e === 'SubagentStart') {
    if (!id || !ev.at) return rt
    if (rt.subagents?.some((x) => x.id === id)) {
      return withRun(rt, id, ({ endedAt: _e, ...x }) => ({ ...x, state: 'running' }))
    }
    const descs = rt.agentDescs ? [...rt.agentDescs] : []
    const description = descs.shift()
    const run: SubagentRun = { id, type: ev.at, state: 'running', startedAt: ev.t }
    if (description !== undefined) run.description = description
    const next: SessionRuntime = { ...rt, subagents: [...(rt.subagents ?? []), run].slice(-MAX_RUNS) }
    if (rt.agentDescs) next.agentDescs = descs
    return next
  }
  if (ev.e === 'SubagentStop') {
    if (!id) return rt
    return withRun(rt, id, (x) => ({ ...x, state: 'done', endedAt: ev.t, lastMessage: ev.msg ?? undefined, needsYou: false }))
  }
  if (id && TOOL_EVENTS.has(ev.e)) {
    const need = needsUser(ev)
    let base = rt
    if (need) {
      base = applyMain(rt, ev)
      if (rt.activity !== 'needs_input') base = { ...base, resumeActivity: rt.activity }
      else if (rt.resumeActivity) base = { ...base, resumeActivity: rt.resumeActivity }
    }
    const post = ev.e === 'PostToolUse' || ev.e === 'PostToolUseFailure'
    const out = withRun(base, id, (x) => {
      const run: SubagentRun = { ...x }
      if (ev.tool) run.lastTool = ev.tool
      if (need) run.needsYou = true
      else if (post) run.needsYou = false
      return run
    })
    // The question is answered: the parent goes back to what it was doing.
    if (post && out.resumeActivity && !out.subagents?.some((x) => x.needsYou) &&
        (out.activity === 'needs_input' || out.activity === 'working')) {
      const { needsInput: _n, resumeActivity, ...rest } = out
      return { ...rest, activity: resumeActivity }
    }
    return out
  }
  if (ev.e === 'PreToolUse' && ev.tool === 'Agent' && ev.desc) {
    return { ...applyMain(rt, ev), agentDescs: [...(rt.agentDescs ?? []), ev.desc].slice(-MAX_DESCS) }
  }
  return null
}

function apply(rt: SessionRuntime, ev: HookEvent): SessionRuntime {
  return applySubagent(rt, ev) ?? applyMain(rt, ev)
}

function applyMain(rt: SessionRuntime, ev: HookEvent): SessionRuntime {
  const busy = rt.activity === 'working' || rt.activity === 'needs_input'
  switch (ev.e) {
    case 'SessionStart':
      // A first prompt passed at launch is on its way: still working, until its UserPromptSubmit.
      return ev.src === 'compact' ? rt : { ...clearLimit(clearNeeds(clearRuns(rt))), activity: rt.promptPending ? 'working' : 'idle' }
    case 'UserPromptSubmit': {
      const { lastError: _e, ...rest } = clearPending(clearLimit(clearNeeds(rt)))
      const next: SessionRuntime = { ...rest, activity: 'working', lastPromptAt: ev.t }
      if (rt.subagents) {
        const live = rt.subagents.filter((x) => x.state !== 'done')
        if (live.length) next.subagents = live
        else delete next.subagents
      }
      return next
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
      const { lastMessage: _m, lastError: _e, ...rest } = clearPending(clearNeeds(rt))
      const next: SessionRuntime = { ...rest, activity: 'idle', lastFinishedAt: ev.t }
      if (ev.msg != null) next.lastMessage = ev.msg
      return next
    }
    case 'StopFailure': {
      const { lastMessage: _m, ...rest } = clearNeeds(rt)
      const next: SessionRuntime = { ...rest, activity: 'idle', lastFinishedAt: ev.t, lastError: ev.err ?? 'Claude stopped with an error' }
      if (ev.err === 'rate_limit' || LIMIT_TEXT.test(ev.err ?? '') || LIMIT_TEXT.test(ev.msg ?? '')) next.limitHit = true
      return next
    }
    case 'SessionEnd':
      return ev.reason === 'clear' || ev.reason === 'resume' ? rt : { ...clearPending(clearNeeds(rt)), activity: 'exited' }
    case 'pitwall:launch': {
      // A new run of Claude: its launcher reports its warnings (and a first prompt) again after this.
      const { exitCode: _x, warnings: _w, ...rest } = clearPending(clearNeeds(rt))
      return { ...rest, activity: 'starting' }
    }
    case 'pitwall:prompt-pending':
      return { ...rt, promptPending: true }
    case 'pitwall:sent':
      // Pitwall typed a message and pressed Enter: working now, not only once Claude's UserPromptSubmit is read.
      return { ...clearNeeds(rt), activity: 'working' }
    case 'pitwall:send-failed':
      // The paste failed after pitwall:sent: only an idle session is sent to, so back to idle, with nothing new unread.
      return rt.activity === 'working' ? { ...rt, activity: 'idle' } : rt
    case 'pitwall:warning':
      return ev.msg ? { ...rt, warnings: { ...rt.warnings, [ev.kind || 'other']: ev.msg } } : rt
    case 'pitwall:exited': {
      const next: SessionRuntime = { ...clearPending(clearLimit(clearNeeds(clearRuns(rt)))), activity: 'exited' }
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
  // The parent's own events take over from a subagent's question (a typed answer keeps it). A Notification doesn't:
  // Claude can send the permission one without the subagent's id, some seconds after its PermissionRequest.
  if (!ev.aid && ev.e !== 'pitwall:user-input' && ev.e !== 'Notification') delete next.resumeActivity
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

/** Order of sessions within a folder: pinned ones first, then oldest first. */
export function bySessionOrder(a: Pick<SessionView, 'createdAt' | 'pinned'>, b: Pick<SessionView, 'createdAt' | 'pinned'>): number {
  return Number(b.pinned === true) - Number(a.pinned === true) || a.createdAt - b.createdAt
}

/** How many live ancestors a session has (through `createdBy`), capped at 3 so a deep chain, or a loop, stops indenting. */
export function sessionDepth(s: Pick<SessionView, 'createdBy'>, live: Set<string>, byId: Map<string, SessionView>): number {
  let depth = 0
  let cur: Pick<SessionView, 'createdBy'> | undefined = s
  while (depth < 3 && cur?.createdBy && live.has(cur.createdBy)) {
    depth++
    cur = byId.get(cur.createdBy)
  }
  return depth
}

/**
 * One folder's sessions as the sidebar lists them: each session's live children right after it (recursively, in
 * their own order), so pinning only orders siblings. A child whose parent isn't in the list sorts as a top-level
 * session. A loop in `createdBy` can't happen, but is still listed once, never forever.
 */
export function orderSessions<T extends Pick<SessionView, 'id' | 'createdAt' | 'pinned' | 'createdBy'>>(list: T[]): T[] {
  const live = new Set(list.map((x) => x.id))
  const kids = new Map<string, T[]>()
  const roots: T[] = []
  for (const x of list) {
    if (x.createdBy && x.createdBy !== x.id && live.has(x.createdBy)) {
      const k = kids.get(x.createdBy)
      if (k) k.push(x)
      else kids.set(x.createdBy, [x])
    } else roots.push(x)
  }
  const out: T[] = []
  const seen = new Set<string>()
  const visit = (x: T): void => {
    if (seen.has(x.id)) return
    seen.add(x.id)
    out.push(x)
    for (const c of (kids.get(x.id) ?? []).sort(bySessionOrder)) visit(c)
  }
  for (const x of roots.sort(bySessionOrder)) visit(x)
  for (const x of [...list].sort(bySessionOrder)) visit(x) // anything left is in a loop
  return out
}

export function sidebarOrder(s: Pick<AppSnapshot, 'projects' | 'subProjects' | 'sessions'>): SessionView[] {
  const out: SessionView[] = []
  const projects = [...s.projects].sort((a, b) => a.createdAt - b.createdAt)
  for (const p of projects) {
    const subs = s.subProjects
      .filter((sp) => sp.projectId === p.id)
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    for (const sp of subs) {
      out.push(...orderSessions(s.sessions.filter((x) => x.subProjectId === sp.id)))
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
