import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { configDefaults, defineConfig } from 'vitest/config'

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
const WINDOWS = process.platform === 'win32'

/**
 * Suites for the macOS side only, which Windows can't run: it has no tmux, sh or ps. They stay as they are and run
 * everywhere else. What they check on macOS, Windows checks with the host suites (tests/host: the host, its launcher
 * and the app's relaunch path, with the Node stubs) and tests/main/windows-*.test.ts. Files that mix both skip their
 * POSIX tests with `skipIf(WINDOWS)` (tests/helpers/processes.ts).
 */
const POSIX_ONLY = [
  'tests/main/tmux.test.ts', // tmux itself
  'tests/main/backend-contract.test.ts', // the contract on tmux (tests/host/backend-contract.test.ts: on the host)
  'tests/main/launcher.test.ts', // pitwall-launch and pitwall-shell (sh) in tmux (Windows: tests/host/launcher*.test.ts)
  'tests/main/hook-script.test.ts', // the sh hook (Windows: windows-scripts.test.ts)
  'tests/main/statusline-script.test.ts', // the sh status line (Windows: windows-scripts.test.ts)
  'tests/main/manager.test.ts', // sessions in tmux (Windows: tests/host/relaunch.test.ts runs the manager on the host)
  'tests/main/archive.test.ts', // sessions in tmux, teardown in sh (Windows: windows-only, windows-platform)
  'tests/main/resume.test.ts', // sessions in tmux
  'tests/main/identity.test.ts', // macOS's ssh command and env.sh, the sh gh stub (Windows: windows-platform)
  'tests/main/leftovers.test.ts', // ps (Windows: windows-platform, windows-only)
  'tests/main/paths.test.ts', // macOS paths (Windows: windows-platform)
  'tests/host/launcher-host.test.ts' // sh hooks and stubs run directly, ps, /bin/sh (Windows: relaunch, the e2e suite)
]

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: {
    environment: 'node',
    // Windows starts processes (PowerShell above all) several times slower.
    testTimeout: WINDOWS ? 40000 : 20000,
    hookTimeout: WINDOWS ? 30000 : 10000,
    include: ['tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...(WINDOWS ? POSIX_ONLY : [])],
    globalSetup: ['tests/helpers/build-host.ts']
  }
})
