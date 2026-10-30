/**
 * Text from elsewhere (an error message) made safe to write into a terminal: control characters other than line
 * feeds are dropped, so it can't carry escape sequences (colours, cursor moves, OSC 52 clipboard writes…).
 */
export function plainText(s: string): string {
  return s.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '')
}
