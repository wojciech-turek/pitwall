import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { waitFor } from '../helpers/wait'
import { launchApp, makeE2eEnv, paneText, tmux, type E2eEnv } from './helpers'

test.describe.configure({ mode: 'serial' })
test.skip(process.env.PACKAGED === '1' || process.platform === 'win32', 'dev build, Unix shell')

let e: E2eEnv
let app: ElectronApplication | undefined
let page: Page

test.beforeAll(async () => { e = await makeE2eEnv() })
test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  await e?.cleanup()
})

/** The Shell tab's pane: its own tmux session, pw-<id>-sh. */
const shellText = (id: string): Promise<string> =>
  tmux(e.socket, 'capture-pane', '-p', '-J', '-t', `=pw-${id}-sh:`).catch(() => '')

/** Waits until the Shell prints nothing new for a moment: its prompt is up. */
async function settled(id: string): Promise<void> {
  let last = ''
  let since = Date.now()
  await waitFor(async () => {
    const now = await shellText(id)
    if (now !== last || !now.trim()) { last = now; since = Date.now(); return false }
    return Date.now() - since > 1500
  }, 20_000, 'shell prompt')
}

test('a session starts a helper with `pitwall new`; it hangs under it and its first prompt reaches Claude', async () => {
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
  await page.getByTestId('session-title-input').fill('Parent')
  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('new-session-dialog')).toHaveCount(0, { timeout: 30_000 })
  const aId = (await page.getByTestId('session-row').getAttribute('data-session-id'))!
  await waitFor(async () => (await paneText(e, aId)).includes('STUB CLAUDE READY'), 15_000, 'ready')

  await page.getByTestId('tab-shell').click()
  await settled(aId)
  // A login shell on a developer's machine may ask something first (oh-my-zsh offers to update): decline it.
  if ((await shellText(aId)).includes('[Y/n]')) {
    await page.keyboard.type('n')
    await page.keyboard.press('Enter')
    await settled(aId)
  }
  await page.keyboard.type('pitwall new "Child" --prompt hello')
  await page.keyboard.press('Enter')

  const rows = page.getByTestId('session-row')
  const child = rows.filter({ hasText: 'Child' })
  await expect(child).toHaveAttribute('data-depth', '1', { timeout: 15_000 })
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(1)).toContainText('Child') // directly after Parent
  await expect(rows.nth(0)).toHaveAttribute('data-depth', '0')
  const cId = (await child.getAttribute('data-session-id'))!

  await waitFor(async () => (await paneText(e, cId)).includes('echo: hello'), 15_000, 'child echoes its prompt')

  await page.keyboard.type(`pitwall wait ${cId}`)
  await page.keyboard.press('Enter')
  await waitFor(async () => {
    const t = await shellText(aId)
    return t.split('\n').filter((l) => l.includes('echo: hello')).length > 0
  }, 20_000, 'pitwall wait prints the reply')
})
