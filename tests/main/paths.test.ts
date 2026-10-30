import { expect, test } from 'vitest'
import { eventsFile, resolvePaths } from '../../src/main/paths'

test('defaults', () => {
  const p = resolvePaths({}, '/Users/w')
  expect(p.dataDir).toBe('/Users/w/Library/Application Support/pitwall')
  expect(p.stateFile).toBe('/Users/w/Library/Application Support/pitwall/state.json')
  expect(p.usageFile).toBe('/Users/w/Library/Application Support/pitwall/usage.json')
  expect(p.sessionsDir).toBe('/Users/w/Library/Application Support/pitwall/sessions')
  expect(p.binDir).toBe('/Users/w/Library/Application Support/pitwall/bin')
  expect(p.tmuxConf).toBe('/Users/w/Library/Application Support/pitwall/tmux.conf')
  expect(p.worktreesRoot).toBe('/Users/w/pitwall/worktrees')
  expect(p.sshDir).toBe('/Users/w/.ssh')
  expect(p).toMatchObject({ tmuxSocket: 'pitwall', claudeBin: 'claude', ghBin: 'gh', notificationsDisabled: false })
})

test('env overrides', () => {
  const p = resolvePaths(
    {
      PITWALL_DATA_DIR: '/t/d', PITWALL_WORKTREES_DIR: '/t/w', PITWALL_TMUX_SOCKET: 's1',
      PITWALL_CLAUDE_BIN: '/t/claude', PITWALL_GH_BIN: '/t/gh', PITWALL_SSH_DIR: '/t/ssh',
      PITWALL_TEST_PICK_FOLDER: '/t/repo', PITWALL_DISABLE_NOTIFICATIONS: '1'
    },
    '/Users/w'
  )
  expect(p).toMatchObject({
    dataDir: '/t/d', stateFile: '/t/d/state.json', worktreesRoot: '/t/w', tmuxSocket: 's1',
    claudeBin: '/t/claude', ghBin: '/t/gh', sshDir: '/t/ssh', testPickFolder: '/t/repo', notificationsDisabled: true
  })
  expect(eventsFile(p, 's_abc')).toBe('/t/d/sessions/s_abc/events.jsonl')
})

test('dev (unpackaged) build defaults to separate data dir, socket and worktrees', () => {
  const p = resolvePaths({}, '/Users/w', { dev: true })
  expect(p.dataDir).toBe('/Users/w/Library/Application Support/pitwall-dev')
  expect(p.stateFile).toBe('/Users/w/Library/Application Support/pitwall-dev/state.json')
  expect(p.binDir).toBe('/Users/w/Library/Application Support/pitwall-dev/bin')
  expect(p.tmuxSocket).toBe('pitwall-dev')
  expect(p.worktreesRoot).toBe('/Users/w/pitwall/worktrees-dev')
  expect(resolvePaths({}, '/Users/w', { dev: false })).toMatchObject({
    dataDir: '/Users/w/Library/Application Support/pitwall', tmuxSocket: 'pitwall', worktreesRoot: '/Users/w/pitwall/worktrees'
  })
})

test('explicit overrides win over the dev defaults', () => {
  const p = resolvePaths({ PITWALL_DATA_DIR: '/t/d', PITWALL_WORKTREES_DIR: '/t/w', PITWALL_TMUX_SOCKET: 's1' }, '/Users/w', { dev: true })
  expect(p).toMatchObject({ dataDir: '/t/d', worktreesRoot: '/t/w', tmuxSocket: 's1' })
})
