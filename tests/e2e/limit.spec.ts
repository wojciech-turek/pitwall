import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { waitFor } from '../helpers/wait'
import { launchApp, makeE2eEnv, paneText, type E2eEnv } from './helpers'

test.describe.configure({ mode: 'serial' })
test.skip(process.env.PACKAGED === '1', 'dev build only')

let e: E2eEnv
let app: ElectronApplication | undefined
let page: Page

test.beforeAll(async () => { e = await makeE2eEnv() })
test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  await e?.cleanup()
})

test('a session stopped at a usage limit offers to continue when it resets, and the offer can be cancelled', async () => {
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
  const id = (await page.getByTestId('session-row').getAttribute('data-session-id'))!
  await waitFor(async () => (await paneText(e, id)).includes('STUB CLAUDE READY'), 15_000, 'ready')
  await expect(page.getByTestId('limit-banner')).toHaveCount(0)

  await page.keyboard.type('limit')
  await page.keyboard.press('Enter')

  const banner = page.getByTestId('limit-banner')
  await expect(banner).toContainText('Claude stopped at a limit.', { timeout: 10_000 })
  await expect(page.getByTestId('continue-at')).toContainText(/^Continue at \d{1,2}:\d{2}/)
  await page.getByTestId('continue-at').click()
  await expect(banner).toContainText('Will type "continue"')
  await page.getByTestId('continue-cancel').click()
  await expect(page.getByTestId('continue-at')).toBeVisible()
  await expect(banner).not.toContainText('Will type')
})
