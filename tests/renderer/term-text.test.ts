import { expect, test } from 'vitest'
import { plainText } from '../../src/renderer/src/terminal/plain-text'

test('error text written into a terminal keeps its words and line breaks, and loses every control character', () => {
  const hostile = 'boom \x1b]52;c;ZXZpbA==\x07 \x1b[2J\x1b[31mred\x1b[0m\r\tx\x9b31m\x00\x7f\nnext line'
  const out = plainText(hostile)
  expect(out).toBe('boom ]52;c;ZXZpbA== [2J[31mred[0mx31m\nnext line')
  expect(out).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/)
  expect(plainText('Session folder not found: /Users/zoë/My Repo ❯')).toBe('Session folder not found: /Users/zoë/My Repo ❯')
})
