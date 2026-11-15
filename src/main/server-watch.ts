import type { Exec } from './exec'
import type { SessionManager } from './sessions/manager'
import { listeningPorts } from './proctree'
import { descendants, parsePs } from './sessions/leftovers'
import type { Store } from './store'
import { serverTmuxName } from './tmux'
import type { SessionBackend } from './backend'

type State = { running: boolean; ports: number[] }

/** Polls each live session's Server tab: whether its dev server runs and which ports it listens on. */
export class ServerWatcher {
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private published = new Map<string, State>()

  constructor(private readonly deps: {
    store: Store; manager: Pick<SessionManager, 'updateSessionExtras'>; backend: Pick<SessionBackend, 'hasSession' | 'processRoots'>
    exec: Exec; intervalMs?: number; platform?: NodeJS.Platform
  }) {}

  start(): void {
    this.stop()
    if ((this.deps.platform ?? process.platform) === 'win32') return
    this.timer = setInterval(() => { void this.tick() }, this.deps.intervalMs ?? 3000)
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
    let ps: ReturnType<typeof parsePs> | null = null
    for (const s of store.state.sessions) {
      if (s.archivedAt !== undefined) continue
      live.add(s.id)
      const sp = store.state.subProjects.find((x) => x.id === s.subProjectId)
      if (!sp?.devCommand) {
        if (this.published.delete(s.id)) manager.updateSessionExtras(s.id, { server: undefined })
        continue
      }
      try {
        const name = serverTmuxName(s.id)
        const running = await backend.hasSession(name)
        let ports: number[] = []
        if (running) {
          const { panePids } = await backend.processRoots(name)
          if (panePids.length) {
            ps ??= parsePs((await exec('ps', ['-axo', 'pid=,ppid=,lstart='])).stdout)
            ports = await listeningPorts([...panePids, ...descendants(ps, panePids).keys()], exec)
          }
        }
        const prev = this.published.get(s.id)
        if (prev && prev.running === running && prev.ports.join() === ports.join()) continue
        this.published.set(s.id, { running, ports })
        manager.updateSessionExtras(s.id, { server: { running, ports } })
      } catch {
        // This session is looked at again next tick.
      }
    }
    for (const id of this.published.keys()) if (!live.has(id)) this.published.delete(id)
  }
}
