import { describe, expect, test } from 'vitest'
import { exitCodeFor, parseArgs, USAGE } from '../../src/cli/index'

describe('pitwall client: parseArgs', () => {
  test('new: title, prompt, branch, base, json', () => {
    expect(parseArgs(['new', 'Fix login', '--prompt', 'Do it', '--branch', 'b', '--base', 'main', '--json'])).toEqual({
      cmd: 'new', json: true, request: { cmd: 'new', args: { title: 'Fix login', prompt: 'Do it', branch: 'b', base: 'main' } }
    })
  })
  test('new: --prompt-file is read by the caller, so it comes back as a path', () => {
    expect(parseArgs(['new', 'T', '--prompt-file', '/tmp/p.txt'])).toMatchObject({ promptFile: '/tmp/p.txt' })
  })
  test('new needs a title; prompt and prompt-file are exclusive', () => {
    expect(parseArgs(['new'])).toMatchObject({ error: expect.stringContaining('title') })
    expect(parseArgs(['new', 'T', '--prompt', 'a', '--prompt-file', 'b'])).toMatchObject({ error: expect.stringContaining('--prompt') })
  })
  test('wait takes seconds', () => {
    expect(parseArgs(['wait', 's_1', '--timeout', '30'])).toMatchObject({ request: { cmd: 'wait', args: { id: 's_1', timeoutSec: 30 } } })
    expect(parseArgs(['wait', 's_1', '--timeout', 'x'])).toMatchObject({ error: expect.any(String) })
    expect(parseArgs(['wait'])).toMatchObject({ error: expect.any(String) })
  })
  test('send joins the rest as text', () => {
    expect(parseArgs(['send', 's_1', 'keep', 'going'])).toMatchObject({ request: { cmd: 'send', args: { id: 's_1', text: 'keep going' } } })
    expect(parseArgs(['send', 's_1'])).toMatchObject({ error: expect.any(String) })
  })
  test('list, status, help, unknown, unknown flag', () => {
    expect(parseArgs(['list', '--json'])).toMatchObject({ json: true, request: { cmd: 'list', args: {} } })
    expect(parseArgs(['status', 's_1'])).toMatchObject({ request: { cmd: 'status', args: { id: 's_1' } } })
    expect(parseArgs(['--help'])).toEqual({ help: true })
    expect(parseArgs([])).toEqual({ help: true })
    expect(parseArgs(['nope'])).toMatchObject({ error: expect.stringContaining('nope') })
    expect(parseArgs(['list', '--wat'])).toMatchObject({ error: expect.stringContaining('--wat') })
  })
  test('--help says how to wait without hitting the caller\'s own command timeout', () => {
    expect(USAGE.replace(/\s+/g, ' ')).toContain('`pitwall wait` blocks until the session finishes; give it a `--timeout` shorter than your command timeout and run it again if it times out (exit 124).')
  })
})

describe('pitwall client: exitCodeFor', () => {
  test('wait: needs_you 3, exited 4, finished 0', () => {
    expect(exitCodeFor('wait', { ok: true, status: 'needs_you' })).toBe(3)
    expect(exitCodeFor('wait', { ok: true, status: 'exited' })).toBe(4)
    expect(exitCodeFor('wait', { ok: true, status: 'unread' })).toBe(0)
  })
  test('errors: a timeout is 124, anything else 1', () => {
    expect(exitCodeFor('wait', { ok: false, error: 'Fix login is still working' })).toBe(124)
    expect(exitCodeFor('wait', { ok: false, error: 'Fix login was archived.' })).toBe(1)
    expect(exitCodeFor('new', { ok: false, error: 'x' })).toBe(1)
  })
  test('other commands: ok is 0, even with a status field', () => {
    expect(exitCodeFor('status', { ok: true, status: 'exited' })).toBe(0)
    expect(exitCodeFor('new', { ok: true })).toBe(0)
  })
})
