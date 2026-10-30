/**
 * Whether pty input looks like the user answering a prompt. Terminal-generated
 * sequences (focus-in/out, device attribute and cursor position replies, OSC
 * replies, arrow keys) start with ESC and must not count.
 */
export function isAnswerInput(data: string): boolean {
  if (!data || data.startsWith('\x1b')) return false
  return data.includes('\r') || ([...data].length === 1 && data >= ' ' && data !== '\x7f')
}
