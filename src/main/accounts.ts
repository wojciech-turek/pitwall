import { readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { claudeConfigDir } from './identity'
import type { Project } from '@shared/types'

/** A Claude account is identified by its config folder: the same folder, however spelled, is the same account. */
export function accountKey(project: Project, home: string, env: Record<string, string>): string {
  const dir = resolve(claudeConfigDir(project, home, env))
  const root = resolve(sep)
  return dir !== root && dir.endsWith(sep) ? dir.slice(0, -1) : dir
}

/**
 * The signed-in email for an account, else its folder with home shown as ~. Claude keeps the default account's
 * profile at <home>/.claude.json (beside the folder), any other account's inside its folder. Read only.
 */
export async function accountLabel(key: string, home: string): Promise<string> {
  const file = key === resolve(join(home, '.claude')) ? join(home, '.claude.json') : join(key, '.claude.json')
  try {
    const email = JSON.parse(await readFile(file, 'utf8'))?.oauthAccount?.emailAddress
    if (typeof email === 'string' && email) return email
  } catch {
    // missing or corrupt: fall through to the folder name
  }
  const h = resolve(home)
  return key === h || key.startsWith(h + sep) ? join('~', key.slice(h.length)) : key
}
