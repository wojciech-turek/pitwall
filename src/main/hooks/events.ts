import { watch, type FSWatcher } from 'node:fs'
import { appendFile, mkdir, open } from 'node:fs/promises'
import { dirname, basename } from 'node:path'
import type { HookEvent } from '@shared/types'

export function parseEventLine(line: string): HookEvent | null {
  try {
    const o = JSON.parse(line) as unknown
    if (!o || typeof o !== 'object') return null
    const ev = o as HookEvent
    if (typeof ev.c !== 'string' || typeof ev.e !== 'string' || typeof ev.t !== 'number') return null
    return ev
  } catch {
    return null
  }
}

export async function appendEvent(file: string, ev: HookEvent): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, JSON.stringify(ev) + '\n')
}

export class EventTailer {
  private offset = 0
  private watcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private stopped = true

  constructor(
    private file: string,
    private onEvent: (ev: HookEvent) => void,
    private pollMs = 500
  ) {}

  /** Reads complete lines after the current offset; advances past them. A trailing partial line is left for later. */
  private async readNew(): Promise<HookEvent[]> {
    let fh
    try {
      fh = await open(this.file, 'r')
    } catch {
      return []
    }
    try {
      const { size } = await fh.stat()
      if (size < this.offset) this.offset = 0
      if (size === this.offset) return []
      const buf = Buffer.alloc(size - this.offset)
      const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset)
      const chunk = buf.subarray(0, bytesRead)
      const end = chunk.lastIndexOf(0x0a)
      if (end < 0) return []
      this.offset += end + 1
      const out: HookEvent[] = []
      for (const line of chunk.subarray(0, end).toString('utf8').split('\n')) {
        const ev = parseEventLine(line)
        if (ev) out.push(ev)
      }
      return out
    } finally {
      await fh.close()
    }
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn)
    this.chain = p.catch(() => undefined)
    return p
  }

  readAll(): Promise<HookEvent[]> {
    return this.serialize(async () => {
      this.offset = 0
      return this.readNew()
    })
  }

  private poll(): void {
    void this.serialize(async () => {
      if (this.stopped) return
      for (const ev of await this.readNew()) {
        if (this.stopped) return
        this.onEvent(ev)
      }
    }).catch(() => undefined)
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    try {
      const name = basename(this.file)
      this.watcher = watch(dirname(this.file), (_t, f) => {
        if (!f || f === name) this.poll()
      })
      this.watcher.on('error', () => {})
    } catch {
      this.watcher = null // directory missing: polling covers it
    }
    this.timer = setInterval(() => this.poll(), this.pollMs)
    this.poll()
  }

  stop(): void {
    this.stopped = true
    this.watcher?.close()
    this.watcher = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
