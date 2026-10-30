// Runs a command with some environment variables set, the same on every platform (cmd.exe, where pnpm runs scripts on
// Windows, can't do `VAR=value command`):
//   node scripts/with-env.mjs PITWALL_SESSION_BACKEND=host [MORE=value …] -- playwright test [args…]
// `playwright` is started with Node directly (no shell, so arguments arrive exactly as given); any other command is
// looked up on PATH.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const argv = process.argv.slice(2)
const sep = argv.indexOf('--')
if (sep < 1 || sep === argv.length - 1) {
  console.error('usage: node scripts/with-env.mjs NAME=value [NAME=value …] -- command [args…]')
  process.exit(2)
}
const env = { ...process.env }
for (const pair of argv.slice(0, sep)) {
  const eq = pair.indexOf('=')
  if (eq < 1) {
    console.error(`not NAME=value: ${pair}`)
    process.exit(2)
  }
  env[pair.slice(0, eq)] = pair.slice(eq + 1)
}
const [command, ...args] = argv.slice(sep + 1)
const [file, fileArgs] = command === 'playwright'
  ? [process.execPath, [createRequire(import.meta.url).resolve('@playwright/test/cli'), ...args]]
  : [command, args]
const child = spawn(file, fileArgs, { stdio: 'inherit', env })
child.on('error', (e) => {
  console.error(`${command}: ${e.message}`)
  process.exit(1)
})
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
