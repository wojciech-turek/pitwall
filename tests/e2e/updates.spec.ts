import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp, makeE2eEnv, shot, type E2eEnv } from './helpers'

// Runs against the dev build, or the packaged app with PACKAGED=1. Never against the real GitHub: the app is pointed
// at a local server that serves a releases list like GitHub's.
const PACKAGED = process.env.PACKAGED === '1'
const packagedExe = join(process.cwd(), 'release/mac-arm64/Pitwall.app/Contents/MacOS/Pitwall')

const CURRENT = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version
const [major, minor] = CURRENT.split('.').map(Number)
const NEWER = `${major}.${minor + 1}.0`
const NEWER_URL = `https://github.com/wojciech-turek/pitwall/releases/tag/v${NEWER}`
const SCRIPT_LINE = '<script>window.__pwned = true</script>'
const NOTES = [
  '### Added', '',
  '- **Update notices** with the changelog of every newer version',
  '- See [the docs](https://example.com/docs)', '',
  SCRIPT_LINE, '',
  '<img src=x onerror="window.__pwned = true">'
].join('\r\n')
const HOWTO = 'To update, download the DMG, quit Pitwall and drag the new app into Applications. ' +
  'Your agents keep running and reconnect when you reopen it.'

const release = (tag: string, o: Record<string, unknown>): Record<string, unknown> => ({
  tag_name: tag, name: tag, draft: false, prerelease: false, published_at: '2026-10-29T12:00:00Z',
  html_url: `https://github.com/wojciech-turek/pitwall/releases/tag/${tag}`, ...o
})
const NEWER_RELEASE = release(`v${NEWER}`, { name: `Pitwall ${NEWER}`, body: NOTES, html_url: NEWER_URL })
const OLDER_RELEASE = release('v0.0.1', { body: 'OLDER-NOTES' })
const RELEASES = [
  release(`v${major + 9}.0.0`, { draft: true, body: 'DRAFT-NOTES' }),
  release(`v${major + 8}.0.0`, { prerelease: true, body: 'PRERELEASE-NOTES' }),
  NEWER_RELEASE,
  OLDER_RELEASE
]

type Mode = 'releases' | 'rate-limited' | 'older-only'
let mode: Mode = 'releases'
const requests: { url?: string; userAgent?: string }[] = []
let server: Server
let feedUrl = ''

test.describe.configure({ mode: 'serial' })

let e: E2eEnv
let app: ElectronApplication | undefined
let page: Page

test.beforeAll(async () => {
  e = await makeE2eEnv()
  server = createServer((req, res) => {
    requests.push({ url: req.url, userAgent: req.headers['user-agent'] })
    if (mode === 'rate-limited') {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ message: 'API rate limit exceeded' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(mode === 'older-only' ? [OLDER_RELEASE] : RELEASES))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  feedUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/repos/wojciech-turek/pitwall/releases`
})
test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  await e?.cleanup()
  await new Promise((r) => server?.close(r))
})

const launch = async (): Promise<void> => {
  ;({ app, page } = await launchApp({ ...e.env, PITWALL_RELEASES_URL: feedUrl }, PACKAGED ? packagedExe : undefined))
}

/** Replaces shell.openExternal in main, so nothing opens a browser; returns what was opened. */
async function stubOpenExternal(): Promise<() => Promise<string[]>> {
  await app!.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __opened: string[] }
    g.__opened = []
    shell.openExternal = async (url: string) => { g.__opened.push(url) }
  })
  return () => app!.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)
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

test('a newer release shows a pill; the dialog lists only it, with its notes as plain text; Download opens it', async () => {
  await launch()
  const opened = await stubOpenExternal()
  await expect(page.getByTestId('create-first-project')).toBeVisible()

  // The first check runs about 10 s after start.
  const pill = page.getByTestId('update-pill')
  await expect(pill).toHaveText(`Update available · ${NEWER}`, { timeout: 30_000 })
  expect(requests.length).toBeGreaterThanOrEqual(1)
  expect(requests[0]).toEqual({ url: '/repos/wojciech-turek/pitwall/releases', userAgent: `Pitwall/${CURRENT}` })
  await shot(page, 'update-pill')

  await pill.click()
  const dialog = page.getByTestId('update-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('h2')).toHaveText(`Pitwall ${NEWER} is available`)
  await expect(dialog.getByTestId('update-current')).toHaveText(`You have ${CURRENT}.`)
  await expect(dialog.getByTestId('update-release')).toHaveCount(1)
  await expect(dialog.getByTestId('update-release')).toHaveAttribute('data-version', NEWER)
  await expect(dialog.locator('.update-release-date')).toHaveText(/2026/) // the date, in the user's locale
  for (const hidden of ['DRAFT-NOTES', 'PRERELEASE-NOTES', 'OLDER-NOTES']) await expect(dialog).not.toContainText(hidden)
  await expect(dialog.locator('strong')).toHaveText('Update notices')
  // HTML in the notes is shown as text; nothing runs.
  await expect(dialog).toContainText(SCRIPT_LINE)
  await expect(dialog).toContainText('<img src=x onerror="window.__pwned = true">')
  await expect(dialog.locator('script, img')).toHaveCount(0)
  expect(await page.evaluate(() => (globalThis as unknown as { __pwned?: boolean }).__pwned)).toBeUndefined()
  await expect(dialog).toContainText(HOWTO)
  await shot(page, 'update-dialog')

  // A link in the notes opens in the browser, not in the app.
  await dialog.getByRole('link', { name: 'the docs' }).click()
  await expect.poll(opened).toEqual(['https://example.com/docs'])
  await expect(dialog).toBeVisible()

  await dialog.getByRole('button', { name: 'Later' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(pill).toBeVisible()

  await pill.click()
  await page.getByTestId('update-download').click()
  await expect.poll(opened).toEqual(['https://example.com/docs', NEWER_URL])
  await expect(dialog).toHaveCount(0)
})

test('Check now in Settings reports what it found; a failed check keeps the pill', async () => {
  await menu('CmdOrCtrl+,')
  const settings = page.getByTestId('settings-dialog')
  await expect(settings).toBeVisible()
  await expect(page.getByTestId('setting-check-updates')).toBeChecked()
  const result = page.getByTestId('check-updates-result')
  const before = requests.length

  await page.getByTestId('check-updates-now').click()
  await expect(result).toHaveText(`Pitwall ${NEWER} is available.`)
  expect(requests.length).toBe(before + 1)

  mode = 'rate-limited'
  await page.getByTestId('check-updates-now').click()
  await expect(result).toHaveText("Couldn't reach GitHub.")
  await expect(page.getByTestId('update-pill')).toHaveText(`Update available · ${NEWER}`)

  mode = 'older-only'
  await page.getByTestId('check-updates-now').click()
  await expect(result).toHaveText("You're up to date.")
  await expect(page.getByTestId('update-pill')).toHaveCount(0)
  await shot(page, 'update-settings')
  mode = 'releases'

  // Turn automatic checks off.
  await page.getByTestId('setting-check-updates').uncheck()
  await page.getByTestId('settings-save').click()
  await expect(settings).toHaveCount(0)
  const state = async (): Promise<{ settings: Record<string, unknown> }> =>
    JSON.parse(await readFile(join(e.dataDir, 'state.json'), 'utf8'))
  await expect.poll(async () => (await state()).settings.checkForUpdates).toBe(false)
  expect((await state()).settings.monoFontSize).toBe(13)
})

test('with checks off, a relaunch makes no request and shows no pill', async () => {
  await app!.close()
  app = undefined
  requests.length = 0
  await launch()
  await expect(page.getByTestId('create-first-project')).toBeVisible()
  await page.waitForTimeout(13_000) // past the first check's delay
  await expect(page.getByTestId('update-pill')).toHaveCount(0)
  expect(requests).toEqual([])

  await menu('CmdOrCtrl+,')
  await expect(page.getByTestId('setting-check-updates')).not.toBeChecked()
})
