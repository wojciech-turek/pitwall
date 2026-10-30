/** The text inserted into the Claude prompt by "Send to agent". Never includes a newline. */
export function formatAgentReference(rel: string, sel?: { fromLine: number; toLine: number }): string {
  const ref = /\s/.test(rel) ? `@"${rel}"` : `@${rel}`
  if (!sel) return `${ref} `
  return sel.fromLine === sel.toLine
    ? `${ref} (line ${sel.fromLine}) `
    : `${ref} (lines ${sel.fromLine}-${sel.toLine}) `
}
