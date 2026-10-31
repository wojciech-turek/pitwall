import { existsSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renameOver } from './atomic'
import type { AppPaths } from './paths'

function moduleDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url))
  } catch {
    return __dirname
  }
}

/** Packaged: <resourcesPath>/resources. Dev/test/build output: <repo>/resources (found by walking up to package.json). */
export function resourcesDir(): string {
  const rp = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (rp && existsSync(join(rp, 'resources', 'tmux.conf'))) return join(rp, 'resources')
  let dir = moduleDir()
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return join(dir, 'resources')
    const parent = dirname(dir)
    if (parent === dir) throw new Error('Could not locate the Pitwall resources directory')
    dir = parent
  }
}

/**
 * Unchanged files are left alone; changed ones are written beside the target and renamed over it. Never in place:
 * a running pitwall-launch is read by sh as it goes, and must keep seeing its old inode.
 */
async function installFile(src: string, dest: string, mode?: number): Promise<void> {
  const content = await readFile(src)
  const current = await readFile(dest).catch(() => null)
  if (!current?.equals(content)) {
    const tmp = `${dest}.${process.pid}.tmp`
    await writeFile(tmp, content)
    if (mode !== undefined) await chmod(tmp, mode)
    await renameOver(tmp, dest) // Windows: a hook may be reading the old script right now
  } else if (mode !== undefined) {
    await chmod(dest, mode)
  }
}

/** The scripts into the data dir's bin, and the tmux config beside them (not on Windows, which has no tmux). */
export async function installResources(
  paths: AppPaths, fromDir: string = resourcesDir(), platform: NodeJS.Platform = process.platform
): Promise<void> {
  await mkdir(paths.binDir, { recursive: true })
  for (const name of await readdir(join(fromDir, 'bin'))) {
    await installFile(join(fromDir, 'bin', name), join(paths.binDir, name), 0o755)
  }
  if (platform === 'win32') return
  await mkdir(dirname(paths.tmuxConf), { recursive: true })
  await installFile(join(fromDir, 'tmux.conf'), paths.tmuxConf)
}
