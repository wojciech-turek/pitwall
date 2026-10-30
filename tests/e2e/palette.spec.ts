import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { PersistedState } from '../../src/shared/types'
import { waitFor } from '../helpers/wait'
import { launchApp, makeE2eEnv, paneText, shot, type E2eEnv } from './helpers'

test.describe.configure({ mode: 'serial' })
test.skip(process.env.PACKAGED === '1', 'dev build only')

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

const palette = (): Locator => page.getByTestId('command-palette')
const input = (): Locator => page.getByTestId('palette-input')
const items = (): Locator => page.getByTestId('palette-item')
const selected = (): Locator => page.locator('[data-testid="palette-item"][data-selected="true"]')
const panes = (): Locator => page.getByTestId('pane')
const row = (title: string): Locator => page.getByTestId('session-row').filter({ hasText: title })
const state = async (): Promise<PersistedState> => JSON.parse(await readFile(join(e.dataDir, 'state.json'), 'utf8'))

/** Clicks the application-menu item with this accelerator, as pressing the keys does. */
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

/** Where the keyboard is: 'terminal:<session id>', 'editor', 'palette', or the focused element's tag. */
const focusIn = (): Promise<string> => page.evaluate(`(() => {
  const el = document.activeElement
  if (!el) return 'none'
  if (el.classList.contains('xterm-helper-textarea')) return 'terminal:' + el.closest('[data-testid="pane"]')?.getAttribute('data-session-id')
  if (el.closest('.cm-editor')) return 'editor'
  if (el.getAttribute('data-testid') === 'palette-input') return 'palette'
  return el.tagName.toLowerCase()
})()`) as Promise<string>

/** Types a line wherever the keyboard is, and checks it reached the session's Claude. */
async function typeTo(sessionId: string, text: string): Promise<void> {
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  await waitFor(async () => (await paneText(e, sessionId)).includes(`echo: ${text}`), 15_000, `echo: ${text}`)
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

/** A Claude transcript as Claude Code writes it: <config>/projects/<cwd, non-alphanumerics as '-'>/<id>.jsonl */
async function writeTranscript(cwd: string, claudeId: string, lines: unknown[]): Promise<void> {
  const dir = join(e.env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${claudeId}.jsonl`), lines.map((l) => JSON.stringify(l) + '\n').join(''))
}

test('⌘K over a focused terminal: Esc gives the keyboard back, Enter on a session opens it', async () => {
  // a few more files to find with ⌘P
  const git = (...args: string[]) => execFileSync('git', ['-C', e.repo.root, ...args], { env: e.repo.env })
  for (const f of ['src/invoice/export.ts', 'src/tax/rounding.ts', 'docs/release-notes.md']) {
    await mkdir(join(e.repo.root, f, '..'), { recursive: true })
    await writeFile(join(e.repo.root, f), `// ${f}\n`)
  }
  git('add', '-A')
  git('commit', '-qm', 'more files')

  ;({ app, page } = await launchApp(e.env))
  await page.getByTestId('create-first-project').click()
  await page.getByTestId('project-name-input').fill('Acme')
  await page.getByTestId('git-name-input').fill('Jane Doe')
  await page.getByTestId('git-email-input').fill('jane@acme.test')
  await page.getByTestId('save-project').click()
  await page.getByTestId('project-row').hover()
  await page.getByTestId('add-folder').click()
  alpha = await startSession('Invoice export')
  beta = await startSession('Tax rounding')
  await expect(panes()).toHaveAttribute('data-session-id', beta)

  await page.getByTestId('terminal-claude').click()
  expect(await focusIn()).toBe(`terminal:${beta}`)
  await menu('CmdOrCtrl+K')
  await expect(palette()).toBeVisible()
  await expect(palette()).toHaveAttribute('data-mode', 'commands')
  await expect.poll(focusIn).toBe('palette')
  // nothing typed: recent sessions (not the one you're in) and common actions
  await expect(items().first()).toHaveAttribute('data-session-id', alpha)
  await expect(page.locator('[data-testid="palette-item"][data-kind="session"]')).toHaveCount(1)
  await expect(page.locator('[data-testid="palette-item"][data-kind="action"]').first()).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(palette()).toHaveCount(0)
  await expect.poll(focusIn).toBe(`terminal:${beta}`)
  await typeTo(beta, 'still here')
  // a click outside closes it too, and gives the keyboard back the same way
  await menu('CmdOrCtrl+K')
  await expect.poll(focusIn).toBe('palette')
  await page.mouse.click(700, 850)
  await expect(palette()).toHaveCount(0)
  await expect.poll(focusIn).toBe(`terminal:${beta}`)

  // ⌘K again, type part of a title, Enter: it opens in the active pane and takes the keyboard
  await menu('CmdOrCtrl+K')
  await input().fill('invexp')
  await expect(selected()).toHaveAttribute('data-session-id', alpha)
  await expect(selected().locator('mark')).toHaveText(['Inv', 'exp'])
  await page.keyboard.press('Enter')
  await expect(palette()).toHaveCount(0)
  await expect(panes()).toHaveCount(1)
  await expect(panes()).toHaveAttribute('data-session-id', alpha)
  await expect.poll(focusIn).toBe(`terminal:${alpha}`)
  await typeTo(alpha, 'picked')
})

test('⌘Enter opens a session split to the right; arrows and the mouse move the selection', async () => {
  await menu('CmdOrCtrl+K')
  await input().fill('ta')
  const tax = page.locator('[data-testid="palette-item"][data-kind="session"]', { hasText: 'Tax rounding' })
  await expect(tax).toBeVisible()
  await expect(page.locator('[data-testid="palette-item"][data-kind="file"]').first()).toBeVisible()
  // clicking a heading or the footer keeps the keyboard in the box
  await page.locator('.palette-group').first().click()
  await page.locator('.palette-foot').click()
  expect(await focusIn()).toBe('palette')
  // arrows wrap around; the mouse selects what it moves over
  await page.keyboard.press('ArrowUp')
  await expect(selected()).toHaveCount(1)
  await expect(items().last()).toHaveAttribute('data-selected', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(items().first()).toHaveAttribute('data-selected', 'true')
  await tax.hover()
  await expect(tax).toHaveAttribute('data-selected', 'true')
  await expect(palette()).toContainText('split right')
  await page.keyboard.press('Meta+Enter')
  await expect(palette()).toHaveCount(0)
  await expect(panes()).toHaveCount(2)
  await expect(panes().nth(0)).toHaveAttribute('data-session-id', alpha)
  await expect(panes().nth(1)).toHaveAttribute('data-session-id', beta)
  await expect(panes().nth(1)).toHaveAttribute('data-active', 'true')
  await expect.poll(focusIn).toBe(`terminal:${beta}`)
  await typeTo(beta, 'split')

  // A notification click while the palette is open makes another pane active: Esc gives the keyboard to that pane.
  await panes().nth(0).getByTestId('terminal-claude').click()
  await expect.poll(focusIn).toBe(`terminal:${alpha}`)
  await menu('CmdOrCtrl+K')
  await expect.poll(focusIn).toBe('palette')
  await app!.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('pitwall:focusSession', id), beta)
  await expect(panes().nth(1)).toHaveAttribute('data-active', 'true')
  expect(await focusIn()).toBe('palette')
  await page.keyboard.press('Escape')
  await expect.poll(focusIn).toBe(`terminal:${beta}`)
  await typeTo(beta, 'followed')
})

test('actions: mute the project, close a pane; no palette over a dialog', async () => {
  await expect(page.getByTestId('project-muted')).toHaveCount(0)
  await menu('CmdOrCtrl+K')
  await input().fill('mute')
  await expect(selected()).toHaveAttribute('data-action', 'mute')
  await expect(selected()).toContainText('Mute notifications from Acme')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('project-muted')).toBeVisible()
  await expect(palette()).toHaveCount(0)
  await expect.poll(focusIn).toBe(`terminal:${beta}`)

  await menu('CmdOrCtrl+K')
  await input().fill('unmute')
  await page.keyboard.press('Enter') // at once: Enter acts on what was typed, never on an older list
  await expect(page.getByTestId('project-muted')).toHaveCount(0)

  await menu('CmdOrCtrl+K')
  await input().fill('close pane')
  await expect(selected()).toHaveAttribute('data-action', 'close-pane')
  await page.keyboard.press('Enter')
  await expect(panes()).toHaveCount(1)
  await expect(panes()).toHaveAttribute('data-session-id', alpha)
  await expect.poll(focusIn).toBe(`terminal:${alpha}`)

  // an action that opens a dialog closes the palette; ⌘K does nothing while a dialog is open
  await menu('CmdOrCtrl+K')
  await input().fill('settings')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('settings-dialog')).toBeVisible()
  await expect(palette()).toHaveCount(0)
  await menu('CmdOrCtrl+K')
  await menu('CmdOrCtrl+P')
  await page.waitForTimeout(300)
  await expect(palette()).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0)
  await expect.poll(focusIn).toBe(`terminal:${alpha}`)
})

test('⌘P opens a file of the active session; over the editor, Esc puts the cursor back where it was', async () => {
  await menu('CmdOrCtrl+P')
  await expect(palette()).toHaveAttribute('data-mode', 'files')
  await expect(input()).toHaveAttribute('placeholder', 'Go to file in Invoice export')
  await expect(page.locator('[data-testid="palette-item"][data-kind="file"]')).toHaveCount(4)
  await expect(page.locator('[data-testid="palette-item"]:not([data-kind="file"])')).toHaveCount(0)
  await input().fill('tax/rnd')
  await expect(selected()).toHaveAttribute('data-path', 'src/tax/rounding.ts')
  // ⌘K switches to everything, ⌘K again closes
  await menu('CmdOrCtrl+K')
  await expect(palette()).toHaveAttribute('data-mode', 'commands')
  await expect(input()).toHaveValue('')
  await menu('CmdOrCtrl+K')
  await expect(palette()).toHaveCount(0)

  await menu('CmdOrCtrl+P')
  await input().fill('round')
  await expect(selected()).toHaveAttribute('data-path', 'src/tax/rounding.ts')
  await page.keyboard.press('Enter')
  await expect(palette()).toHaveCount(0)
  const editor = page.getByTestId('editor-src/tax/rounding.ts')
  await expect(editor).toBeVisible()
  await expect.poll(focusIn).toBe('editor')

  await page.keyboard.press('Meta+ArrowDown') // end of the file
  await menu('CmdOrCtrl+K')
  await expect.poll(focusIn).toBe('palette')
  await page.keyboard.press('Escape')
  await expect.poll(focusIn).toBe('editor')
  await page.keyboard.type('Z')
  await expect(editor.locator('.cm-line').first()).toHaveText('// src/tax/rounding.ts')
  await expect(editor.locator('.cm-line').last()).toHaveText('Z')
  await menu('CmdOrCtrl+W')
  await page.getByTestId('discard-confirm').click()
  await expect(editor).toHaveCount(0)
})

test('typing a word from an archived session\'s conversation finds it; Enter resumes it', async () => {
  // archive "Tax rounding" from the palette, after giving it a conversation to find
  const s = (await state()).sessions.find((x) => x.id === beta)!
  await writeTranscript(s.cwd, s.claudeSessionId, [
    { type: 'user', message: { role: 'user', content: 'Round the wombat totals half-even' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done: wombat totals round half-even.' }] } }
  ])
  await menu('CmdOrCtrl+K')
  await input().fill('tax')
  await page.keyboard.press('Enter')
  await expect(panes()).toHaveAttribute('data-session-id', beta)
  await menu('CmdOrCtrl+K')
  await input().fill('archive')
  await expect(selected()).toHaveAttribute('data-action', 'archive')
  await page.keyboard.press('Enter')
  await page.getByTestId('archive-confirm').click()
  await expect(page.getByTestId('archive-dialog')).toHaveCount(0, { timeout: 30_000 })
  await expect(row('Tax rounding')).toHaveCount(0)

  // "Archived sessions" opens the sidebar list, ready to search
  await expect(page.getByTestId('archived-toggle')).toHaveAttribute('aria-expanded', 'false')
  await menu('CmdOrCtrl+K')
  await input().fill('archived')
  await expect(selected()).toHaveAttribute('data-action', 'archived')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('archived-toggle')).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('archived-search')).toBeFocused()
  await page.getByTestId('archived-toggle').click()

  await row('Invoice export').click() // files come from the active session

  await menu('CmdOrCtrl+K')
  await input().fill('wombat')
  const past = page.locator('[data-testid="palette-item"][data-kind="history"]')
  await expect(past).toHaveCount(1)
  await expect(past).toHaveAttribute('data-session-id', beta)
  await expect(past).toContainText('Tax rounding')
  await expect(past.getByTestId('palette-snippet')).toContainText('wombat totals')
  await expect(past).toContainText('archived')

  // the screenshot: several groups at once
  await input().fill('in')
  await expect(page.locator('[data-testid="palette-item"][data-kind="session"]')).toHaveCount(1)
  await expect(page.locator('[data-testid="palette-item"][data-kind="file"]').first()).toBeVisible()
  await expect(past).toHaveCount(1)
  await shot(page, 'palette')
  await input().fill('wombat')
  await expect(past).toContainText('wombat totals')
  await shot(page, 'palette-past-session')

  await past.click()
  await expect(palette()).toHaveCount(0)
  await expect(page.getByTestId('resume-dialog')).toHaveCount(0, { timeout: 30_000 })
  await expect(row('Tax rounding')).toHaveCount(1)
  await expect(page.locator('[data-testid="pane"][data-active="true"]')).toHaveAttribute('data-session-id', beta)
  await waitFor(async () => (await paneText(e, beta)).includes('STUB CLAUDE READY'), 15_000, 'ready after resume')
})

// Synthesized keys never reach the native menu (it only sees real OS key events), so the menu items above stand in
// for ⌘K/⌘P. What the menu needs from the page: a keydown nobody handled, over a terminal or the editor alike.
test('⌘K and ⌘P keydowns over a terminal or the editor are left to the app menu, never typed', async () => {
  await page.evaluate(`(() => {
    window.paletteKeys = []
    window.addEventListener('keydown', (ev) => {
      if (ev.metaKey && /^[kp]$/i.test(ev.key)) window.paletteKeys.push(ev.key + ':' + (ev.defaultPrevented ? 'handled' : 'free'))
    })
  })()`)
  await page.getByTestId('terminal-claude').click()
  expect(await focusIn()).toBe(`terminal:${beta}`)
  await page.keyboard.press('Meta+k')
  await page.keyboard.press('Meta+p')
  await typeTo(beta, 'after') // the prompt got nothing from ⌘K/⌘P

  await menu('CmdOrCtrl+P')
  await input().fill('readme')
  await expect(selected()).toHaveAttribute('data-path', 'README.md')
  await page.keyboard.press('Enter')
  await expect.poll(focusIn).toBe('editor')
  await page.keyboard.press('Meta+k')
  await page.keyboard.press('Meta+p')
  expect(await page.evaluate('window.paletteKeys')).toEqual(['k:free', 'p:free', 'k:free', 'p:free'])
  await expect(page.locator('.tab-dirty')).toHaveCount(0)
  await menu('CmdOrCtrl+W')
  await expect(page.getByTestId('editor-README.md')).toHaveCount(0)
})
