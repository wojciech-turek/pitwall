import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { chooseBackend, launcherChoice, readRecordedBackend, type BackendKind } from '../../src/main/backend'

type Opts = Parameters<typeof chooseBackend>[0]
const base: Opts = { env: {}, platform: 'darwin', tmuxPath: '/usr/bin/tmux', recorded: null, liveSessions: 0 }
const choose = (o: Partial<Opts>) => chooseBackend({ ...base, ...o })

test('Windows is always the host, recorded nothing', () => {
  expect(choose({ platform: 'win32' })).toEqual({ kind: 'host', record: false })
  expect(choose({ platform: 'win32', env: { PITWALL_SESSION_BACKEND: 'tmux' }, recorded: 'tmux', liveSessions: 3 }))
    .toEqual({ kind: 'host', record: false })
})

test('the env override wins on macOS and records nothing', () => {
  expect(choose({ env: { PITWALL_SESSION_BACKEND: 'host' }, recorded: 'tmux', liveSessions: 2 })).toEqual({ kind: 'host', record: false })
  expect(choose({ env: { PITWALL_SESSION_BACKEND: 'tmux' }, tmuxPath: null })).toEqual({ kind: 'tmux', record: false })
})

test('a recorded kind with live sessions is kept, even if tmux appeared or vanished', () => {
  expect(choose({ recorded: 'host', liveSessions: 1 })).toEqual({ kind: 'host', record: false })
  expect(choose({ recorded: 'tmux', liveSessions: 1, tmuxPath: null })).toEqual({ kind: 'tmux', record: false })
})

test('tmux found: tmux, recorded (also when the record was host but nothing is live)', () => {
  expect(choose({})).toEqual({ kind: 'tmux', record: true })
  expect(choose({ recorded: 'host', liveSessions: 0 })).toEqual({ kind: 'tmux', record: true })
})

test('no tmux and nothing to keep: the host, recorded', () => {
  expect(choose({ tmuxPath: null })).toEqual({ kind: 'host', record: true })
  expect(choose({ tmuxPath: null, recorded: 'tmux', liveSessions: 0 })).toEqual({ kind: 'host', record: true })
})

test('first launch with live sessions but no record (an installed app before backend.json) chooses tmux', () => {
  expect(choose({ recorded: null, liveSessions: 5 })).toEqual({ kind: 'tmux', record: true })
})

test('sessions from before backend.json (no record) stay on tmux even when no tmux is found', () => {
  expect(choose({ recorded: null, liveSessions: 2, tmuxPath: null })).toEqual({ kind: 'tmux', record: true })
})

test('tmux uninstalled while tmux sessions run: still tmux, with no path (it fails per session, startup does not)', () => {
  expect(choose({ tmuxPath: null, recorded: 'tmux', liveSessions: 4 })).toEqual({ kind: 'tmux', record: false })
})

test('the launcher stays the script on macOS when the host is only the fallback', () => {
  expect(launcherChoice({})).toBe('script')
  expect(launcherChoice({ PITWALL_LAUNCHER: 'host' }, 'darwin')).toBe('script')
  expect(launcherChoice({ PITWALL_SESSION_BACKEND: 'host', PITWALL_LAUNCHER: 'host' }, 'darwin')).toBe('host')
  expect(launcherChoice({}, 'win32')).toBe('host')
})

let dir = ''
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = '' })

test('reading backend.json is tolerant', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pw-backend-'))
  const file = join(dir, 'backend.json')
  expect(await readRecordedBackend(file)).toBeNull()
  const cases: Array<[string, BackendKind | null]> = [
    ['{ "kind": "tmux" }', 'tmux'], ['{ "kind": "host" }', 'host'],
    ['{ "kind": "screen" }', null], ['not json', null], ['null', null], ['[]', null], ['', null]
  ]
  for (const [text, want] of cases) {
    await writeFile(file, text)
    expect(await readRecordedBackend(file)).toBe(want)
  }
})
