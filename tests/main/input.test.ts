import { expect, test } from 'vitest'
import { isAnswerInput } from '../../src/main/sessions/input'

test('isAnswerInput', () => {
  for (const d of ['\x1b[I', '\x1b[O', '\x1b[?1;2c', '\x1b[12;40R', '\x1b]11;rgb:1717/1616/1515\x1b\\', '\x1b[A', '']) {
    expect(isAnswerInput(d), JSON.stringify(d)).toBe(false)
  }
  for (const d of ['\r', '1', 'y', 'abc\r']) expect(isAnswerInput(d), d).toBe(true)
})
