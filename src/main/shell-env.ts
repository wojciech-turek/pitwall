import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { exec } from './exec'

const MARKER = '__PITWALL_ENV__'
const FALLBACK_LANG = 'en_US.UTF-8'

// Set by a Claude Code session in its children. Inherited from a parent Claude (e.g. `pnpm dev` run by an agent)
// they would make every session's claude think it is nested.
const NESTED_CLAUDE = /^(CLAUDECODE|CLAUDE_CODE_\w+|CLAUDE_PID)$/

function toRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v
  return out
}

function withoutNestedClaude(env: Record<string, string>): Record<string, string> {
  const out = { ...env }
  for (const k of Object.keys(out)) if (NESTED_CLAUDE.test(k)) delete out[k]
  return out
}

function fallback(base: Record<string, string>): Record<string, string> {
  const home = base.HOME ?? homedir()
  const extra = `/opt/homebrew/bin:/usr/local/bin:${home}/.local/bin`
  return { ...base, PATH: base.PATH ? `${extra}:${base.PATH}` : extra }
}

const isUtf8 = (v: string | undefined): boolean => !!v && /utf-?8/i.test(v)

/** `en_GB` → `en_GB.UTF-8`; `en_US@rg=plzzzz` → `en_US.UTF-8`; unknown or not installed → `en_US.UTF-8`. */
export function utf8LangFor(appleLocale: string | undefined, localeExists: (name: string) => boolean): string {
  const base = (appleLocale ?? '').trim().split('@')[0]
  if (!/^[A-Za-z]{2,3}(_[A-Za-z0-9]{2,4})?$/.test(base)) return FALLBACK_LANG
  const lang = `${base}.UTF-8`
  return localeExists(lang) ? lang : FALLBACK_LANG
}

async function readAppleLocale(env: Record<string, string>): Promise<string | undefined> {
  try {
    const r = await exec('/usr/bin/defaults', ['read', '-g', 'AppleLocale'], { env, timeoutMs: 5000 })
    return r.code === 0 ? r.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * Finder-launched apps get no LANG/LC_*; tmux clients and shells then assume ASCII and Claude's TUI turns into `_`.
 * Adds a UTF-8 LANG unless LC_ALL, LC_CTYPE or LANG already names UTF-8.
 */
async function ensureUtf8Locale(
  env: Record<string, string>,
  appleLocale: () => Promise<string | undefined>
): Promise<Record<string, string>> {
  if ([env.LC_ALL, env.LC_CTYPE, env.LANG].some(isUtf8)) return env
  const lang = utf8LangFor(await appleLocale(), (name) => existsSync(`/usr/share/locale/${name}`))
  return { ...env, LANG: lang }
}

async function parseShellEnv(shell: string, base: Record<string, string>, timeoutMs: number) {
  try {
    const r = await exec(shell, ['-ilc', `printf '\\n${MARKER}\\n'; /usr/bin/env -0`], { env: base, timeoutMs })
    if (r.code !== 0) return null
    const idx = r.stdout.lastIndexOf(`\n${MARKER}\n`)
    if (idx < 0) return null
    const env: Record<string, string> = {}
    for (const pair of r.stdout.slice(idx + MARKER.length + 2).split('\0')) {
      const eq = pair.indexOf('=')
      if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1)
    }
    return env.PATH ? env : null
  } catch {
    return null
  }
}

/**
 * Resolves the environment of the user's interactive login shell (Finder-launched apps get a minimal PATH).
 * Windows has no login shell: an app started from the Start menu already has the user's environment, so it is used
 * as it is. There the user's own CLAUDE_CODE_* settings (e.g. CLAUDE_CODE_GIT_BASH_PATH) arrive in that same
 * environment, so the nested-Claude markers are dropped only when a parent Claude set them (CLAUDECODE).
 */
export async function resolveShellEnv(
  o: {
    shell?: string
    base?: NodeJS.ProcessEnv
    timeoutMs?: number
    /** Test seam: the `defaults read -g AppleLocale` value. */
    appleLocale?: () => Promise<string | undefined>
    platform?: NodeJS.Platform
  } = {}
): Promise<Record<string, string>> {
  if ((o.platform ?? process.platform) === 'win32') {
    const env = toRecord(o.base ?? process.env)
    return Object.keys(env).some((k) => k.toUpperCase() === 'CLAUDECODE') ? withoutNestedClaude(env) : env
  }
  // Nested-Claude markers are dropped before the shell runs, so only values the user's own rc files set survive.
  const base = withoutNestedClaude(toRecord(o.base ?? process.env))
  const shell = o.shell ?? process.env.SHELL ?? '/bin/zsh'
  const env = (await parseShellEnv(shell, base, o.timeoutMs ?? 10000)) ?? fallback(base)
  delete env.TMUX
  delete env.TMUX_PANE
  delete env.CLAUDECODE
  delete env.CLAUDE_PID
  return ensureUtf8Locale(env, o.appleLocale ?? (() => readAppleLocale(env)))
}
