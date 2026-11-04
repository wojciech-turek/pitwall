import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp, makeE2eEnv, shot, type E2eEnv } from './helpers'

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

const rows = () => page.getByTestId('session-row')
const titles = () => rows().locator('.row-title').allTextContents()
const rowNamed = (title: string) => rows().filter({ hasText: title })

async function startSession(title: string): Promise<void> {
  await page.getByTestId('subproject-row').hover()
  await page.getByTestId('new-session').click()
  await page.getByTestId('session-title-input').fill(title)
  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('new-session-dialog')).toHaveCount(0, { timeout: 30_000 })
}

test('sessions show a status icon; a pinned session moves to the top of its folder and back', async () => {
  ;({ app, page } = await launchApp(e.env))
  await page.getByTestId('create-first-project').click()
  await page.getByTestId('project-name-input').fill('Acme')
  await page.getByTestId('git-name-input').fill('Jane Doe')
  await page.getByTestId('git-email-input').fill('jane@acme.test')
  await page.getByTestId('save-project').click()
  await page.getByTestId('project-row').hover()
  await page.getByTestId('add-folder').click()
  await startSession('Alpha')
  await startSession('Beta')
  await expect(rows()).toHaveCount(2)
  expect(await titles()).toEqual(['Alpha', 'Beta'])
  await expect(rows().first().getByTestId('status-icon')).toHaveAttribute('data-glyph', /^(starting|spinner|check|hand)$/)

  await rowNamed('Beta').hover()
  await rowNamed('Beta').getByTestId('session-menu').click()
  await page.getByTestId('session-pin').click()
  await expect.poll(titles).toEqual(['Beta', 'Alpha'])
  await expect(rowNamed('Beta').getByTestId('pin-mark')).toBeVisible()
  await expect(rowNamed('Alpha').getByTestId('pin-mark')).toHaveCount(0)
  await shot(page, 'sidebar-pinned')

  await rowNamed('Beta').hover()
  await rowNamed('Beta').getByTestId('session-menu').click()
  await expect(page.getByTestId('session-pin')).toHaveText('Unpin')
  await page.getByTestId('session-pin').click()
  await expect.poll(titles).toEqual(['Alpha', 'Beta'])
  await expect(page.getByTestId('pin-mark')).toHaveCount(0)
})
