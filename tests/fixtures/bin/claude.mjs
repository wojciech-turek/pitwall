#!/usr/bin/env node
// Stub Claude CLI for tests, in Node: the same behaviour as tests/fixtures/bin/claude (sh), for Windows, which has no
// sh (claude.cmd runs it there). Hooks run as Claude Code runs them: exec form (`args`) with no shell; shell form in
// sh, or on Windows in Git Bash if there is one, else PowerShell.
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const env = process.env
const args = process.argv.slice(2)

if (env.STUB_CLAUDE_LOG) {
  appendFileSync(env.STUB_CLAUDE_LOG, [
    args.join(' '),
    `GH_TOKEN=${env.GH_TOKEN ?? ''}`,
    `GH_CONFIG_DIR=${env.GH_CONFIG_DIR ?? ''}`,
    `GIT_AUTHOR_EMAIL=${env.GIT_AUTHOR_EMAIL ?? ''}`,
    `GIT_SSH_COMMAND=${env.GIT_SSH_COMMAND ?? ''}`
  ].join('\n') + '\n')
}
// The whole environment Claude started with, when a test asks for it.
if (env.STUB_CLAUDE_ENV_FILE) {
  writeFileSync(env.STUB_CLAUDE_ENV_FILE, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
}

let settings = ''
let id = ''
for (let i = 0; i + 1 < args.length; i++) {
  if (args[i] === '--settings') settings = args[i + 1]
  if (args[i] === '--session-id' || args[i] === '--resume') id = args[i + 1]
}
if (args.includes('--resume')) {
  if (env.STUB_CLAUDE_RESUME_FAIL === '1' || (env.STUB_CLAUDE_RESUME_FAIL_FILE && existsSync(env.STUB_CLAUDE_RESUME_FAIL_FILE))) process.exit(1)
}

let hook = null
let statusLine = ''
if (settings) {
  const s = JSON.parse(readFileSync(settings, 'utf8'))
  hook = s.hooks?.SessionStart?.[0]?.hooks?.[0] ?? null
  statusLine = s.statusLine?.command ?? ''
}

const isFile = (p) => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** Git Bash, where Claude Code on Windows runs shell commands when it finds one. */
function gitBash() {
  if (env.CLAUDE_CODE_GIT_BASH_PATH) return isFile(env.CLAUDE_CODE_GIT_BASH_PATH) ? env.CLAUDE_CODE_GIT_BASH_PATH : null
  for (const dir of (env.PATH ?? '').split(';')) {
    if (dir && isFile(join(dir, 'git.exe'))) {
      for (const c of [join(dir, '..', 'bin', 'bash.exe'), join(dir, 'bash.exe')]) if (isFile(c)) return c
    }
  }
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)']]) {
    if (base && isFile(join(base, 'Git', 'bin', 'bash.exe'))) return join(base, 'Git', 'bin', 'bash.exe')
  }
  return null
}

/** Runs a program with `input` on stdin; its stdout. */
function run(file, argv, input) {
  const r = spawnSync(file, argv, { input, encoding: 'utf8', windowsHide: true })
  return r.stdout ?? ''
}

function runShell(command, input) {
  if (process.platform !== 'win32') return run('sh', ['-c', command], input)
  const bash = gitBash()
  if (bash) return run(bash, ['-c', command], input)
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], input)
}

function emit(payload) {
  if (!hook) return
  const json = JSON.stringify(payload)
  if (Array.isArray(hook.args)) run(hook.command, hook.args, json)
  else runShell(hook.command, json)
}

// Like Claude after a reply: the status line command gets JSON with rate_limits ($STUB_RATE_LIMITS, or 42% / 18%;
// STUB_RATE_LIMITS=null leaves them out). Its output is shown as "status: ...".
function statusline() {
  if (!statusLine) return
  const now = Math.floor(Date.now() / 1000)
  let limits
  try {
    limits = env.STUB_RATE_LIMITS
      ? JSON.parse(env.STUB_RATE_LIMITS)
      : { five_hour: { used_percentage: 42, resets_at: now + 7200 }, seven_day: { used_percentage: 18, resets_at: now + 259200 } }
  } catch {
    return
  }
  const json = JSON.stringify({
    session_id: id, cwd: process.cwd(), model: { id: 'stub', display_name: 'Stub' },
    ...(limits === null ? {} : { rate_limits: limits })
  })
  const out = runShell(statusLine, json).replace(/[\r\n]+$/, '')
  if (out) console.log(`status: ${out}`)
}

if (env.STUB_CLAUDE_SILENT !== '1') emit({ hook_event_name: 'SessionStart', session_id: id, source: 'startup' })
console.log('STUB CLAUDE READY')

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
  switch (line) {
    case 'exit':
      emit({ hook_event_name: 'SessionEnd', session_id: id, reason: 'prompt_input_exit' })
      process.exit(0)
      break
    case 'ask':
      emit({ hook_event_name: 'PermissionRequest', session_id: id, tool_name: 'Bash' })
      console.log('STUB ASKS PERMISSION')
      break
    case 'clear':
      emit({ hook_event_name: 'SessionStart', session_id: `${id}-cleared`, source: 'clear' })
      break
    default:
      emit({ hook_event_name: 'UserPromptSubmit', session_id: id })
      console.log(`echo: ${line}`)
      emit({ hook_event_name: 'Stop', session_id: id, last_assistant_message: `echo: ${line}` })
      statusline()
  }
})
lines.on('close', () => process.exit(0))
