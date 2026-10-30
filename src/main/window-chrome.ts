import type { BrowserWindowConstructorOptions } from 'electron'

/** The title bar's colours, from the renderer's theme (theme.css: --bg-sidebar, --text-muted); a test keeps them equal. */
export const TITLE_BAR = { color: '#1c1b1a', symbolColor: '#9c9893', height: 37 }

/**
 * The window's frame. macOS: no title bar, the traffic lights inset over the app's own title bar. Elsewhere (Windows):
 * no title bar either; Windows draws its window buttons over the right end of the app's title bar, in its colours
 * (37 px: the title bar is 38 with its bottom border). The renderer leaves them room (theme.css).
 */
export function windowChrome(platform: NodeJS.Platform): Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'trafficLightPosition' | 'titleBarOverlay'> {
  if (platform === 'darwin') return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } }
  return { titleBarStyle: 'hidden', titleBarOverlay: { ...TITLE_BAR } }
}
