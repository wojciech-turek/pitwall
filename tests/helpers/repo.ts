import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export function gitTestEnv(tmp: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return { ...env, GIT_CONFIG_GLOBAL: join(tmp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
}

export async function makeRepo(
  o: { commits?: boolean; remote?: boolean; dirName?: string } = {}
): Promise<{ root: string; remote?: string; env: Record<string, string>; cleanup(): Promise<void> }> {
  const commits = o.commits ?? true
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'pitwall-git-')))
  await writeFile(join(tmp, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n')
  const env = gitTestEnv(tmp)
  const git = (cwd: string, ...args: string[]) => run('git', args, { cwd, env })
  const root = join(tmp, o.dirName ?? 'repo')
  await mkdir(root, { recursive: true })
  await git(root, 'init', '-b', 'main')
  if (commits) {
    await writeFile(join(root, 'README.md'), '# test\n')
    await git(root, 'add', '-A')
    await git(root, 'commit', '-m', 'initial')
  }
  let remote: string | undefined
  if (o.remote) {
    remote = join(tmp, 'remote.git')
    await git(tmp, 'init', '--bare', '-b', 'main', remote)
    await git(root, 'remote', 'add', 'origin', remote)
    if (commits) await git(root, 'push', '-u', 'origin', 'main')
  }
  return { root, remote, env, cleanup: () => rm(tmp, { recursive: true, force: true }) }
}
