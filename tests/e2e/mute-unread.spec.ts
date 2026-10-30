import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { waitFor } from '../helpers/wait'
import { launchApp, makeE2eEnv, paneText, type E2eEnv } from './helpers'

test.describe.configure({ mode: 'serial' })
test.skip(process.env.PACKAGED === '1', 'dev build only')

let e: E2eEnv
let app: ElectronApplication | undefined
let page: Page
let id = ''

test.beforeAll(async () => { e = await makeE2eEnv() })
test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  await e?.cleanup()
})

const row = () => page.getByTestId('session-row')

test('mark as unread stays while visible and clears when opened', async () => {
  ;({ app, page } = await launchApp(e.env))
  await page.getByTestId('create-first-project').click()
  await page.getByTestId('project-name-input').fill('Acme')
  await page.getByTestId('git-name-input').fill('Jane Doe')
  await page.getByTestId('git-email-input').fill('jane@acme.test')
  await page.getByTestId('save-project').click()
  await page.getByTestId('project-row').hover()
  await page.getByTestId('add-folder').click()
  await page.getByTestId('subproject-row').hover()
  await page.getByTestId('new-session').click()
  await page.getByTestId('session-title-input').fill('Alpha')
  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('new-session-dialog')).toHaveCount(0, { timeout: 30_000 })
  id = (await row().getAttribute('data-session-id'))!
  await waitFor(async () => (await paneText(e, id)).includes('STUB CLAUDE READY'), 15_000, 'ready')
  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('focus'))

  await page.keyboard.type('hi')
  await page.keyboard.press('Enter')
  await waitFor(async () => (await paneText(e, id)).includes('echo: hi'), 15_000, 'echo: hi')
  await expect(row()).toHaveAttribute('data-status', 'read', { timeout: 15_000 })
  await page.waitForTimeout(500) // let the Stop event land

  await row().hover()
  await page.getByTestId('session-menu').click()
  await page.getByTestId('session-mark-unread').click()
  await expect(row()).toHaveAttribute('data-status', 'unread')
  await page.waitForTimeout(1000) // visible in a pane is not "opened"
  await expect(row()).toHaveAttribute('data-status', 'unread')
  await row().hover()
  await page.getByTestId('session-menu').click()
  await expect(page.getByTestId('session-mark-unread')).toHaveCount(0) // only offered when read
  await page.keyboard.press('Escape')

  await row().click()
  await expect(row()).toHaveAttribute('data-status', 'read')
})

test('a muted project still shows what needs you', async () => {
  await expect(page.getByTestId('project-muted')).toHaveCount(0)
  await page.getByTestId('project-row').hover()
  await page.getByTestId('project-menu').click()
  await page.getByRole('menuitem', { name: 'Mute notifications' }).click()
  await expect(page.getByTestId('project-muted')).toBeVisible()

  await row().click()
  await page.getByTestId('terminal-claude').click()
  await page.keyboard.type('ask')
  await page.keyboard.press('Enter')
  await waitFor(async () => (await paneText(e, id)).includes('STUB ASKS PERMISSION'), 15_000, 'asked')
  await expect(row()).toHaveAttribute('data-status', 'needs_you')

  await page.getByTestId('project-row').hover()
  await page.getByTestId('project-menu').click()
  await page.getByRole('menuitem', { name: 'Unmute notifications' }).click()
  await expect(page.getByTestId('project-muted')).toHaveCount(0)
})
