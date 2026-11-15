/**
 * The `pitwall` command a session runs (through resources/cli/pitwall): asks the running Pitwall, over the unix socket
 * in $PITWALL_CLI_SOCKET, to start, list, watch and message sessions. Runs under Node inside the app's asar, so it
 * imports only Node built-ins (no @shared, no other module): nothing but this file is bundled into it.
 */
import { readFileSync } from 'node:fs'
import { createConnection } from 'node:net'

export type Reply = { ok: true; [k: string]: unknown } | { ok: false; error: string }
export interface Request { cmd: string; args: Record<string, unknown> }
export type Parsed =
  | { help: true }
  | { error: string }
  | { cmd: string; json: boolean; request: Request; promptFile?: string }

export const USAGE = `Usage:
  pitwall new <title> [--prompt TEXT | --prompt-file PATH] [--branch NAME] [--base BRANCH] [--json]
      Start a session on its own branch and worktree, optionally with a first prompt.
  pitwall list [--json]
      Sessions in this folder.
  pitwall status <id> [--json]
      One session's status and last reply.
  pitwall wait <id> [--timeout SECONDS] [--json]
      Wait until the session finishes and print its reply. Exit codes: 0 finished, 3 needs you,
      4 exited, 124 timed out.
  pitwall send <id> <text...>
      Give a session you started a follow-up.
  pitwall --help

Exit codes: 0 ok, 1 error, 2 not in a Pitwall session, 3 needs you, 4 exited, 124 timeout.

\`pitwall wait\` blocks until the session finishes; give it a \`--timeout\` shorter than your command timeout and
run it again if it times out (exit 124).
`

const VALUE_FLAGS: Record<string, string[]> = {
  new: ['--prompt', '--prompt-file', '--branch', '--base'],
  wait: ['--timeout']
}

/** Splits argv into positionals and flags for one command; an unknown flag is an error. */
function split(cmd: string, argv: string[]): { pos: string[]; flags: Map<string, string | true> } | string {
  const valued = VALUE_FLAGS[cmd] ?? []
  const pos: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') flags.set('--json', true)
    else if (valued.includes(a)) {
      if (i + 1 >= argv.length) return `${a} needs a value.`
      flags.set(a, argv[++i])
    } else if (a.startsWith('--') && cmd !== 'send') return `Unknown option ${a}.`
    else pos.push(a)
  }
  return { pos, flags }
}

export function parseArgs(argv: string[]): Parsed {
  const [cmd, ...rest] = argv
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') return { help: true }
  if (!['new', 'list', 'status', 'wait', 'send'].includes(cmd)) return { error: `Unknown command ${cmd}. Run pitwall --help.` }
  const s = split(cmd, rest)
  if (typeof s === 'string') return { error: s }
  const { pos, flags } = s
  const json = flags.has('--json')
  const str = (f: string): string | undefined => { const v = flags.get(f); return typeof v === 'string' ? v : undefined }
  switch (cmd) {
    case 'new': {
      if (pos.length !== 1 || !pos[0].trim()) return { error: 'pitwall new needs a title: pitwall new "<title>" --prompt "<task>".' }
      if (flags.has('--prompt') && flags.has('--prompt-file')) return { error: 'Use --prompt or --prompt-file, not both.' }
      const args: Record<string, unknown> = { title: pos[0] }
      for (const [flag, key] of [['--prompt', 'prompt'], ['--branch', 'branch'], ['--base', 'base']] as const) {
        const v = str(flag)
        if (v !== undefined) args[key] = v
      }
      return { cmd, json, request: { cmd, args }, promptFile: str('--prompt-file') }
    }
    case 'list':
      if (pos.length) return { error: 'pitwall list takes no arguments.' }
      return { cmd, json, request: { cmd, args: {} } }
    case 'status':
    case 'wait': {
      if (pos.length !== 1) return { error: `pitwall ${cmd} needs a session id.` }
      const args: Record<string, unknown> = { id: pos[0] }
      const t = str('--timeout')
      if (t !== undefined) {
        const n = Number(t)
        if (!Number.isFinite(n) || n <= 0) return { error: '--timeout is a number of seconds.' }
        args.timeoutSec = n
      }
      return { cmd, json, request: { cmd, args } }
    }
    default: {
      if (pos.length < 2) return { error: 'pitwall send needs a session id and the text to send.' }
      return { cmd, json, request: { cmd, args: { id: pos[0], text: pos.slice(1).join(' ') } } }
    }
  }
}

/** The process exit code for a server reply (not-in-a-session, 2, is decided before any request is made). */
export function exitCodeFor(cmd: string, r: Reply): number {
  if (!r.ok) return /is still/.test(r.error) ? 124 : 1
  if (cmd === 'wait') return r.status === 'needs_you' ? 3 : r.status === 'exited' ? 4 : 0
  return 0
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '')

/** What a reply looks like to a person. */
export function render(cmd: string, r: Reply & { ok: true }): { out: string; err?: string } {
  switch (cmd) {
    case 'new': {
      const where = r.branch ? ` on branch ${text(r.branch)} in ${text(r.worktree)}` : r.worktree ? ` in ${text(r.worktree)}` : ''
      return { out: `Started "${text(r.title)}" (${text(r.id)})${where}` }
    }
    case 'list': {
      const rows = Array.isArray(r.sessions) ? (r.sessions as Array<Record<string, unknown>>) : []
      if (!rows.length) return { out: 'No sessions.' }
      return { out: rows.map((s) => [text(s.id), text(s.title), text(s.status), text(s.branch)].join('  ').trimEnd()).join('\n') }
    }
    case 'status':
      return { out: [`${text(r.id)}  ${text(r.title)}  ${text(r.status)}`, text(r.lastMessage)].filter(Boolean).join('\n') }
    case 'wait': {
      const note = r.status === 'needs_you' ? 'The session is waiting for the user.'
        : r.status === 'exited' ? 'The session has exited.' : undefined
      return { out: text(r.lastMessage), err: note }
    }
    default:
      return { out: 'Sent.' }
  }
}

/** One JSON line out, one back, then the server ends the connection. */
function request(socket: string, line: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const c = createConnection(socket)
    let buf = ''
    c.setEncoding('utf8')
    c.on('connect', () => c.write(line + '\n'))
    c.on('data', (d: string) => { buf += d })
    c.on('error', (e) => reject(new Error(`Couldn't reach Pitwall (${e.message}). Is it running?`)))
    c.on('close', () => {
      try {
        resolve(JSON.parse(buf.split('\n')[0]) as Reply)
      } catch {
        reject(new Error('Pitwall gave no answer.'))
      }
    })
  })
}

async function main(argv: string[]): Promise<number> {
  const p = parseArgs(argv)
  if ('help' in p) { process.stdout.write(USAGE); return 0 }
  if ('error' in p) { process.stderr.write(`pitwall: ${p.error}\n`); return 1 }
  const { PITWALL_SESSION_ID: session, PITWALL_CLI_SOCKET: socket, PITWALL_CLI_TOKEN: token } = process.env
  if (!session || !socket || !token) { process.stderr.write('pitwall: run this inside a Pitwall session.\n'); return 2 }
  try {
    if (p.promptFile !== undefined) p.request.args.prompt = readFileSync(p.promptFile, 'utf8')
    const r = await request(socket, JSON.stringify({ v: 1, session, token, cmd: p.request.cmd, args: p.request.args }))
    if (p.json) {
      process.stdout.write(JSON.stringify(r) + '\n')
    } else if (r.ok) {
      const { out, err } = render(p.cmd, r)
      if (out) process.stdout.write(out + '\n')
      if (err) process.stderr.write(`pitwall: ${err}\n`)
    } else {
      process.stderr.write(`pitwall: ${r.error}\n`)
    }
    return exitCodeFor(p.cmd, r)
  } catch (e) {
    process.stderr.write(`pitwall: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
}

if (!process.env.VITEST) void main(process.argv.slice(2)).then((code) => process.exit(code))
