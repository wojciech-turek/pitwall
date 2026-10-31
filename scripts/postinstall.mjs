// pnpm postinstall: node-pty's macOS prebuilds ship spawn-helper without its executable bit, and node-pty runs it.
// (In Node rather than `chmod +x … || true`, which cmd.exe, where pnpm runs scripts on Windows, can't run.)
import { chmodSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const prebuilds = join('node_modules', 'node-pty', 'prebuilds')
let dirs = []
try { dirs = readdirSync(prebuilds).filter((d) => d.startsWith('darwin-')) } catch { /* node-pty not installed */ }
for (const d of dirs) {
  const helper = join(prebuilds, d, 'spawn-helper')
  try { chmodSync(helper, statSync(helper).mode | 0o111) } catch { /* not there: nothing to do */ }
}
