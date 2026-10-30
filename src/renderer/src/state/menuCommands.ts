import { useEffect, useRef } from 'react'
import { nextAttention, sidebarOrder } from '@shared/runtime'
import type { MenuCommand } from '@shared/api'
import type { AppSnapshot } from '@shared/types'
import { saveActiveFile } from '../components/FileEditor'
import { useToast } from './toast'
import { useUi } from './ui'
import { panes } from './layout'
import type { PaletteMode } from './palette'

const basename = (p: string): string => p.split('/').filter(Boolean).pop() ?? p

/** ⌘J: the next session that needs you, then the next unread one. */
export function goToNextAttention(s: AppSnapshot | null): void {
  if (!s) return
  const id = nextAttention(sidebarOrder(s), useUi.getState().selectedSessionId)
  if (id) useUi.getState().select(id)
  else useToast.getState().show('Nothing needs you right now.')
}

/** ⌘K / ⌘P: opens the palette, switches its mode, or closes it when it's already in that mode. */
function togglePalette(mode: PaletteMode): void {
  const ui = useUi.getState()
  if (ui.palette === mode) ui.closePalette()
  else ui.openPalette(mode) // no-op while a dialog is open
}

/** Handles application-menu commands (⌘K, ⌘P, ⌘N, ⌘S, ⌘W, ⌘J, ⌘1…⌘9, ⌘,). They act on the active pane. */
export function useMenuCommands(snap: AppSnapshot | null): void {
  const snapRef = useRef(snap)
  snapRef.current = snap
  useEffect(() => window.pitwall.onMenuCommand((c: MenuCommand) => {
    const ui = useUi.getState()
    const toast = useToast.getState().show
    const s = snapRef.current
    const sel = ui.selectedSessionId
    if (c.type === 'command-palette') { togglePalette('commands'); return }
    if (c.type === 'quick-open') { togglePalette('files'); return }
    // Dialogs and the palette own the keyboard.
    if (ui.dialog || ui.palette) return
    switch (c.type) {
      case 'settings': ui.openDialog({ type: 'settings' }); return
      case 'new-session': {
        const sp = s?.sessions.find((x) => x.id === sel)?.subProjectId
        if (sp) ui.openDialog({ type: 'new-session', subProjectId: sp })
        else toast('Select a session first, or use + next to a sub-project.')
        return
      }
      case 'next-attention': goToNextAttention(s); return
      case 'select-index': {
        const target = s ? sidebarOrder(s)[c.index] : undefined
        if (target) ui.select(target.id)
        return
      }
      case 'save':
        if (sel) void saveActiveFile(sel)
        return
      case 'close-tab': {
        if (!sel) return
        const id = ui.activeTab[sel]
        const tab = ui.tabs[sel]?.find((t) => t.id === id)
        if (!tab || !('kind' in tab)) {
          // Claude and Shell tabs never close; with 2+ panes the active pane closes instead
          const active = ui.layout.activePaneId
          if (active && panes(ui.layout).length > 1) ui.closePane(active)
          return
        }
        if (ui.dirty[`${sel}:${tab.id}`]) ui.openDialog({ type: 'discard-file', sessionId: sel, tabId: tab.id, name: basename(tab.path) })
        else ui.closeTab(sel, tab.id)
        return
      }
    }
  }), [])
}
