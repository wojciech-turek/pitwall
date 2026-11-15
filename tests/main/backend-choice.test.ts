import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { chooseBackend, launcherChoice, readRecordedBackend, recordBackend, type BackendKind } from '../../src/main/backend'
import { hostAlive } from '../../src/main/host-backend'
import { hostPidFile, hostSocketPath } from '../../src/host/paths'

type Opts = Parameters<typeof chooseBackend>[0]
const base: Opts = { env: {}, platform: 'darwin', tmuxPath: '/usr/bin/tmux', recorded: null, liveSessions: 0, hostAlive: false }
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

test('no record but this data dir\'s host is running: its sessions are in the host, so the host (recorded) — never tmux beside it', () => {
  expect(choose({ recorded: null, liveSessions: 3, hostAlive: true })).toEqual({ kind: 'host', record: true })
  expect(choose({ recorded: null, liveSessions: 3, hostAlive: true, tmuxPath: null })).toEqual({ kind: 'host', record: true })
  // A record still wins, and with nothing live the usual choice stands.
  expect(choose({ recorded: 'tmux', liveSessions: 3, hostAlive: true })).toEqual({ kind: 'tmux', record: false })
  expect(choose({ recorded: null, liveSessions: 0, hostAlive: true })).toEqual({ kind: 'tmux', record: true })
  expect(choose({ recorded: null, liveSessions: 3, hostAlive: false })).toEqual({ kind: 'tmux', record: true })
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

test('hostAlive: a live pid in host.pid and a socket that answers; a stale pid file or a dead socket is not a host', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pw-hostalive-'))
  expect(await hostAlive(dir)).toBe(false) // no pid file
  const server = createServer((c) => c.destroy())
  await new Promise<void>((r) => server.listen(hostSocketPath(dir), r))
  try {
    expect(await hostAlive(dir)).toBe(false) // listening, but no pid file: not a host that finished starting
    await writeFile(hostPidFile(dir), `${process.pid}\n`)
    expect(await hostAlive(dir)).toBe(true)
    // A pid that is gone (the host crashed and left its file).
    const child = spawn(process.execPath, ['-e', ''])
    const dead = child.pid!
    await new Promise((r) => child.on('exit', r))
    await writeFile(hostPidFile(dir), `${dead}\n`)
    expect(await hostAlive(dir)).toBe(false)
    await writeFile(hostPidFile(dir), 'junk')
    expect(await hostAlive(dir)).toBe(false)
  } finally {
    await new Promise((r) => server.close(r))
  }
  await writeFile(hostPidFile(dir), `${process.pid}\n`)
  expect(await hostAlive(dir)).toBe(false) // nothing listens any more
})

test('recordBackend writes the choice; a failed write never leaves a record naming the other backend, so the next startup decides again', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pw-backend-'))
  const file = join(dir, 'backend.json')
  await recordBackend(file, 'host', null)
  expect(await readRecordedBackend(file)).toBe('host')
  const failing = async (): Promise<void> => { throw new Error('disk full') }
  // The same kind: the old record is still right, so it stays.
  await recordBackend(file, 'host', 'host', failing)
  expect(await readRecordedBackend(file)).toBe('host')
  // Another kind: the old record would be wrong next time, so it goes (the next startup sees none and asks the host).
  await writeFile(file, JSON.stringify({ kind: 'tmux' }))
  await recordBackend(file, 'host', 'tmux', failing)
  expect(await readFile(file, 'utf8').catch(() => null)).toBeNull()
})
