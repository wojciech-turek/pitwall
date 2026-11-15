import type { Exec } from './exec'

/**
 * Ports by process from `lsof -nP -a -iTCP -sTCP:LISTEN -p <pids> -Fn`: each `p<pid>` line, then its `n` lines (like
 * `n*:5173`, `n[::1]:5173`). Each process's ports are unique and sorted.
 */
export function parseLsofListen(text: string): Map<number, number[]> {
  const byPid = new Map<number, Set<number>>()
  let cur: Set<number> | null = null
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) {
      const pid = /^p(\d+)\s*$/.exec(line)
      cur = null
      if (pid) {
        const n = Number(pid[1])
        cur = byPid.get(n) ?? new Set<number>()
        byPid.set(n, cur)
      }
      continue
    }
    const m = /^n.*:(\d+)\s*$/.exec(line)
    if (m && cur) cur.add(Number(m[1]))
  }
  const out = new Map<number, number[]>()
  for (const [pid, ports] of byPid) if (ports.size) out.set(pid, [...ports].sort((a, b) => a - b))
  return out
}

/** TCP ports these processes listen on, by pid, in one lsof; none when lsof fails (it exits 1 when nothing matches). */
export async function listeningPorts(pids: number[], exec: Exec): Promise<Map<number, number[]>> {
  if (pids.length === 0) return new Map()
  try {
    const r = await exec('lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', pids.join(','), '-Fn'])
    return parseLsofListen(r.stdout)
  } catch {
    return new Map()
  }
}
