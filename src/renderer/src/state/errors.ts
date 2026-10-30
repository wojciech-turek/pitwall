/** Strip Electron's "Error invoking remote method 'x': Error: " prefix from IPC errors. */
export function cleanIpcError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '')
}
