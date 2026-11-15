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

test('a session shows its subagents under it, and they can be hidden', async () => {
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
  await expect(page.getByTestId('subagents-toggle')).toHaveCount(0)

  await page.keyboard.type('subagent')
  await page.keyboard.press('Enter')

  const sub = page.getByTestId('subagent-row')
  await expect(sub).toContainText('Explore · Stub task', { timeout: 5_000 })
  await expect(sub).toHaveAttribute('data-state', 'running')
  await expect(sub).toHaveAttribute('data-state', 'done', { timeout: 10_000 })

  await page.getByTestId('subagents-toggle').click()
  await expect(sub).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('subagents-toggle')).toHaveCount(1)
  await expect(page.getByTestId('subagent-row')).toHaveCount(0)

  await page.getByTestId('subagents-toggle').click()
  await expect(page.getByTestId('subagent-row')).toHaveCount(1)
})
