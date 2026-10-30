import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { waitFor } from '../helpers/wait'
import { launchApp, makeE2eEnv, paneText, sessionIdOf, shot, tmux, type E2eEnv } from './helpers'

// The app as the Dock/Finder starts it: minimal PATH, no LANG/LC_*, no CLAUDE* vars.
// Runs against the dev build, or against the packaged app with PACKAGED=1 (the title matches `-g packaged`).
const PACKAGED = process.env.PACKAGED === '1'
const repoRoot = process.cwd()
const packagedExe = join(repoRoot, 'release/mac-arm64/Pitwall.app/Contents/MacOS/Pitwall')
const TRUST_HINT = 'Claude hasn\'t reported in yet. If it\'s asking whether to trust this folder, choose ' +
  '"Yes, I trust this folder" — the default is "No, exit".'

test.describe.configure({ mode: 'serial' })

let e: E2eEnv
let app: ElectronApplication | undefined
let page: Page

test.beforeAll(async () => { e = await makeE2eEnv() })
test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  await e?.cleanup()
})

function finderEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
  for (const k of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR']) if (process.env[k]) env[k] = process.env[k]!
  for (const [k, v] of Object.entries(e.env)) if (k.startsWith('PITWALL_') || k.startsWith('STUB_')) env[k] = v
  env.STUB_CLAUDE_SILENT = '1' // like real Claude sitting on its folder-trust prompt: no hook fires
  return env
}

test('Finder-like launch (dev, or packaged with PACKAGED=1): start returns at once, UTF-8 terminal, trust hint, one instance', async () => {
  if (PACKAGED) expect(existsSync(packagedExe)).toBe(true)
  const env = finderEnv()
  ;({ app, page } = await launchApp(env, PACKAGED ? packagedExe : undefined))

  await page.getByTestId('create-first-project').click()
  await page.getByTestId('project-name-input').fill('Finder')
  await expect(page.getByTestId('gh-account-select').locator('option', { hasText: 'dev-work' })).toHaveCount(1)
  await page.getByTestId('gh-account-select').selectOption('dev-work')
  await page.getByTestId('git-name-input').fill('F')
  await page.getByTestId('git-email-input').fill('f@acme.test')
  await page.getByTestId('save-project').click()
  await page.getByTestId('project-row').hover()
  await page.getByTestId('add-folder').click()
  await expect(page.getByTestId('subproject-row')).toContainText('tax-service')
  await page.getByTestId('subproject-row').hover()
  await page.getByTestId('new-session').click()
  await page.getByTestId('session-title-input').fill('Trust me')

  // I1: Claude stays silent, yet the dialog closes right away and the session is selected with its terminal.
  const t0 = Date.now()
  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('new-session-dialog')).toHaveCount(0, { timeout: 5000 })
  expect(Date.now() - t0).toBeLessThan(5000)
  await expect(page.getByTestId('session-row')).toHaveClass(/selected/)
  await expect(page.getByTestId('terminal-claude')).toBeVisible()
  const id = await waitFor(() => sessionIdOf(e.socket), 15_000, 'tmux session')
  await waitFor(async () => (await paneText(e.socket, id)).includes('STUB CLAUDE READY'), 15_000, 'STUB CLAUDE READY')

  // C1: the embedded terminal's tmux client writes UTF-8, and sessions get a UTF-8 LANG and no nested-Claude vars.
  await waitFor(async () => (await tmux(e.socket, 'list-clients', '-F', '#{client_utf8}')).trim() === '1', 15_000, 'UTF-8 client')
  expect(await tmux(e.socket, 'show-environment', '-g', 'LANG')).toMatch(/^LANG=[A-Za-z_]+\.UTF-8$/m)
  expect(await tmux(e.socket, 'show-environment', '-g')).not.toMatch(/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_PID)=/m)

  // I1: the trust hint after 20 s of silence, gone once Claude reports in.
  await expect(page.getByTestId('start-warning')).toHaveText(TRUST_HINT, { timeout: 30_000 })
  await shot(page, PACKAGED ? '17-finder-trust-hint-packaged' : '16-finder-trust-hint')
  await page.getByTestId('terminal-claude').click()
  await page.keyboard.type('yes')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('start-warning')).toHaveCount(0)

  // I5: a second launch with the same data dir hands over to this instance and quits.
  const [file, args] = PACKAGED
    ? [packagedExe, []]
    : [createRequire(import.meta.url)('electron') as string, [join(repoRoot, 'out/main/index.js')]]
  const second = spawn(file, args, { env, stdio: 'ignore' })
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { second.kill(); reject(new Error('second instance did not quit')) }, 15_000)
    second.on('exit', (c) => { clearTimeout(timer); resolve(c) })
  })
  expect(code).toBe(0)
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  await expect(page.getByTestId('session-row')).toHaveCount(1)

  // I3: nothing can navigate the window away from the app (last: a refused navigation confuses Playwright's page).
  const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL())
  await app.evaluate(({ BrowserWindow }) => {
    void BrowserWindow.getAllWindows()[0].webContents.executeJavaScript("location.href = 'file:///etc/hosts'")
  })
  await new Promise((r) => setTimeout(r, 1000))
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL())).toBe(before)
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents
    .executeJavaScript('document.querySelectorAll("[data-testid=session-row]").length'))).toBe(1)
})
