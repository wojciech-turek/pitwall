import { join } from 'node:path'

/** Where tmux puts a `-L <socket>` server's socket; kill-server leaves the file behind. */
export function tmuxSocketPath(socket: string, env: Record<string, string | undefined> = process.env): string {
  return join(env.TMUX_TMPDIR || '/private/tmp', `tmux-${process.getuid!()}`, socket)
}
