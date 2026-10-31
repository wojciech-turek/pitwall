// Checks what Windows users download, before it's released:
//   node scripts/verify-windows.mjs <x64|arm64> [version (default: package.json's)] [--no-installer]
// The installer is there (not checked with --no-installer, after `pnpm package:win`), and the app it was made from
// (release/win-unpacked, or win-arm64-unpacked) has Pitwall.exe for that architecture, the main process and the host
// inside app.asar, node-pty's binaries for that architecture beside it (with its ConPTY worker and console helper),
// and the PowerShell hook and status line scripts. Runs anywhere: it reads files and starts nothing.
import { existsSync, openSync, readFileSync, readSync, closeSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The machine a PE file (exe or dll) is built for: 'x64', 'arm64', or the raw value. */
export function peMachine(file) {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(64)
    readSync(fd, head, 0, 64, 0)
    if (head.toString('latin1', 0, 2) !== 'MZ') throw new Error(`${file} is not a Windows executable`)
    const pe = Buffer.alloc(6)
    readSync(fd, pe, 0, 6, head.readUInt32LE(0x3c))
    if (pe.toString('latin1', 0, 4) !== 'PE\0\0') throw new Error(`${file} has no PE header`)
    const m = pe.readUInt16LE(4)
    return m === 0x8664 ? 'x64' : m === 0xaa64 ? 'arm64' : `0x${m.toString(16)}`
  } finally {
    closeSync(fd)
  }
}

/** Every file path in an asar archive (forward slashes, no leading slash). */
export function asarFiles(file) {
  const fd = openSync(file, 'r')
  try {
    const sizes = Buffer.alloc(16)
    readSync(fd, sizes, 0, 16, 0)
    const json = Buffer.alloc(sizes.readUInt32LE(12))
    readSync(fd, json, 0, json.length, 16)
    const out = []
    const walk = (node, prefix) => {
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        const p = prefix ? `${prefix}/${name}` : name
        if (entry.files) walk(entry, p)
        else out.push(p)
      }
    }
    walk(JSON.parse(json.toString('utf8')), '')
    return out
  } finally {
    closeSync(fd)
  }
}

export function verifyWindows(version, arch, releaseDir = 'release', o = { installer: true }) {
  const problems = []
  const need = (ok, what) => { if (!ok) problems.push(what) }
  const installer = join(releaseDir, `Pitwall-${version}-${arch}-setup.exe`)
  if (o.installer) need(existsSync(installer) && statSync(installer).size > 20 * 1024 * 1024, `installer ${installer} (over 20 MB)`)
  if (o.installer && existsSync(installer)) {
    let program = true
    try { peMachine(installer) } catch { program = false }
    need(program, `${installer} to be a Windows program`)
  }

  const app = join(releaseDir, arch === 'x64' ? 'win-unpacked' : `win-${arch}-unpacked`)
  const exe = join(app, 'Pitwall.exe')
  need(existsSync(exe), `the app ${exe}`)
  if (existsSync(exe)) need(peMachine(exe) === arch, `${exe} built for ${arch} (it is ${peMachine(exe)})`)

  const asar = join(app, 'resources', 'app.asar')
  need(existsSync(asar), `the app archive ${asar}`)
  if (existsSync(asar)) {
    const files = new Set(asarFiles(asar))
    for (const f of ['out/main/index.js', 'out/host/index.js', 'out/preload/index.cjs', 'out/renderer/index.html', 'package.json']) {
      need(files.has(f), `${f} in app.asar`)
    }
  }

  const pty = join(app, 'resources', 'app.asar.unpacked', 'node_modules', 'node-pty')
  for (const f of ['conpty.node', 'conpty_console_list.node', 'pty.node']) {
    const p = join(pty, 'prebuilds', `win32-${arch}`, f)
    need(existsSync(p), `node-pty's ${p}`)
    if (existsSync(p)) need(peMachine(p) === arch, `${p} built for ${arch} (it is ${peMachine(p)})`)
  }
  for (const f of ['lib/index.js', 'lib/worker/conoutSocketWorker.js', 'lib/conpty_console_list_agent.js']) {
    need(existsSync(join(pty, ...f.split('/'))), `node-pty's ${f} unpacked (a worker thread and a child process run it)`)
  }

  const bin = join(app, 'resources', 'resources', 'bin')
  for (const f of ['pitwall-hook.ps1', 'pitwall-statusline.ps1']) need(existsSync(join(bin, f)), `${join(bin, f)}`)
  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const installer = !args.includes('--no-installer')
  const [arch, version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version] =
    args.filter((a) => a !== '--no-installer')
  if (!['x64', 'arm64'].includes(arch)) {
    console.error('usage: node scripts/verify-windows.mjs <x64|arm64> [version] [--no-installer]')
    process.exit(2)
  }
  const problems = verifyWindows(version, arch, 'release', { installer })
  if (problems.length) {
    console.error(`Windows ${arch} build ${version} is missing:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    process.exit(1)
  }
  console.log(`Windows ${arch} build ${version} ok${installer ? `: release/Pitwall-${version}-${arch}-setup.exe` : ' (app only)'}`)
}
