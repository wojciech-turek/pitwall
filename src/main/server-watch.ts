import type { Exec } from './exec'
import type { SessionManager } from './sessions/manager'
import { listeningPorts } from './proctree'
import { descendants, parsePs } from './sessions/leftovers'
import type { Store } from './store'
import { serverTmuxName } from './tmux'
import type { SessionBackend } from './backend'

type State = { running: boolean; ports: number[] }

/**
 * Polls each live session's Server tab: whether its dev server runs and which ports it listens on. A pass costs one
 * list of the backend's sessions, and, when any server runs, one ps and one lsof for all of them.
 */
export class ServerWatcher {
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private published = new Map<string, State>()

  constructor(private readonly deps: {
    store: Store; manager: Pick<SessionManager, 'updateSessionExtras'>; backend: Pick<SessionBackend, 'listSessions' | 'processRoots'>
    exec: Exec; intervalMs?: number; platform?: NodeJS.Platform
  }) {}

  start(): void {
    this.stop()
    if ((this.deps.platform ?? process.platform) === 'win32') return
    this.timer = setInterval(() => { void this.tick() }, this.deps.intervalMs ?? 5000)
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One pass over the live sessions. Never overlaps another and never throws. */
  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      await this.run()
    } catch {
      // A failed pass is retried on the next tick.
    } finally {
      this.busy = false
    }
  }

  private async run(): Promise<void> {
    const { store, manager, backend, exec } = this.deps
    const live = new Set<string>()
    const names = new Set(await backend.listSessions())
    const watched: Array<{ id: string; running: boolean; roots: number[] }> = []
    for (const s of store.state.sessions) {
      if (s.archivedAt !== undefined) continue
      live.add(s.id)
      const sp = store.state.subProjects.find((x) => x.id === s.subProjectId)
      if (!sp?.devCommand) {
        if (this.published.delete(s.id)) manager.updateSessionExtras(s.id, { server: undefined })
        continue
      }
      const name = serverTmuxName(s.id)
      const running = names.has(name)
      // A server whose processes can't be read is looked at again next tick.
      const roots = running ? await backend.processRoots(name).then((r) => r.panePids, () => null) : []
      if (roots) watched.push({ id: s.id, running, roots })
    }
    // Every running server's processes, then one lsof for all of them; each port goes back to its session by pid.
    const owner = new Map<number, string>()
    if (watched.some((w) => w.roots.length)) {
      const ps = parsePs((await exec('ps', ['-axo', 'pid=,ppid=,lstart='])).stdout)
      for (const w of watched) for (const pid of [...w.roots, ...descendants(ps, w.roots).keys()]) if (!owner.has(pid)) owner.set(pid, w.id)
    }
    const byPid = await listeningPorts([...owner.keys()], exec)
    const ports = new Map<string, Set<number>>()
    for (const [pid, list] of byPid) {
      const id = owner.get(pid)
      if (!id) continue
      const set = ports.get(id) ?? new Set<number>()
      for (const p of list) set.add(p)
      ports.set(id, set)
    }
    for (const w of watched) {
      const state: State = { running: w.running, ports: [...(ports.get(w.id) ?? [])].sort((a, b) => a - b) }
      const prev = this.published.get(w.id)
      if (prev && prev.running === state.running && prev.ports.join() === state.ports.join()) continue
      this.published.set(w.id, state)
      manager.updateSessionExtras(w.id, { server: state })
    }
    for (const id of this.published.keys()) if (!live.has(id)) this.published.delete(id)
  }
}
