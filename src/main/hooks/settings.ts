import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { shellQuote } from '../identity'

export const HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse',
  'PostToolUseFailure', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'
] as const

export function hookCommandFor(hookBin: string, eventsFile: string, sessionId: string): string {
  return [hookBin, eventsFile, sessionId].map(shellQuote).join(' ')
}

export function statusLineCommandFor(statusLineBin: string, sessionDir: string): string {
  return [statusLineBin, sessionDir].map(shellQuote).join(' ')
}

type HookList = { hooks: { type: 'command'; command: string; timeout: number }[] }[]

export function buildHookSettings(command: string, statusLineCommand?: string): {
  hooks: Record<string, HookList>
  statusLine?: { type: 'command'; command: string; padding: number }
} {
  const hooks: Record<string, HookList> = {}
  for (const e of HOOK_EVENTS) hooks[e] = [{ hooks: [{ type: 'command', command, timeout: 10 }] }]
  if (!statusLineCommand) return { hooks }
  return { hooks, statusLine: { type: 'command', command: statusLineCommand, padding: 0 } }
}

async function statusLineIn(file: string): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as { statusLine?: { type?: unknown; command?: unknown } } | null
    const sl = raw?.statusLine
    if (sl?.type === 'command' && typeof sl.command === 'string' && sl.command.trim()) return sl.command
  } catch {
    // missing or unreadable: not configured here
  }
  return undefined
}

/**
 * The status line the user's Claude would show in this folder, highest precedence first. Only read: Pitwall's own
 * --settings would otherwise hide it, so pitwall-statusline runs it.
 */
export async function findUserStatusLine(cwd: string, claudeConfigDir: string): Promise<string | undefined> {
  const files = [
    join(cwd, '.claude', 'settings.local.json'),
    join(cwd, '.claude', 'settings.json'),
    join(claudeConfigDir, 'settings.json')
  ]
  for (const f of files) {
    const command = await statusLineIn(f)
    if (command) return command
  }
  return undefined
}
