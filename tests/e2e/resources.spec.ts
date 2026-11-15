import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp, makeE2eEnv, type E2eEnv } from './helpers'

test.describe.configure({ mode: 'serial' })
test.skip(process.env.PACKAGED === '1' || process.platform === 'win32', 'dev build, sampled on macOS and Linux only')

let e: E2eEnv
let app: ElectronApplication | undefined
let page: Page

test.beforeAll(async () => { e = await makeE2eEnv() })
test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  await e?.cleanup()
})

test('a session\'s hover card shows what it is using', async () => {
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

  const row = page.getByTestId('session-row').filter({ hasText: 'Alpha' })
  await expect(async () => {
    await page.mouse.move(0, 0)
    await row.hover()
    await expect(page.getByTestId('hover-card').getByTestId('hc-usage'))
      .toHaveText(/CPU \d+% · [\d.]+ (KB|MB|GB) · \d+ process(es)?/, { timeout: 1500 })
  }).toPass({ timeout: 15_000 })
})
