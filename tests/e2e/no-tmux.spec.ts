import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { HostBackend } from '../../src/main/host-backend'
import { waitFor } from '../helpers/wait'
import { launchApp, makeE2eEnv, type E2eEnv } from './helpers'

const run = promisify(execFile)

test.describe.configure({ mode: 'serial' })
test.skip(process.env.PACKAGED === '1' || process.platform === 'win32', 'dev build, Unix shell')

let e: E2eEnv
let env: Record<string, string>
let app: ElectronApplication | undefined
let page: Page
let host: HostBackend
let sessionId = ''

/** PATH without any directory that holds an executable `tmux`. */
function pathWithoutTmux(path: string): string {
  return path.split(delimiter).filter((dir) => {
    try { accessSync(join(dir, 'tmux'), constants.X_OK); return false } catch { return true }
  }).join(delimiter)
}

test.beforeAll(async () => {
  e = await makeE2eEnv()
  // A plain sh as the login shell, so the developer's own rc files can't put tmux back on PATH.
  env = { ...e.env, PATH: pathWithoutTmux(e.env.PATH), SHELL: '/bin/sh' }
  delete env.PITWALL_SESSION_BACKEND // the choice under test is the app's own
  host = new HostBackend({ dataDir: e.dataDir, appVersion: 'e2e', launch: null })
})
test.afterAll(async () => {
  host?.disconnect()
  await app?.close().catch(() => undefined)
  await e?.cleanup() // also stops the host
})

test('with no tmux installed, a session runs in Pitwall\'s own host', async () => {
  ;({ app, page } = await launchApp(env))
  await page.getByTestId('create-first-project').click()
  await page.getByTestId('project-name-input').fill('Acme')
  await page.getByTestId('git-name-input').fill('Jane Doe')
  await page.getByTestId('git-email-input').fill('jane@acme.test')
  await page.getByTestId('save-project').click()
  await page.getByTestId('project-row').hover()
  await page.getByTestId('add-folder').click()
  await page.getByTestId('subproject-row').hover()
  await page.getByTestId('new-session').click()
  await page.getByTestId('session-title-input').fill('No tmux')
  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('new-session-dialog')).toHaveCount(0, { timeout: 30_000 })
  sessionId = (await page.getByTestId('session-row').getAttribute('data-session-id'))!
  await expect(page.getByTestId('terminal-claude')).toBeVisible()
  await waitFor(async () => (await host.capture(`pw-${sessionId}`).catch(() => '')).includes('STUB CLAUDE READY'), 20_000, 'agent ready')

  expect(JSON.parse(await readFile(join(e.dataDir, 'backend.json'), 'utf8'))).toEqual({ kind: 'host' })
  // No tmux server on the test's socket (tmux, if this machine has it, is used by its absolute path).
  const tmuxBin = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((p) => {
    try { accessSync(p, constants.X_OK); return true } catch { return false }
  })
  if (tmuxBin) await expect(run(tmuxBin, ['-L', e.socket, 'list-sessions'])).rejects.toThrow()
})

test('after a restart the session is still there and its terminal reattaches', async () => {
  await app!.close()
  app = undefined
  ;({ app, page } = await launchApp(env))
  await expect(page.getByTestId('session-row')).toHaveCount(1)
  await page.getByTestId('session-row').click()
  await expect(page.getByTestId('terminal-claude')).toBeVisible()
  await page.getByTestId('terminal-claude').click()
  await page.keyboard.type('still here')
  await page.keyboard.press('Enter')
  await waitFor(async () => (await host.capture(`pw-${sessionId}`).catch(() => '')).includes('echo: still here'), 15_000, 'typing after reattach')
  expect(JSON.parse(await readFile(join(e.dataDir, 'backend.json'), 'utf8'))).toEqual({ kind: 'host' })
})
