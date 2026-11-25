import { expect, test } from 'vitest'
import { clipboardProvider } from '../../src/renderer/src/terminal/clipboard'

const fake = (held = 'secret') => {
  const written: string[] = []
  return { written, clip: { readText: async () => held, writeText: async (t: string) => { written.push(t) } } }
}

test("a clipboard write that names no selection (tmux's) or names the clipboard is copied; other selections are not", async () => {
  const { written, clip } = fake()
  const p = clipboardProvider(clip)
  await p.writeText('', 'from tmux')
  await p.writeText('c', 'named')
  await p.writeText('pc', 'primary and clipboard')
  await p.writeText('p', 'primary only')
  await p.writeText('s', 'select only')
  expect(written).toEqual(['from tmux', 'named', 'primary and clipboard'])
})

test('a program reads the clipboard only by asking for it by name', async () => {
  const p = clipboardProvider(fake().clip)
  expect(await p.readText('c')).toBe('secret')
  expect(await p.readText('')).toBe('')
  expect(await p.readText('p')).toBe('')
})
