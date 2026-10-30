import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import type { TermKind } from '@shared/types'
import { shouldPassToApp } from './keys'
import { plainText } from './plain-text'
import { TERMINAL_THEME } from './theme'
import { DEFAULT_SETTINGS } from '@shared/types'

export { shouldPassToApp }

interface Entry {
  term: Terminal
  fit: FitAddon
  opened: boolean // termOpen has been issued for the current pty
  rendered: boolean // term.open(element) done (xterm DOM created)
  reopenOnKey: boolean
}

const cache = new Map<string, Entry>()
const keyOf = (id: string, kind: TermKind): string => `${id}:${kind}`
let font = { family: DEFAULT_SETTINGS.monoFont, size: DEFAULT_SETTINGS.monoFontSize }
let subscribed = false
let pendingFocus: string | null = null

export function setTerminalFont(family: string, size: number): void {
  font = { family, size }
  for (const e of cache.values()) {
    e.term.options.fontFamily = family
    e.term.options.fontSize = size
  }
}

function ensureSubscribed(): void {
  if (subscribed) return
  subscribed = true
  window.pitwall.onTermData((id, kind, data) => cache.get(keyOf(id, kind))?.term.write(data))
  window.pitwall.onTermExit((id, kind) => {
    const e = cache.get(keyOf(id, kind))
    if (!e) return
    e.opened = false
    e.reopenOnKey = true
    // Claude: a key relaunches the tmux session, which resumes the same conversation.
    const text = kind === 'shell'
      ? 'Shell exited — press any key to start a new one'
      : 'Claude session ended — press any key to reattach.'
    e.term.write(`\r\n\x1b[90m[${text}]\x1b[0m`)
  })
}

export function getTerminal(sessionId: string, kind: TermKind): Entry {
  ensureSubscribed()
  const k = keyOf(sessionId, kind)
  const existing = cache.get(k)
  if (existing) return existing
  const term = new Terminal({
    fontFamily: font.family, fontSize: font.size, lineHeight: 1.2, cursorBlink: true,
    macOptionClickForcesSelection: true, scrollback: 1000, allowProposedApi: true, theme: TERMINAL_THEME
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon((_e, uri) => { void window.pitwall.openExternal(uri).catch(() => {}) }))
  term.loadAddon(new ClipboardAddon())
  term.attachCustomKeyEventHandler((e) => !shouldPassToApp(e))
  const entry: Entry = { term, fit, opened: false, rendered: false, reopenOnKey: false }
  term.onData((data) => {
    if (entry.reopenOnKey) {
      entry.reopenOnKey = false
      void openPty(sessionId, kind, entry)
      return
    }
    window.pitwall.termWrite(sessionId, kind, data)
  })
  term.onResize(({ cols, rows }) => { if (entry.opened) window.pitwall.termResize(sessionId, kind, cols, rows) })
  cache.set(k, entry)
  return entry
}

/** Issue termOpen with the current size; on failure show the error in the terminal. */
export async function openPty(sessionId: string, kind: TermKind, entry: Entry): Promise<void> {
  entry.opened = true
  try {
    await window.pitwall.termOpen(sessionId, kind, entry.term.cols, entry.term.rows)
  } catch (e) {
    entry.opened = false
    entry.reopenOnKey = true
    const msg = plainText((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, ''))
    entry.term.write(`\r\n\x1b[31m${msg.replace(/\n/g, '\r\n')}\x1b[0m\r\n\x1b[90m[press any key to retry]\x1b[0m`)
  }
}

/** Mount the cached terminal into a container (creating its DOM on first use). */
export function attachTerminal(sessionId: string, kind: TermKind, container: HTMLElement): Entry {
  const entry = getTerminal(sessionId, kind)
  if (!entry.rendered) {
    entry.rendered = true
    entry.term.open(container)
    try {
      const gl = new WebglAddon()
      gl.onContextLoss(() => gl.dispose())
      entry.term.loadAddon(gl)
    } catch { /* DOM renderer fallback */ }
  } else if (entry.term.element && entry.term.element.parentElement !== container) {
    container.appendChild(entry.term.element)
  }
  return entry
}

export function requestFocus(sessionId: string, kind: TermKind): void {
  const e = cache.get(keyOf(sessionId, kind))
  if (e?.term.element?.isConnected) { e.term.focus(); return } // already mounted: focus now
  pendingFocus = keyOf(sessionId, kind)
}
export function takePendingFocus(sessionId: string, kind: TermKind): boolean {
  if (pendingFocus !== keyOf(sessionId, kind)) return false
  pendingFocus = null
  return true
}

export function disposeTerminal(sessionId: string, kind: TermKind): void {
  const k = keyOf(sessionId, kind)
  const e = cache.get(k)
  if (!e) return
  cache.delete(k)
  e.opened = false
  e.term.dispose()
  window.pitwall.termClose(sessionId, kind)
}

/** Dispose every cached terminal whose session is no longer live. */
export function pruneTerminals(liveIds: Set<string>): void {
  for (const k of [...cache.keys()]) {
    const i = k.lastIndexOf(':')
    const id = k.slice(0, i)
    if (!liveIds.has(id)) disposeTerminal(id, k.slice(i + 1) as TermKind)
  }
}
