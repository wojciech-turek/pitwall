import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { exec } from '../../src/main/exec'
import { resolvePaths, type AppPaths } from '../../src/main/paths'
import { installResources } from '../../src/main/resources'
import { Tmux } from '../../src/main/tmux'
import { TmuxBackend } from '../../src/main/tmux-backend'
import { tmuxSocketPath } from './tmux-socket'

export { tmuxSocketPath }

const fixtures = resolve(__dirname, '..', 'fixtures', 'bin')

let counter = 0

export async function makeTestEnv(): Promise<{
  tmp: string
  paths: AppPaths
  env: Record<string, string>
  tmux: Tmux
  /** The same tmux server, as the app sees it. */
  backend: TmuxBackend
  cleanup(): Promise<void>
}> {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'pitwall-env-')))
  // Data dir deliberately contains a space, like "Application Support".
  const dataDir = join(tmp, 'App Support', 'pitwall')
  await mkdir(dataDir, { recursive: true })
  const socket = `pitwall-test-${process.pid}-${counter++}`
  const paths = resolvePaths(
    {
      PITWALL_DATA_DIR: dataDir,
      PITWALL_WORKTREES_DIR: join(tmp, 'worktrees'),
      PITWALL_SSH_DIR: join(tmp, 'ssh'),
      PITWALL_TMUX_SOCKET: socket,
      // Windows has no sh: the Node stubs, through their .cmd shims.
      PITWALL_CLAUDE_BIN: join(fixtures, process.platform === 'win32' ? 'claude.cmd' : 'claude'),
      PITWALL_GH_BIN: join(fixtures, process.platform === 'win32' ? 'gh.cmd' : 'gh')
    },
    tmp
  )
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.TMUX
  delete env.TMUX_PANE
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH' // `Path` on Windows
  env[pathKey] = `${fixtures}${delimiter}${env[pathKey] ?? '/usr/bin:/bin'}`
  env.HOME = tmp
  await installResources(paths)
  const tmux = new Tmux({ socket, confPath: paths.tmuxConf, env, exec })
  return {
    tmp,
    paths,
    env,
    tmux,
    backend: new TmuxBackend(tmux, env),
    async cleanup() {
      await tmux.killServer().catch(() => {})
      await rm(tmuxSocketPath(socket, env), { force: true })
      await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
}
