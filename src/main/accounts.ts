import { readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { claudeConfigDir } from './identity'
import type { Project } from '@shared/types'

/** A Claude account is identified by its config folder: the same folder, however spelled, is the same account. */
export function accountKey(project: Project, home: string, env: Record<string, string>): string {
  const dir = resolve(claudeConfigDir(project, home, env))
  const root = resolve(sep)
  return dir !== root && dir.endsWith(sep) ? dir.slice(0, -1) : dir
}

/** Each .claude.json's email, as of its mtime: the file is big and asked about often, so it's read only when it changes. */
const emails = new Map<string, { mtimeMs: number; email: string | null }>()

async function emailIn(file: string): Promise<string | null> {
  const mtimeMs = await stat(file).then((st) => st.mtimeMs, () => null)
  if (mtimeMs === null) {
    emails.delete(file)
    return null
  }
  const hit = emails.get(file)
  if (hit && hit.mtimeMs === mtimeMs) return hit.email
  let email: string | null = null
  try {
    const v = JSON.parse(await readFile(file, 'utf8'))?.oauthAccount?.emailAddress
    if (typeof v === 'string' && v) email = v
  } catch {
    // missing or corrupt: no email
  }
  emails.set(file, { mtimeMs, email })
  return email
}

/**
 * The signed-in email for an account, else its folder with home shown as ~. Claude keeps the default account's
 * profile at <home>/.claude.json (beside the folder), any other account's inside its folder. Read only.
 */
export async function accountLabel(key: string, home: string): Promise<string> {
  const file = key === resolve(join(home, '.claude')) ? join(home, '.claude.json') : join(key, '.claude.json')
  const email = await emailIn(file)
  if (email) return email
  const h = resolve(home)
  return key === h || key.startsWith(h + sep) ? join('~', key.slice(h.length)) : key
}
