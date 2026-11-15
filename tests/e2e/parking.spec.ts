import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { waitFor } from '../helpers/wait'
import { launchApp, makeE2eEnv, paneText, sessionNames, tmux, type E2eEnv } from './helpers'

test.describe.configure({ mode: 'serial' })
test.skip(process.env.PACKAGED === '1' || process.platform === 'win32', 'dev build, tmux only')

let e: E2eEnv
let app: ElectronApplication | undefined
let page: Page
let a = ''

test.beforeAll(async () => { e = await makeE2eEnv(); e.env.PITWALL_PARK_AFTER_MS = '500' })
test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  await e?.cleanup()
})

const row = (title: string): Locator => page.getByTestId('session-row').filter({ hasText: title })

async function startSession(title: string): Promise<string> {
  await page.getByTestId('subproject-row').hover()
  await page.getByTestId('new-session').click()
  await page.getByTestId('session-title-input').fill(title)
  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('new-session-dialog')).toHaveCount(0, { timeout: 30_000 })
  const id = (await row(title).getAttribute('data-session-id'))!
  await waitFor(async () => (await paneText(e, id)).includes('STUB CLAUDE READY'), 15_000, `${title} ready`)
  return id
}

const shellText = (id: string): Promise<string> =>
  tmux(e.socket, 'capture-pane', '-p', '-J', '-t', `=pw-${id}-sh:`).catch(() => '')
const clients = (id: string): Promise<string> =>
  tmux(e.socket, 'list-clients', '-t', `=pw-${id}-sh`).catch(() => '')

async function openShell(title: string): Promise<void> {
  await row(title).click()
  await expect(row(title)).toHaveClass(/selected/)
  await page.getByTestId('tab-shell').click()
  await page.getByTestId('terminal-shell').click()
}

test('a terminal hidden past the delay lets go of its stream, and reattaches typed-into', async () => {
  ;({ app, page } = await launchApp(e.env))
  await page.getByTestId('create-first-project').click()
  await page.getByTestId('project-name-input').fill('Acme')
  await page.getByTestId('git-name-input').fill('Jane Doe')
  await page.getByTestId('git-email-input').fill('jane@acme.test')
  await page.getByTestId('save-project').click()
  await page.getByTestId('project-row').hover()
  await page.getByTestId('add-folder').click()
  a = await startSession('Alpha')
  await startSession('Beta')

  await openShell('Alpha')
  await waitFor(async () => (await clients(a)).trim() !== '', 15_000, 'shell attached')
  await page.keyboard.type('echo PARK-MARK-1')
  await page.keyboard.press('Enter')
  await waitFor(async () => (await shellText(a)).includes('PARK-MARK-1'), 15_000, 'mark 1')

  await row('Beta').click()
  await page.waitForTimeout(1500)
  expect((await clients(a)).trim()).toBe('')

  await openShell('Alpha')
  await page.keyboard.type('echo PARK-MARK-2') // at once: typed while reattaching
  await page.keyboard.press('Enter')
  await waitFor(async () => (await shellText(a)).includes('PARK-MARK-2'), 15_000, 'mark 2')
  expect((await clients(a)).trim()).not.toBe('')
  expect(await shellText(a)).toContain('PARK-MARK-1')
})

test('an exited shell is not parked: it still offers "press any key"', async () => {
  await page.keyboard.type('exit')
  await page.keyboard.press('Enter')
  await waitFor(async () => !(await sessionNames(e)).includes(`pw-${a}-sh`), 15_000, 'shell gone')
  await row('Beta').click()
  await page.waitForTimeout(1500)
  await openShell('Alpha')
  // xterm's WebGL canvas has no text; the notice is the only thing that stops a key restarting the shell.
  await page.waitForTimeout(500)
  expect((await clients(a)).trim()).toBe('') // nothing reattached by itself
  expect(await sessionNames(e)).not.toContain(`pw-${a}-sh`)
})
