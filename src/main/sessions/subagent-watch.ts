import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { claudeProjectDirName } from '../conversations'

/**
 * Claude sends no SubagentStop for a subagent it stops itself (TaskStop on its workflow or task; seen in Claude Code
 * 2.1.328). What tells is the subagent's transcript, which then ends with this user line.
 */
const INTERRUPTED = '[Request interrupted by user'
/** Enough for the transcript's last line when it is the interruption (about 600 bytes). */
const TAIL = 8 * 1024

/** When the subagent was interrupted, if that is the last thing in its transcript; null otherwise. */
export async function interruptedAt(file: string): Promise<number | null> {
  let fh
  try {
    fh = await open(file, 'r')
  } catch {
    return null
  }
  try {
    const { size } = await fh.stat()
    const buf = Buffer.alloc(Math.min(size, TAIL))
    const { bytesRead } = await fh.read(buf, 0, buf.length, size - buf.length)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    if (!text.endsWith('\n')) return null // a line still being written
    const last = text.trimEnd().split('\n').at(-1) ?? ''
    const o = JSON.parse(last) as { type?: unknown; timestamp?: unknown; message?: { content?: unknown } }
    if (o.type !== 'user') return null
    const content = o.message?.content
    const said = typeof content === 'string' ? content : Array.isArray(content) ? (content[0] as { text?: unknown } | undefined)?.text : null
    if (typeof said !== 'string' || !said.startsWith(INTERRUPTED)) return null
    const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
    return Number.isFinite(at) ? at : null
  } catch {
    return null // not the whole line, or not JSON: not an interruption we can read
  } finally {
    await fh.close()
  }
}

async function findIn(dir: string, name: string, depth: number): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  if (entries.some((e) => e.name === name)) return join(dir, name)
  if (depth > 0) {
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const hit = await findIn(join(dir, e.name), name, depth - 1)
      if (hit) return hit
    }
  }
  return null
}

/**
 * The transcript of a conversation's subagent: `<config dir>/projects/<folder>/<conversation id>/subagents/`, directly
 * or under `workflows/<run>/`. The folder is the one Claude names after `cwd`; failing that, whichever has the conversation.
 */
export async function agentTranscript(configDir: string, cwd: string, claudeId: string, agentId: string): Promise<string | null> {
  const root = join(configDir, 'projects')
  const name = `agent-${agentId}.jsonl`
  const first = claudeProjectDirName(cwd)
  const hit = await findIn(join(root, first, claudeId, 'subagents'), name, 2)
  if (hit) return hit
  for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || e.name === first) continue
    const other = await findIn(join(root, e.name, claudeId, 'subagents'), name, 2)
    if (other) return other
  }
  return null
}
