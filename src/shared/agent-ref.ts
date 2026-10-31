/**
 * The text inserted into the Claude prompt by "Send to agent". Never includes a newline. `rel` is relative to the
 * session folder; on Windows it is written with forward slashes, as Claude Code's @-mentions are.
 */
export function formatAgentReference(rel: string, sel?: { fromLine: number; toLine: number }, platform?: string): string {
  const path = platform === 'win32' ? rel.replace(/\\/g, '/') : rel
  const ref = /\s/.test(path) ? `@"${path}"` : `@${path}`
  if (!sel) return `${ref} `
  return sel.fromLine === sel.toLine
    ? `${ref} (line ${sel.fromLine}) `
    : `${ref} (lines ${sel.fromLine}-${sel.toLine}) `
}
