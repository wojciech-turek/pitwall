import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { waitFor } from '../helpers/wait'
import { launchApp, makeE2eEnv, type E2eEnv } from './helpers'

test.describe.configure({ mode: 'serial' })
test.skip(process.env.PACKAGED === '1' || process.platform === 'win32', 'dev build, not on Windows')

let e: E2eEnv
let app: ElectronApplication | undefined
let page: Page

test.beforeAll(async () => { e = await makeE2eEnv() })
test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  await e?.cleanup()
})

const listening = async (port: number): Promise<boolean> => {
  try {
    return (await fetch(`http://localhost:${port}`, { signal: AbortSignal.timeout(1500) })).ok
  } catch {
    return false
  }
}

test('the Server tab runs the dev command on the session port and offers to open it', async () => {
  ;({ app, page } = await launchApp(e.env))
  await page.getByTestId('create-first-project').click()
  await page.getByTestId('project-name-input').fill('Acme')
  await page.getByTestId('git-name-input').fill('Jane Doe')
  await page.getByTestId('git-email-input').fill('jane@acme.test')
  await page.getByTestId('save-project').click()
  await page.getByTestId('project-row').hover()
  await page.getByTestId('add-folder').click()

  // no dev command yet: no Server tab
  await page.getByTestId('subproject-row').hover()
  await page.getByTestId('new-session').click()
  await page.getByTestId('session-title-input').fill('Plain')
  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('new-session-dialog')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByTestId('tab-shell')).toBeVisible()
  await expect(page.getByTestId('tab-server')).toHaveCount(0)

  await page.getByTestId('subproject-row').hover()
  await page.getByTestId('subproject-menu').click()
  await page.getByTestId('subproject-setup').click()
  await page.getByTestId('dev-command').fill(`node -e "require('http').createServer((q,s)=>s.end('ok')).listen(process.env.PORT)"`)
  await page.getByTestId('setup-command-save').click()
  await expect(page.getByTestId('subproject-settings-dialog')).toHaveCount(0)

  await page.getByTestId('subproject-row').hover()
  await page.getByTestId('new-session').click()
  await page.getByTestId('session-title-input').fill('Served')
  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('new-session-dialog')).toHaveCount(0, { timeout: 30_000 })
  const row = page.getByTestId('session-row').filter({ hasText: 'Served' })
  const id = (await row.getAttribute('data-session-id'))!
  await row.click()

  const env = await readFile(join(e.dataDir, 'sessions', id, 'env.sh'), 'utf8')
  const port = Number(/PITWALL_PORT=['"]?(\d+)/.exec(env)?.[1])
  expect(port).toBeGreaterThan(0)

  await page.getByTestId('tab-server').click()
  await expect(page.getByTestId('server-open')).toHaveText(`Open localhost:${port}`, { timeout: 15_000 })
  await expect(page.getByTestId('server-dot')).toBeVisible()
  const res = await fetch(`http://localhost:${port}`)
  expect(await res.text()).toBe('ok')

  await row.hover()
  await row.getByTestId('session-menu').click()
  await page.getByTestId('session-archive').click()
  await page.getByTestId('archive-confirm').click()
  await expect(page.getByTestId('archive-dialog')).toHaveCount(0, { timeout: 30_000 })
  await waitFor(async () => !(await listening(port)), 10_000, 'port closed')
})
