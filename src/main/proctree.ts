import type { Exec } from './exec'

/** Ports from `lsof -nP -a -iTCP -sTCP:LISTEN -p <pids> -Fn` (lines like `n*:5173`, `n[::1]:5173`): unique, sorted. */
export function parseLsofListen(text: string): number[] {
  const ports = new Set<number>()
  for (const line of text.split('\n')) {
    const m = /^n.*:(\d+)\s*$/.exec(line)
    if (m) ports.add(Number(m[1]))
  }
  return [...ports].sort((a, b) => a - b)
}

/** TCP ports these processes listen on; [] for none, or when lsof fails (it exits 1 when nothing matches). */
export async function listeningPorts(pids: number[], exec: Exec): Promise<number[]> {
  if (pids.length === 0) return []
  try {
    const r = await exec('lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', pids.join(','), '-Fn'])
    return parseLsofListen(r.stdout)
  } catch {
    return []
  }
}
