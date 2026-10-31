import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { waitFor } from '../helpers/wait'
import { clearLine, launchApp, makeE2eEnv, paneText, type E2eEnv } from './helpers'

const PACKAGED = process.env.PACKAGED === '1'
const SHOTS = process.env.PITWALL_E2E_SCREENS || join(process.cwd(), 'test-results/screens')

test.describe.configure({ mode: 'serial' })

let e: E2eEnv
let app: ElectronApplication | undefined
let page: Page
let alpha = ''
let beta = ''

test.beforeAll(async () => { e = await makeE2eEnv() })
test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  await e?.cleanup()
})

const row = (title: string): Locator => page.getByTestId('session-row').filter({ hasText: title })
const panes = (): Locator => page.getByTestId('pane')
const preview = (): Locator => page.getByTestId('drop-preview')

async function shot(name: string): Promise<void> {
  await mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

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

type Spot = 'left' | 'right' | 'top' | 'bottom' | 'center'
async function pointIn(loc: Locator, spot: Spot): Promise<{ x: number; y: number }> {
  const b = (await loc.boundingBox())!
  const x = spot === 'left' ? b.x + 20 : spot === 'right' ? b.x + b.width - 20 : b.x + b.width / 2
  const y = spot === 'top' ? b.y + 20 : spot === 'bottom' ? b.y + b.height - 20 : b.y + b.height / 2
  return { x, y }
}

/** Starts dragging a sidebar row and hovers it over a spot; the mouse stays down. */
async function dragOver(title: string, target: Locator, spot: Spot): Promise<void> {
  const to = await pointIn(target, spot)
  await row(title).hover()
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 8 })
}

/** Waits for the keyboard to be in the session's pane (it moves there a moment after the pane becomes active), types a
 * line, and checks it reached the session's Claude. */
async function typeTo(sessionId: string, text: string): Promise<void> {
  await expect.poll(() => page.evaluate('document.activeElement?.closest("[data-testid=pane]")?.getAttribute("data-session-id") ?? null'))
    .toBe(sessionId)
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  await waitFor(async () => (await paneText(e, sessionId)).includes(`echo: ${text}`), 15_000, `echo: ${text}`)
}

const menu = (accel: string): Promise<void> => app!.evaluate(({ Menu }, a) => {
  type Item = { accelerator?: string; click(): void; submenu?: { items: Item[] } }
  const walk = (items: Item[]): Item | undefined => {
    for (const i of items) {
      if (i.accelerator === a) return i
      const f = i.submenu ? walk(i.submenu.items) : undefined
      if (f) return f
    }
    return undefined
  }
  walk(Menu.getApplicationMenu()!.items as unknown as Item[])!.click()
}, accel)

test.describe('split view', () => {
  test.skip(PACKAGED, 'dev build only')

  test('dragging a session onto the right edge of a pane splits it', async () => {
    ;({ app, page } = await launchApp(e.env))
    await page.getByTestId('create-first-project').click()
    await page.getByTestId('project-name-input').fill('Acme')
    await page.getByTestId('git-name-input').fill('Jane Doe')
    await page.getByTestId('git-email-input').fill('jane@acme.test')
    await page.getByTestId('save-project').click()
    await page.getByTestId('project-row').hover()
    await page.getByTestId('add-folder').click()
    alpha = await startSession('Alpha')
    beta = await startSession('Beta')
    await expect(panes()).toHaveCount(1)
    await expect(panes()).toHaveAttribute('data-session-id', beta)

    await dragOver('Alpha', panes().first(), 'right')
    await expect(preview()).toBeVisible()
    await expect(preview()).toHaveAttribute('data-zone', 'right')
    await expect(preview()).toHaveText('Split right')
    await shot('task-4-drop-preview')
    await page.mouse.up()

    await expect(panes()).toHaveCount(2)
    await expect(preview()).toHaveCount(0)
    await expect(panes().nth(0)).toHaveAttribute('data-session-id', beta)
    await expect(panes().nth(1)).toHaveAttribute('data-session-id', alpha)
    await expect(panes().nth(1)).toHaveAttribute('data-active', 'true')
    await expect(panes().nth(0).getByTestId('terminal-claude')).toBeVisible()
    await expect(panes().nth(1).getByTestId('terminal-claude')).toBeVisible()
    await expect(row('Alpha')).toHaveClass(/selected/)
    await expect(row('Beta')).toHaveClass(/visible/)
    await shot('task-4-two-panes')
    // the keyboard follows the new active pane
    await typeTo(alpha, 'split')
  })

  test('clicking a pane activates it; ⌘1 activates a visible session and the keyboard follows', async () => {
    await panes().nth(0).click()
    await expect(panes().nth(0)).toHaveAttribute('data-active', 'true')
    await expect(page.locator('.session-row.selected')).toHaveText(/Beta/)
    await menu('CmdOrCtrl+1') // Alpha, the first session in the sidebar
    await expect(panes().nth(1)).toHaveAttribute('data-active', 'true')
    await typeTo(alpha, 'one')
  })

  test('the × closes a pane; a drop on the session\'s own pane or outside the panes changes nothing', async () => {
    await panes().nth(1).getByTestId('close-pane').click()
    await expect(panes()).toHaveCount(1)
    await expect(page.getByTestId('close-pane')).toHaveCount(0)
    await expect(panes()).toHaveAttribute('data-session-id', beta)

    await dragOver('Beta', panes().first(), 'right')
    await expect(preview()).toHaveAttribute('data-zone', 'center')
    await expect(preview()).toHaveText('Already here')
    await page.mouse.up()
    await expect(panes()).toHaveCount(1)

    // released over the sidebar: nothing happens, and the drop layers go away
    await dragOver('Alpha', page.locator('.sidebar'), 'bottom')
    await expect(page.getByTestId('drop-layer')).toHaveCount(1)
    await page.mouse.up()
    await expect(page.getByTestId('drop-layer')).toHaveCount(0)
    await expect(panes()).toHaveCount(1)
    await expect(panes()).toHaveAttribute('data-session-id', beta)
  })

  test('the split layout survives an app restart', async () => {
    const box = (await panes().first().boundingBox())!
    await row('Alpha').dragTo(panes().first(), { targetPosition: { x: box.width - 20, y: box.height / 2 } })
    await expect(panes()).toHaveCount(2)

    await app!.close()
    app = undefined
    ;({ app, page } = await launchApp(e.env))
    await expect(panes()).toHaveCount(2)
    await expect(panes().nth(0)).toHaveAttribute('data-session-id', beta)
    await expect(panes().nth(1)).toHaveAttribute('data-session-id', alpha)
    await expect(panes().nth(1)).toHaveAttribute('data-active', 'true')
    await expect(panes().nth(0).getByTestId('terminal-claude')).toBeVisible()
    await expect(panes().nth(1).getByTestId('terminal-claude')).toBeVisible()
  })

  test('a file dropped on a terminal with 2 panes pastes its path and shows no drop preview', async () => {
    const file = join(e.tmp, 'dropped file.txt')
    await writeFile(file, 'x')
    const { x, y } = await pointIn(panes().nth(0).getByTestId('terminal-claude'), 'center')
    const cdp = await page.context().newCDPSession(page)
    const data = { items: [], files: [file], dragOperationsMask: 1 | 2 | 16 }
    await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data })
    await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data })
    await expect(preview()).toHaveCount(0)
    await expect(page.getByTestId('drop-layer')).toHaveCount(0) // layers exist only during a session drag
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', x, y, data })
    // (Lines joined: the host's screen breaks a long line at the pane's width, as a narrow pane shows it.)
    await waitFor(async () => (await paneText(e, beta)).replace(/\n/g, '').includes('dropped file.txt'), 10_000, 'dropped path in prompt')
    // dropping on a pane's terminal makes that pane active
    await expect(panes().nth(0)).toHaveAttribute('data-active', 'true')
    await cdp.detach()
    await clearLine(e, beta) // leave an empty prompt
  })

  test('⌘W on a Claude tab closes the active pane', async () => {
    await expect(panes().nth(0)).toHaveAttribute('data-active', 'true')
    await menu('CmdOrCtrl+W')
    await expect(panes()).toHaveCount(1)
    await expect(panes()).toHaveAttribute('data-session-id', alpha)
    await expect(page.getByTestId('close-pane')).toHaveCount(0)
  })

  test('a pane that moves with an open file never takes the keyboard from the active pane', async () => {
    await page.getByTestId('right-tab-files').click()
    await page.getByTestId('file-README.md').click()
    await expect(panes().getByTestId('editor-README.md')).toBeVisible()

    // Beta below Alpha: Alpha's pane is rebuilt inside the new split (its editor remounts); Beta's pane is active
    await dragOver('Beta', panes().first(), 'bottom')
    await expect(preview()).toHaveAttribute('data-zone', 'bottom')
    await expect(preview()).toHaveText('Split down')
    await page.mouse.up()
    await expect(panes()).toHaveCount(2)
    await expect(page.locator('.split-column')).toHaveCount(1)
    await expect(panes().nth(1)).toHaveAttribute('data-session-id', beta)
    await expect(panes().nth(1)).toHaveAttribute('data-active', 'true')
    await expect(panes().nth(0).locator('.cm-content')).toBeVisible()
    await page.waitForTimeout(300) // give a wrongly self-focusing editor time to grab the keyboard
    await typeTo(beta, 'below')
    await expect(page.locator('.tab-dirty')).toHaveCount(0)
  })

  test('archiving a session shown in a pane removes its pane', async () => {
    await expect(panes()).toHaveCount(2)
    await row('Alpha').hover()
    await row('Alpha').getByTestId('session-menu').click()
    await page.getByTestId('session-archive').click()
    await expect(page.getByTestId('archive-dialog')).toBeVisible()
    await page.getByTestId('archive-confirm').click()
    await expect(page.getByTestId('archive-dialog')).toHaveCount(0, { timeout: 30_000 })
    await expect(row('Alpha')).toHaveCount(0)
    await expect(panes()).toHaveCount(1)
    await expect(panes()).toHaveAttribute('data-session-id', beta)
    await expect(panes()).toHaveAttribute('data-active', 'true')
    // once the dialog closes, the keyboard is back in the remaining pane
    await typeTo(beta, 'after archive')
  })

  test('a session dragged onto the empty middle opens there', async () => {
    await page.evaluate(() => localStorage.removeItem('pitwall.layout.v1'))
    await page.reload()
    await expect(row('Beta')).toHaveCount(1)
    await expect(panes()).toHaveCount(0)
    await expect(page.locator('.main-hint')).toBeVisible()

    await dragOver('Beta', page.locator('.main'), 'center')
    await expect(preview()).toHaveAttribute('data-zone', 'center')
    await expect(preview()).toHaveText('Open here')
    await page.mouse.up()
    await expect(panes()).toHaveCount(1)
    await expect(panes()).toHaveAttribute('data-session-id', beta)
  })
})
