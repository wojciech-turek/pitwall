/** The last part of a path, whichever separator it uses (Windows paths, such as SSH keys, come with `\`). */
export function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}
