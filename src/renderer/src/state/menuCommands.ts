import { useEffect, useRef } from 'react'
import { nextAttention, sidebarOrder } from '@shared/runtime'
import type { MenuCommand } from '@shared/api'
import type { AppSnapshot } from '@shared/types'
import { saveActiveFile } from '../components/FileEditor'
import { useToast } from './toast'
import { useUi } from './ui'
import { panes } from './layout'

const basename = (p: string): string => p.split('/').filter(Boolean).pop() ?? p

/** Handles application-menu commands (⌘N, ⌘S, ⌘W, ⌘J, ⌘1…⌘9, ⌘,). They act on the active pane. */
export function useMenuCommands(snap: AppSnapshot | null): void {
  const snapRef = useRef(snap)
  snapRef.current = snap
  useEffect(() => window.pitwall.onMenuCommand((c: MenuCommand) => {
    const ui = useUi.getState()
    const toast = useToast.getState().show
    const s = snapRef.current
    const sel = ui.selectedSessionId
    // Dialogs own the keyboard.
    if (ui.dialog) return
    switch (c.type) {
      case 'settings': ui.openDialog({ type: 'settings' }); return
      case 'new-session': {
        const sp = s?.sessions.find((x) => x.id === sel)?.subProjectId
        if (sp) ui.openDialog({ type: 'new-session', subProjectId: sp })
        else toast('Select a session first, or use + next to a sub-project.')
        return
      }
      case 'next-attention': {
        if (!s) return
        const id = nextAttention(sidebarOrder(s), sel)
        if (id) ui.select(id)
        else toast('Nothing needs you right now.')
        return
      }
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
