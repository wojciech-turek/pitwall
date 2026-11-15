/**
 * Text from outside Pitwall (a PR comment, a check's name, a review note or quote) that is about to be pasted into
 * Claude's prompt, with its control characters dropped: only tabs and newlines stay. ESC could otherwise end the
 * bracketed paste or act as a key, and a CR could press Enter.
 */
export function plainText(s: string): string {
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}
