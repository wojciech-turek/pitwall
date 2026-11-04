import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { PersistedState } from '../../src/shared/types'
import { waitFor } from '../helpers/wait'
import { launchApp, makeE2eEnv, paneText, shot, type E2eEnv } from './helpers'

// The window's audio is muted in tests (PITWALL_SHOW_INACTIVE): what plays is counted, never heard.
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
const state = async (): Promise<PersistedState> => JSON.parse(await readFile(join(e.dataDir, 'state.json'), 'utf8'))
const emit = (event: string) => app!.evaluate(({ BrowserWindow }, ev) => { BrowserWindow.getAllWindows()[0].emit(ev) }, event)
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

/** Every note started since the last call: 880 Hz starts the "needs you" chime, 659.25 Hz is "finished". */
async function notesPlayed(): Promise<number[]> {
  return page.evaluate(() => {
    const w = globalThis as unknown as { __notes?: number[] }
    const out = w.__notes ?? []
    w.__notes = []
    return out
  })
}

async function say(text: string, expectInPane: string): Promise<void> {
  await page.getByTestId('terminal-claude').click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  await waitFor(async () => (await paneText(e, id)).includes(expectInPane), 15_000, expectInPane)
}

test('sounds are off until turned on; then a finish and a question each play theirs', async () => {
  ;({ app, page } = await launchApp(e.env))
  // Counts each note as it starts (a string: this side has no DOM types).
  await page.evaluate(`(() => {
    window.__notes = []
    const start = OscillatorNode.prototype.start
    OscillatorNode.prototype.start = function (...a) {
      window.__notes.push(this.frequency.value)
      return start.apply(this, a)
    }
  })()`)
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
  await emit('blur') // looking elsewhere: what happens in Alpha would notify

  // Off by default: a finished reply makes no sound.
  await say('hi', 'echo: hi')
  await expect(row()).toHaveAttribute('data-status', 'unread', { timeout: 15_000 })
  await page.waitForTimeout(500)
  expect(await notesPlayed()).toEqual([])

  // Turned on in Settings: both sounds play once, so you know what to listen for.
  await menu('CmdOrCtrl+,')
  await expect(page.getByTestId('setting-sounds')).not.toBeChecked()
  await page.getByTestId('setting-sounds').check()
  await shot(page, 'settings-sounds')
  await page.getByTestId('settings-save').click()
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0)
  await expect.poll(async () => (await state()).settings.sounds).toBe(true)
  const preview: number[] = []
  await expect.poll(async () => { preview.push(...await notesPlayed()); return preview.includes(880) && preview.includes(659.25) }, { timeout: 3_000 }).toBe(true)
  expect(preview.indexOf(880)).toBeLessThan(preview.indexOf(659.25)) // the one that matters first
  await page.waitForTimeout(1_000)
  await notesPlayed()
  await emit('blur')

  // A finished reply: the softer note only.
  await say('again', 'echo: again')
  await expect(row()).toHaveAttribute('data-status', 'unread', { timeout: 15_000 })
  await expect.poll(async () => (await page.evaluate(() => (globalThis as unknown as { __notes: number[] }).__notes)).length).toBeGreaterThan(0)
  const finished = await notesPlayed()
  expect(finished).toContain(659.25)
  expect(finished).not.toContain(880)

  // Past the quiet moment after that sound, a question: the rising chime.
  await page.waitForTimeout(1_600)
  await emit('blur')
  await say('ask', 'STUB ASKS PERMISSION')
  await expect(row()).toHaveAttribute('data-status', 'needs_you', { timeout: 15_000 })
  await expect.poll(async () => (await notesPlayed()).includes(880), { timeout: 3_000 }).toBe(true)
})

test('the palette turns sounds off, and nothing plays after that', async () => {
  await menu('CmdOrCtrl+K')
  await page.getByTestId('palette-input').fill('mute sound')
  await expect(page.getByTestId('palette-item').first()).toContainText('Turn sounds off')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Sounds off', { exact: true })).toBeVisible()
  await expect.poll(async () => (await state()).settings.sounds).toBe(false)
  await page.waitForTimeout(1_000)
  await notesPlayed()

  // Answering the question, then a finished reply while looking elsewhere: notified, but silent.
  await emit('blur')
  await say('quiet', 'echo: quiet')
  await expect(row()).toHaveAttribute('data-status', 'unread', { timeout: 15_000 })
  await page.waitForTimeout(1_000)
  expect(await notesPlayed()).toEqual([])

  await menu('CmdOrCtrl+K')
  await page.getByTestId('palette-input').fill('sound')
  await expect(page.getByTestId('palette-item').first()).toContainText('Turn sounds on')
  await page.keyboard.press('Escape')
})
