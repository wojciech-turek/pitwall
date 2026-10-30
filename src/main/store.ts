import { randomInt } from 'node:crypto'
import { copyFile, mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DEFAULT_SETTINGS, type AppSettings, type PersistedState } from '@shared/types'

function emptyState(): PersistedState {
  return { version: 1, projects: [], subProjects: [], sessions: [], settings: { ...DEFAULT_SETTINGS } }
}

function parseState(text: string): PersistedState {
  const raw = JSON.parse(text)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('state is not an object')
  const settings = { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) }
  return {
    version: 1,
    projects: Array.isArray(raw.projects) ? raw.projects : [],
    subProjects: Array.isArray(raw.subProjects) ? raw.subProjects : [],
    sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
    // A state file from before the update check has no checkForUpdates: checking is on.
    settings: { ...settings, checkForUpdates: settings.checkForUpdates !== false }
  }
}

/**
 * Settings the renderer asked to save, made valid. A field it left out or got wrong keeps the current value
 * (fonts: the default), so saving the fonts never turns update checks back on or off.
 */
export function settingsFrom(input: unknown, current: AppSettings): AppSettings {
  const s = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const monoFont = typeof s.monoFont === 'string' && s.monoFont.trim() ? s.monoFont.trim() : DEFAULT_SETTINGS.monoFont
  const size = Number(s.monoFontSize)
  const monoFontSize = Number.isFinite(size) ? Math.min(32, Math.max(8, Math.round(size))) : DEFAULT_SETTINGS.monoFontSize
  const checkForUpdates = typeof s.checkForUpdates === 'boolean' ? s.checkForUpdates : current.checkForUpdates !== false
  return { monoFont, monoFontSize, checkForUpdates }
}

async function tryLoad(file: string): Promise<PersistedState | 'missing' | 'corrupt'> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw e
  }
  try {
    return parseState(text)
  } catch {
    return 'corrupt'
  }
}

export class Store {
  private _state: PersistedState
  private chain: Promise<unknown> = Promise.resolve()
  private listeners = new Set<() => void>()

  private constructor(private readonly file: string, state: PersistedState) {
    this._state = state
  }

  static async open(file: string): Promise<Store> {
    await mkdir(dirname(file), { recursive: true })
    const main = await tryLoad(file)
    if (typeof main === 'object') return new Store(file, main)
    if (main === 'corrupt') {
      const bak = await tryLoad(file + '.bak')
      // Move the bad main file aside so the next write cannot clobber a good .bak with it.
      await rename(file, `${file}.corrupt-${Date.now()}`)
      if (typeof bak === 'object') return new Store(file, bak)
    }
    return new Store(file, emptyState())
  }

  get state(): Readonly<PersistedState> {
    return this._state
  }

  update(mutator: (draft: PersistedState) => void): Promise<void> {
    const run = async (): Promise<void> => {
      const draft = structuredClone(this._state)
      mutator(draft)
      await this.write(draft)
      this._state = draft
      for (const cb of [...this.listeners]) {
        try { cb() } catch { /* listener errors must not affect the store */ }
      }
    }
    const result = this.chain.then(run)
    this.chain = result.catch(() => undefined)
    return result
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  private async write(state: PersistedState): Promise<void> {
    const tmp = this.file + '.tmp'
    const fh = await open(tmp, 'w')
    try {
      await fh.writeFile(JSON.stringify(state, null, 2))
      await fh.sync()
    } finally {
      await fh.close()
    }
    try {
      await copyFile(this.file, this.file + '.bak')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    await rename(tmp, this.file)
  }
}

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

export function newId(prefix: 'p' | 'sp' | 's'): string {
  let out = ''
  for (let i = 0; i < 8; i++) out += ID_CHARS[randomInt(ID_CHARS.length)]
  return `${prefix}_${out}`
}
