import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM script without types
import { notesFor } from '../../scripts/release-notes.mjs'

const log = `# Changelog

Intro line.

## [0.3.0] - 2026-12-01

### Added

- Three

## [0.2.0] - 2026-11-01

- Two

## [0.1.0-beta] - 2026-10-01

- Beta

## [10.1.0] - 2026-09-01

- Ten

## [0.1.0] - 2026-10-30

- One
- Last
`

describe('notesFor', () => {
  it('finds a middle section without heading, trimmed', () => {
    expect(notesFor(log, '0.2.0')).toBe('- Two')
  })
  it('finds the first section including subheadings', () => {
    expect(notesFor(log, '0.3.0')).toBe('### Added\n\n- Three')
  })
  it('finds the last section', () => {
    expect(notesFor(log, '0.1.0')).toBe('- One\n- Last')
  })
  it('returns null when missing', () => {
    expect(notesFor(log, '9.9.9')).toBeNull()
  })
  it('does not match prefixes or suffixes of other versions', () => {
    const only = '## [0.1.0-beta] - x\n\n- a\n\n## [10.1.0] - y\n\n- b\n'
    expect(notesFor(only, '0.1.0')).toBeNull()
  })
  it('returns null for an empty section', () => {
    expect(notesFor('## [1.0.0] - x\n\n## [0.9.0] - y\n- a', '1.0.0')).toBeNull()
  })
})
