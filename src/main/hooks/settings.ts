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

/** Paths for Claude Code on Windows: forward slashes, which Git Bash, PowerShell and Windows itself all read alike. */
export const forwardSlashes = (p: string): string => p.replace(/\\/g, '/')

const POWERSHELL_FILE = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']

/**
 * Windows: the hook in exec form (`args`), which Claude Code starts with no shell, so paths with spaces or any
 * characters pass as they are. `powershell` is Windows PowerShell by its full path (a real .exe, as exec form needs).
 */
export function windowsHookCommand(powershell: string, script: string, eventsFile: string, sessionId: string): ExecCommand {
  return { command: forwardSlashes(powershell), args: [...POWERSHELL_FILE, forwardSlashes(script), forwardSlashes(eventsFile), sessionId] }
}

/**
 * A word that Git Bash and PowerShell both read as exactly `s` (Claude Code runs the status line in whichever it
 * has): single quotes, or double quotes when `s` has a single quote but nothing either shell expands inside double
 * quotes. Null when neither works.
 */
export function quoteForBashAndPowerShell(s: string): string | null {
  if (!/['\u2018\u2019\u201a\u201b]/.test(s)) return `'${s}'`
  if (!/["\u201c\u201d\u201e$`\\]/.test(s)) return `"${s}"`
  return null
}

/**
 * Windows: the status line has no exec form, so this is a command line meaning the same in Git Bash and PowerShell
 * (forward slashes, quoted for both). Undefined if a path can't be written that way: then there's no usage meter.
 */
export function windowsStatusLineCommand(script: string, sessionDir: string): string | undefined {
  const words = [forwardSlashes(script), forwardSlashes(sessionDir)].map(quoteForBashAndPowerShell)
  if (words.some((w) => w === null)) return undefined
  return ['powershell', ...POWERSHELL_FILE, ...words].join(' ')
}

/** Exec form: `command` is started with `args`, no shell. */
export interface ExecCommand { command: string; args: string[] }

type HookHandler = { type: 'command'; command: string; args?: string[]; timeout: number }
type HookList = { hooks: HookHandler[] }[]

/**
 * Seconds Claude Code gives a hook. The sh hook (macOS) is quick. The Windows one starts Windows PowerShell 5.1: half a
 * second when the PC is idle, but over 10 s was seen on a busy one, and a hook that times out loses its event and
 * prints an error in the user's terminal. It always ends with exit 0, so a longer limit only waits longer at worst.
 */
export const HOOK_TIMEOUT_SH = 10
export const HOOK_TIMEOUT_WINDOWS = 30

/** `command`: a shell command line (macOS), or exec form (Windows). */
export function buildHookSettings(command: string | ExecCommand, statusLineCommand?: string): {
  hooks: Record<string, HookList>
  statusLine?: { type: 'command'; command: string; padding: number }
} {
  const handler = (): HookHandler => typeof command === 'string'
    ? { type: 'command', command, timeout: HOOK_TIMEOUT_SH }
    : { type: 'command', command: command.command, args: [...command.args], timeout: HOOK_TIMEOUT_WINDOWS }
  const hooks: Record<string, HookList> = {}
  for (const e of HOOK_EVENTS) hooks[e] = [{ hooks: [handler()] }]
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
