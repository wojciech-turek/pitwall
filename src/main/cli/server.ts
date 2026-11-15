import { randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, lstat, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import type { AppSnapshot, DisplayStatus, SessionView } from '@shared/types'
import type { SessionManager } from '../sessions/manager'
import { cliToken } from './auth'

export type CliManager = Pick<SessionManager, 'snapshot' | 'onSnapshot' | 'start'> & {
  sendText(id: string, text: string): Promise<void>
}

type Reply = { ok: true; [k: string]: unknown } | { ok: false; error: string }

const MAX_REQUEST = 1024 * 1024
const DEFAULT_WAIT_SEC = 1800
const MAX_WAIT_SEC = 7200
const DONE: ReadonlySet<DisplayStatus> = new Set(['unread', 'read', 'needs_you', 'exited'])

const fail = (error: string): Reply => ({ ok: false, error })
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/**
 * Lets a session ask Pitwall to start, list, watch and message other sessions, over a unix socket in the data dir.
 * One JSON line in, one JSON line out, then the connection ends. A session proves itself with an HMAC token only
 * Pitwall (and the session it was given to) can make, and can only reach its own folder's sessions.
 */
export class CliServer {
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()
  private readonly idleMs: number

  constructor(private readonly deps: { key: Buffer; socketPath: string; manager: CliManager; now?: () => number; idleMs?: number }) {
    this.idleMs = deps.idleMs ?? 10_000
  }

  async start(): Promise<void> {
    // Clear only an old socket (left by a crash); never delete some other file that happens to be there.
    const old = await lstat(this.deps.socketPath).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null
      throw e
    })
    if (old) {
      if (!old.isSocket()) throw new Error(`Something that isn't a socket is in the way at ${this.deps.socketPath}.`)
      await rm(this.deps.socketPath, { force: true })
    }
    const server = createServer((c) => this.connection(c))
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.deps.socketPath, () => {
        server.off('error', reject)
        server.on('error', () => {}) // a later socket error must never crash main
        resolve()
      })
    })
    if (process.platform !== 'win32') await chmod(this.deps.socketPath, 0o600)
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    for (const c of this.sockets) c.destroy()
    this.sockets.clear()
    if (!server) return // never started: the path may hold someone else's file
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(this.deps.socketPath, { force: true }).catch(() => {})
  }

  private connection(c: Socket): void {
    this.sockets.add(c)
    let buf = ''
    let got = false
    let cleanup: (() => void) | null = null
    c.setEncoding('utf8')
    const idle = setTimeout(() => c.destroy(), this.idleMs)
    const reply = (r: Reply): void => {
      if (!c.destroyed) c.end(JSON.stringify(r) + '\n')
    }
    c.on('error', () => {})
    c.on('close', () => {
      clearTimeout(idle)
      cleanup?.()
      this.sockets.delete(c)
    })
    c.on('data', (chunk: string) => {
      if (got) return
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl < 0 && buf.length <= MAX_REQUEST) return
      got = true
      clearTimeout(idle)
      if ((nl < 0 ? buf.length : nl) > MAX_REQUEST) {
        reply(fail('Request too large.'))
        return
      }
      const line = buf.slice(0, nl)
      buf = ''
      void this.handle(line, reply, (fn) => { cleanup = fn }, c).catch((e) => reply(fail(e instanceof Error ? e.message : String(e))))
    })
  }

  private authorised(session: unknown, token: unknown): SessionView | null {
    if (typeof session !== 'string' || typeof token !== 'string') return null
    const want = Buffer.from(cliToken(this.deps.key, session))
    const got = Buffer.from(token)
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null
    return this.deps.manager.snapshot().sessions.find((s) => s.id === session) ?? null
  }

  private async handle(line: string, reply: (r: Reply) => void, onCleanup: (fn: () => void) => void, c: Socket): Promise<void> {
    let req: { v?: unknown; session?: unknown; token?: unknown; cmd?: unknown; args?: unknown }
    try {
      req = JSON.parse(line)
    } catch {
      return reply(fail('Bad request.'))
    }
    if (!req || typeof req !== 'object' || req.v !== 1) return reply(fail('Bad request.'))
    const caller = this.authorised(req.session, req.token)
    if (!caller) return reply(fail('Not a Pitwall session.'))
    const args = (req.args && typeof req.args === 'object' ? req.args : {}) as Record<string, unknown>
    const m = this.deps.manager
    switch (req.cmd) {
      case 'new': return reply(await this.newSession(caller, args))
      case 'list': {
        const sessions = m.snapshot().sessions.filter((s) => s.subProjectId === caller.subProjectId)
          .map((s) => ({ id: s.id, title: s.title, status: s.status, branch: s.branch, createdBy: s.createdBy }))
        return reply({ ok: true, sessions })
      }
      case 'status': {
        const t = this.target(caller, args)
        if (typeof t === 'string') return reply(fail(t))
        return reply({ ok: true, id: t.id, title: t.title, status: t.status, lastMessage: t.lastMessage })
      }
      case 'send': {
        const id = str(args.id)
        const t = m.snapshot().sessions.find((s) => s.id === id)
        if (!t || t.createdBy !== caller.id) return reply(fail('You can only send to sessions you started.'))
        if (t.status !== 'read' && t.status !== 'unread') return reply(fail(`${t.title} is busy (${t.status}); wait for it first.`))
        const text = str(args.text)
        if (!text) return reply(fail('Nothing to send.'))
        await m.sendText(t.id, text)
        return reply({ ok: true })
      }
      case 'wait': return this.wait(caller, args, reply, onCleanup, c)
      default: return reply(fail(`Unknown command ${String(req.cmd)}.`))
    }
  }

  /** The target of status/wait: in the caller's folder, or the error text. */
  private target(caller: SessionView, args: Record<string, unknown>): SessionView | string {
    const id = str(args.id)
    const t = this.deps.manager.snapshot().sessions.find((s) => s.id === id)
    if (!t || t.subProjectId !== caller.subProjectId) return `${String(id)} isn't in this project.`
    return t
  }

  private async newSession(caller: SessionView, args: Record<string, unknown>): Promise<Reply> {
    const title = args.title
    if (typeof title !== 'string' || !title.trim() || title.length > 200) return fail('A title (1 to 200 characters) is required.')
    const res = await this.deps.manager.start({
      requestId: randomUUID(), subProjectId: caller.subProjectId, title, branchMode: 'new',
      branch: str(args.branch) ?? '', baseBranch: str(args.base), createdBy: caller.id, initialPrompt: str(args.prompt)
    }, () => {})
    if (!res.ok) return fail(res.error)
    const s = this.deps.manager.snapshot().sessions.find((x) => x.id === res.sessionId)
    return { ok: true, id: res.sessionId, title: s?.title ?? title, branch: s?.branch, worktree: s?.worktreePath }
  }

  private wait(
    caller: SessionView, args: Record<string, unknown>, reply: (r: Reply) => void, onCleanup: (fn: () => void) => void, c: Socket
  ): void {
    const t0 = this.target(caller, args)
    if (typeof t0 === 'string') return reply(fail(t0))
    const id = t0.id
    const m = this.deps.manager
    const asked = typeof args.timeoutSec === 'number' && args.timeoutSec > 0 ? args.timeoutSec : DEFAULT_WAIT_SEC
    const sec = Math.min(asked, MAX_WAIT_SEC)
    let last: SessionView = t0
    let unsub: (() => void) | null = null
    let timer: NodeJS.Timeout | null = null
    let done = false
    const finish = (r: Reply | null): void => {
      if (done) return
      done = true
      unsub?.()
      if (timer) clearTimeout(timer)
      if (r && !c.destroyed) reply(r)
    }
    const check = (snap: AppSnapshot): boolean => {
      const s = snap.sessions.find((x) => x.id === id)
      if (!s) {
        const gone = snap.archived.find((x) => x.id === id)
        finish(fail(`${gone?.title ?? last.title} was archived.`))
        return true
      }
      last = s
      if (DONE.has(s.status)) {
        finish({ ok: true, status: s.status, lastMessage: s.lastMessage })
        return true
      }
      return false
    }
    if (check(m.snapshot())) return
    unsub = m.onSnapshot((snap) => { check(snap) })
    onCleanup(() => finish(null))
    timer = setTimeout(() => {
      const hint = last.status === 'starting' ? ' (it may be asking whether to trust the folder; the user can answer in Pitwall)' : ''
      finish(fail(`${last.title} is still ${last.status}${hint}`))
    }, sec * 1000)
  }
}
