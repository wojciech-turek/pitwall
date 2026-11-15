import { describe, expect, test } from 'vitest'
import { formatReview } from '../../src/shared/review-text'
import type { ReviewComment } from '../../src/shared/types'

const c = (o: Partial<ReviewComment>): ReviewComment => ({ id: 'x', path: 'src/a.ts', fromLine: 1, toLine: 1, quote: 'q', note: 'n', ...o })

describe('formatReview', () => {
  test('two comments', () => {
    const text = formatReview([
      c({ path: 'src/a.ts', fromLine: 12, toLine: 14, quote: 'const x = 1', note: 'Rename x to count.' }),
      c({ path: 'docs/my file.md', fromLine: 3, toLine: 3, quote: 'Hello', note: 'Typo.' })
    ])
    expect(text).toBe(
      'Review of your changes (2 comments):\n\n' +
      '1. @src/a.ts (lines 12-14)\n   > const x = 1\n   Rename x to count.\n\n' +
      '2. @"docs/my file.md" (line 3)\n   > Hello\n   Typo.\n\n' +
      'Please address each comment, then say briefly what you changed.'
    )
  })

  test('one comment is singular; quote and note lines are each indented', () => {
    const text = formatReview([c({ quote: 'a\nb', note: 'first\nsecond' })])
    expect(text).toBe(
      'Review of your changes (1 comment):\n\n' +
      '1. @src/a.ts (line 1)\n   > a\n   > b\n   first\n   second\n\n' +
      'Please address each comment, then say briefly what you changed.'
    )
  })

  test('Windows paths use forward slashes', () => {
    expect(formatReview([c({ path: 'src\\a.ts' })], 'win32')).toContain('1. @src/a.ts (line 1)\n')
  })

  test('control characters in the quote or note are dropped (tabs and newlines stay), so the paste can never press keys', () => {
    const text = formatReview([c({ quote: 'a\x1b[201~\r\tb', note: 'go\x1b\x7f\x08\nnow' })])
    expect(text).toContain('   > a[201~\tb\n   go\n   now\n')
    expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/)
  })

  test('nothing to say gives an empty string', () => {
    expect(formatReview([])).toBe('')
  })
})
