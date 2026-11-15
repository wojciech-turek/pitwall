import { copyFile, lstat, mkdir, readFile, readdir, rm, stat, symlink, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { writeFileAtomic } from './atomic'
import { normalizeDir, profileFile } from './accounts'

export { profileFile }

/**
 * The folder of a Claude account added in Pitwall: `<data dir>/claude-accounts/<id>`, passed to Claude as
 * CLAUDE_CONFIG_DIR. Claude Code keeps the account's login there itself (Pitwall never reads or copies one). What the
 * account shares with the default folder is linked to it, so an account differs only in who pays. Nothing here
 * writes into the default folder.
 */

/** Folders linked to the default account's: the history (so a conversation resumes on another account) and extensions. */
export const LINKED_DIRS = ['projects', 'todos', 'plans', 'file-history', 'shell-snapshots', 'commands', 'agents', 'skills', 'plugins']
/** Files linked to the default account's (copied on Windows, where a file link needs privileges). */
export const LINKED_FILES = ['settings.json', 'CLAUDE.md', 'keybindings.json']
/** What a new account's profile takes from the default one: user-level MCP servers and "onboarding is done". */
export const PROFILE_KEYS = ['mcpServers', 'hasCompletedOnboarding', 'lastOnboardingVersion']
/** Who is signed in: never copied from one account to another, whatever is asked. */
const NEVER_COPIED = new Set(['oauthAccount', 'userID', 'projects'])

type Symlink = (target: string, path: string, type?: 'dir' | 'file' | 'junction') => Promise<void>
type Json = Record<string, unknown>

/** Makes `<root>/<id>`, private to the user, and returns its one spelling. */
export async function createAccountFolder(root: string, id: string): Promise<string> {
  const dir = join(root, id)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return normalizeDir(dir, dir)
}

const exists = (p: string): Promise<boolean> => lstat(p).then(() => true, () => false)

/**
 * Links each shared item that exists in the default folder into the account's. Safe to run again: an item already
 * there (a link, or something real) is left alone, and one that has appeared in the default folder since is added.
 */
export async function linkShared(
  dir: string, defaultDir: string, platform: NodeJS.Platform = process.platform, link: Symlink = symlink
): Promise<void> {
  const windows = platform === 'win32'
  for (const name of LINKED_DIRS) {
    const target = join(defaultDir, name)
    if (!(await stat(target).then((s) => s.isDirectory(), () => false)) || (await exists(join(dir, name)))) continue
    await link(target, join(dir, name), windows ? 'junction' : 'dir')
  }
  for (const name of LINKED_FILES) {
    const target = join(defaultDir, name)
    if (!(await stat(target).then((s) => s.isFile(), () => false)) || (await exists(join(dir, name)))) continue
    if (windows) await copyFile(target, join(dir, name))
    else await link(target, join(dir, name), 'file')
  }
}

async function readJson(file: string): Promise<Json | null | 'corrupt'> {
  const text = await readFile(file, 'utf8').catch(() => null)
  if (text === null) return null
  try {
    const v: unknown = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : 'corrupt'
  } catch {
    return 'corrupt'
  }
}

/** Reads both profiles and saves what `merge` makes of them. A source that can't be read, or a corrupt destination, changes nothing. */
async function mergeProfile(fromFile: string, toFile: string, merge: (from: Json, to: Json) => boolean): Promise<void> {
  const from = await readJson(fromFile)
  const to = await readJson(toFile)
  if (from === null || from === 'corrupt' || to === 'corrupt') return
  const next = { ...(to ?? {}) }
  if (!merge(from, next)) return
  await mkdir(dirname(toFile), { recursive: true })
  await writeFileAtomic(toFile, JSON.stringify(next, null, 2) + '\n', 0o600)
}

/** Copies only the named top-level keys (never the signed-in profile) from one account's profile into another's. */
export function copyProfileKeys(fromFile: string, toFile: string, keys: readonly string[]): Promise<void> {
  return mergeProfile(fromFile, toFile, (from, to) => {
    let changed = false
    for (const k of keys) {
      if (NEVER_COPIED.has(k) || !(k in from)) continue
      to[k] = from[k]
      changed = true
    }
    return changed
  })
}

/** Copies one folder's entry (folder trust, its allowed tools, its MCP choices), so a moved session isn't asked again. */
export function copyProjectEntry(fromFile: string, toFile: string, cwd: string): Promise<void> {
  return mergeProfile(fromFile, toFile, (from, to) => {
    const entry = (from.projects as Json | undefined)?.[cwd]
    if (entry === undefined) return false
    const projects = to.projects && typeof to.projects === 'object' && !Array.isArray(to.projects) ? (to.projects as Json) : {}
    to.projects = { ...projects, [cwd]: entry }
    return true
  })
}

/** Deletes an account's folder. Its links are removed as links: what they point at (the default folder) is never followed. */
export async function removeAccountFolder(dir: string, root: string): Promise<void> {
  const d = resolve(dir)
  if (dirname(d) !== resolve(root)) throw new Error(`${dir} is not an account folder.`)
  const entries = await readdir(d, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    // A junction (Windows) or symlink: unlink it; rm -r of a junction on some Node versions walks into its target.
    const st = await lstat(join(d, e.name)).catch(() => null)
    if (st?.isSymbolicLink()) await unlink(join(d, e.name)).catch(() => rm(join(d, e.name), { force: true }))
  }
  await rm(d, { recursive: true, force: true })
}
