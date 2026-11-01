import type {
  ConversationItem, ConversationList, ConversationMatch, OutsideConversation, Project, Session, StartProgress, StartResult,
  SubProject
} from '@shared/types'
import { mergeEnv } from '../../host/win-command'
import { CONVERSATION_ID, listOutsideConversations } from '../conversations'
import type { SessionHistory } from '../history'
import { buildSessionEnv, claudeConfigDir } from '../identity'
import { msg, startLockKey, startSessionLocked, type StarterDeps } from './starter'

/**
 * "Continue a conversation" in a folder: its archived sessions and the Claude conversations run there outside Pitwall
 * (listed and searched), and continuing one of the latter in a new session of its own. Pitwall only reads Claude's
 * transcripts; the new session's Claude resumes the conversation (`claude --resume`) from its own worktree.
 */

/** How long a folder's list of outside conversations serves searching and continuing before it's made again. */
const LIST_MS = 60_000
/** Used this recently, a conversation may still be open in a terminal. */
const RECENT_MS = 5 * 60_000
const MAX_TITLE = 80
const MAX_QUERY = 256
/** The first Claude Code with what continuing needs (--system-prompt-snapshot, --append-system-prompt-file). */
const MIN_CLAUDE = [2, 1, 257]

export const CONTINUE_ERRORS = {
  inPitwall: 'This conversation is already in Pitwall.',
  gone: (folder: string) => `Pitwall couldn't find that conversation in ${folder} any more.`,
  update: 'Continuing a conversation from outside Pitwall needs Claude Code 2.1.257 or newer. Update Claude Code (claude update), then try again.'
}

export interface ConversationsDeps extends StarterDeps {
  history: Pick<SessionHistory, 'search' | 'searchFiles'>
  now: () => number
}

/** A folder's outside conversations, as listed at `at` (ms). */
interface Listed { at: number; configDir: string; folder: string; items: OutsideConversation[]; truncated: boolean }

export class Conversations {
  /** By sub-project: the last list of its outside conversations. */
  private lists = new Map<string, Listed>()

  constructor(private readonly deps: ConversationsDeps) {}

  /** The folder's archived sessions and outside conversations (listed afresh), newest first. Open sessions aren't. */
  async list(subProjectId: string): Promise<ConversationList> {
    const { sub, project } = this.find(subProjectId)
    const outside = await this.listOutside(sub, project)
    const now = this.deps.now()
    const items: ConversationItem[] = [
      ...this.archived(sub.id).map((s) => item('archived', s.id, s.title, s.archivedAt ?? s.createdAt, s.branch)),
      ...outside.items.map((c) => ({
        ...item('outside', c.claudeId, c.title, c.updatedAt, c.branch), recentlyActive: now - c.updatedAt <= RECENT_MS
      }))
    ]
    return { items: items.sort((a, b) => b.updatedAt - a.updatedAt), truncated: outside.truncated }
  }

  /** Those whose title or conversation has every word of the query: title matches first, then the newest. */
  async search(subProjectId: string, query: string): Promise<ConversationMatch[]> {
    const { sub, project } = this.find(subProjectId)
    const q = query.slice(0, MAX_QUERY)
    const archived = new Set(this.archived(sub.id).map((s) => s.id))
    const outside = await this.outside(sub, project)
    const updatedAt = new Map(outside.map((c) => [c.claudeId, c.updatedAt]))
    const [sessions, files] = await Promise.all([
      this.deps.history.search(q, Number.POSITIVE_INFINITY), // every hit: only this folder's archived ones are kept
      this.deps.history.searchFiles(q, outside.map((c) => ({ key: c.claudeId, title: c.title, path: c.transcriptPath })))
    ])
    const hits = [
      ...sessions.filter((h) => archived.has(h.sessionId)).map((h) => ({
        kind: 'archived' as const, id: h.sessionId, matchedIn: h.matchedIn, snippet: h.snippet, updatedAt: h.updatedAt
      })),
      ...files.map((f) => ({
        kind: 'outside' as const, id: f.key, matchedIn: f.matchedIn, snippet: f.snippet, updatedAt: updatedAt.get(f.key) ?? 0
      }))
    ]
    hits.sort((a, b) => Number(a.matchedIn !== 'title') - Number(b.matchedIn !== 'title') || b.updatedAt - a.updatedAt)
    return hits.map(({ updatedAt: _, ...m }) => m)
  }

  /**
   * Starts a session in the folder that continues one of its outside conversations: on a new branch from the one the
   * conversation was on (if it still exists), titled as the conversation. Claude must be new enough for the launcher
   * to keep it to the session's worktree (see continueNote).
   */
  async continue(
    subProjectId: string, claudeId: string, requestId: string, onProgress: (p: StartProgress) => void
  ): Promise<StartResult> {
    const fail = (error: string): StartResult => ({ ok: false, step: 'identity', error })
    try {
      const { sub, project } = this.find(subProjectId)
      if (!CONVERSATION_ID.test(claudeId)) return fail(CONTINUE_ERRORS.gone(sub.name))
      const version = await this.claudeVersion(project, sub)
      if (!version || !atLeast(version, MIN_CLAUDE)) return fail(CONTINUE_ERRORS.update)
      // The lock a start there takes: a conversation picked twice starts once.
      return await this.deps.mutex.run(startLockKey(this.deps, sub.id), async () => {
        if (this.inPitwall().has(claudeId)) return fail(CONTINUE_ERRORS.inPitwall)
        const conv = (await this.outside(sub, project)).find((c) => c.claudeId === claudeId)
        if (!conv) return fail(CONTINUE_ERRORS.gone(sub.name))
        const root = sub.kind === 'repo' ? sub.repoRoot : undefined
        const branch = conv.branch
        const from = root && branch && (await this.deps.git.branchExists(root, branch)) ? branch : undefined
        return startSessionLocked({
          requestId, subProjectId: sub.id, title: clip(conv.title), branchMode: 'new', branch: '', baseBranch: from,
          continueClaudeId: conv.claudeId, continuedFrom: conv.cwd
        }, this.deps, onProgress)
      })
    } catch (e) {
      return fail(msg(e))
    }
  }

  private find(subProjectId: string): { sub: SubProject; project: Project } {
    const { subProjects, projects } = this.deps.store.state
    const sub = subProjects.find((s) => s.id === subProjectId)
    if (!sub) throw new Error('Sub-project not found.')
    const project = projects.find((p) => p.id === sub.projectId)
    if (!project) throw new Error('Project not found.')
    return { sub, project }
  }

  private archived(subProjectId: string): Session[] {
    return this.deps.store.state.sessions.filter((s) => s.subProjectId === subProjectId && s.archivedAt !== undefined)
  }

  /** Every Claude conversation a Pitwall session has, running or archived: its current one and those before a /clear. */
  private inPitwall(): Set<string> {
    return new Set(this.deps.store.state.sessions.flatMap((s) => [s.claudeSessionId, ...(s.pastClaudeIds ?? [])]))
  }

  /** The folder's outside conversations: the last list if under a minute old, else a new one; less those Pitwall has now. */
  private async outside(sub: SubProject, project: Project): Promise<OutsideConversation[]> {
    const last = this.lists.get(sub.id)
    const fresh = last && this.deps.now() - last.at < LIST_MS && last.configDir === this.configDir(project) &&
      last.folder === this.folder(sub)
    const listed = fresh ? last : await this.listOutside(sub, project)
    const taken = this.inPitwall()
    return listed.items.filter((c) => !taken.has(c.claudeId))
  }

  private async listOutside(sub: SubProject, project: Project): Promise<Listed> {
    const configDir = this.configDir(project)
    const folder = this.folder(sub)
    const { paths, platform } = this.deps
    const exclude = this.inPitwall()
    const r = await listOutsideConversations({ configDir, folder, exclude, worktreesRoot: paths.worktreesRoot, platform })
    const listed: Listed = { at: this.deps.now(), configDir, folder, ...r }
    this.lists.set(sub.id, listed)
    return listed
  }

  /** Where the project's Claude keeps its transcripts. */
  private configDir(project: Project): string {
    return claudeConfigDir(project, this.deps.home, this.deps.env)
  }

  /** The folder's path without a separator at the end: Claude names a folder's transcripts by its path as it ran. */
  private folder(sub: SubProject): string {
    const bare = sub.path.replace((this.deps.platform ?? process.platform) === 'win32' ? /[\\/]+$/ : /\/+$/, '')
    return bare && !/^[A-Za-z]:$/.test(bare) ? bare : sub.path
  }

  /**
   * Claude Code's version (`claude --version`: "2.1.316 (Claude Code)"), from the Claude the session would run, with
   * its environment (the project's variables over the app's); null if it can't be read.
   */
  private async claudeVersion(project: Project, sub: SubProject): Promise<number[] | null> {
    const { paths, home, exec } = this.deps
    const platform = this.deps.platform ?? process.platform
    const session = buildSessionEnv({
      project, session: { id: '', title: '' }, rootPath: sub.repoRoot ?? sub.path, sessionDir: '', eventsFile: '',
      claudeBin: paths.claudeBin, ghBin: paths.ghBin, home, platform
    })
    const env = mergeEnv(this.deps.env, session, platform)
    const r = await exec(paths.claudeBin, ['--version'], { env, timeoutMs: 15_000 }).catch(() => null)
    const m = r?.code === 0 ? /(\d+)\.(\d+)\.(\d+)/.exec(r.stdout) : null
    return m ? m.slice(1).map(Number) : null
  }
}

function item(
  kind: ConversationItem['kind'], id: string, title: string, updatedAt: number, branch?: string
): ConversationItem {
  return branch ? { kind, id, title, updatedAt, branch } : { kind, id, title, updatedAt }
}

/** Whether version `v` is `min` or later. */
function atLeast(v: number[], min: number[]): boolean {
  for (let i = 0; i < min.length; i++) if (v[i] !== min[i]) return v[i] > min[i]
  return true
}

/** At most MAX_TITLE characters, never half an emoji. */
function clip(title: string): string {
  if (title.length <= MAX_TITLE) return title
  let cut = title.slice(0, MAX_TITLE - 1)
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1)
  return cut.trimEnd() + '…'
}
