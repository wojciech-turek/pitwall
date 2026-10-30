// Prints the CHANGELOG.md body for one version: node scripts/release-notes.mjs 0.1.0
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Body of the `## [version]` section (without the heading, trimmed), or null if missing or empty. */
export function notesFor(changelog, version) {
  const lines = changelog.split(/\r?\n/)
  const start = lines.findIndex((l) => {
    const m = /^##\s+\[([^\]]+)\]/.exec(l)
    return m !== null && m[1] === version
  })
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i
      break
    }
  }
  const body = lines.slice(start + 1, end).join('\n').trim()
  return body === '' ? null : body
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2]
  if (!version) {
    console.error('usage: node scripts/release-notes.mjs <version>')
    process.exit(1)
  }
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  const notes = notesFor(changelog, version)
  if (notes === null) {
    console.error(`CHANGELOG.md has no "## [${version}]" section with content`)
    process.exit(1)
  }
  console.log(notes)
}
