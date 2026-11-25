/**
 * Whether an OSC 52 write names the system clipboard. tmux names no selection at all (`OSC 52 ; ; <base64>`), which
 * xterm defines as the default one; the addon's own provider only takes `c`, so text selected in tmux was never copied.
 */
export const writesClipboard = (selection: string): boolean => selection === '' || selection.includes('c')

/** The system clipboard for programs in a terminal: writes as above, reads only when `c` is asked for by name. */
export function clipboardProvider(clip: { readText(): Promise<string>; writeText(text: string): Promise<void> }): {
  readText(selection: string): Promise<string>
  writeText(selection: string, text: string): Promise<void>
} {
  return {
    readText: async (selection) => (selection === 'c' ? clip.readText() : ''),
    writeText: async (selection, text) => {
      if (writesClipboard(selection)) await clip.writeText(text)
    }
  }
}
