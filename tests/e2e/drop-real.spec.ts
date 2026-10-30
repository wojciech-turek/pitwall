import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { waitFor } from '../helpers/wait'
import { launchApp, makeE2eEnv, paneText, sessionIdOf, type E2eEnv } from './helpers'

// A Finder drag goes through Chromium's own drag pipeline (hit testing, dragenter, native File paths).
// CDP Input.dispatchDragEvent drives that same pipeline, unlike a DragEvent dispatched from page JS.
const PACKAGED = process.env.PACKAGED === '1'

let e: E2eEnv
let app: ElectronApplication | undefined
let page: Page

test.beforeAll(async () => { e = await makeE2eEnv() })
test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  await e?.cleanup()
})

test('files dragged from Finder or Cursor onto the Claude terminal paste their paths', async () => {
  const exe = PACKAGED ? join(process.cwd(), 'release/mac-arm64/Pitwall.app/Contents/MacOS/Pitwall') : undefined
  ;({ app, page } = await launchApp(e.env, exe))
  await page.getByTestId('create-first-project').click()
  await page.getByTestId('project-name-input').fill('Acme')
  await page.getByTestId('git-name-input').fill('Jane Doe')
  await page.getByTestId('git-email-input').fill('jane@acme.test')
  await page.getByTestId('save-project').click()
  await page.getByTestId('project-row').hover()
  await page.getByTestId('add-folder').click()
  await page.getByTestId('subproject-row').hover()
  await page.getByTestId('new-session').click()
  await page.getByTestId('session-title-input').fill('Drop test')
  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('new-session-dialog')).toHaveCount(0, { timeout: 30_000 })
  const sessionId = await waitFor(() => sessionIdOf(e.socket), 15_000, 'tmux session')
  await waitFor(async () => (await paneText(e.socket, sessionId)).includes('STUB CLAUDE READY'), 15_000, 'STUB CLAUDE READY')
  await expect(page.getByTestId('terminal-claude')).toBeVisible()

  const file = join(e.tmp, 'dropped file.txt')
  await writeFile(file, 'x')
  const box = (await page.getByTestId('terminal-claude').boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const cdp = await page.context().newCDPSession(page)
  const data = { items: [], files: [file], dragOperationsMask: 1 | 2 | 16 }
  await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data })
  await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data })
  await cdp.send('Input.dispatchDragEvent', { type: 'drop', x, y, data })

  await waitFor(async () => (await paneText(e.socket, sessionId)).includes('dropped file.txt'), 10_000, 'dropped path in prompt')

  // A drag from Cursor's file list carries a file link, not a file.
  const link = { items: [{ mimeType: 'text/uri-list', data: pathToFileURL(join(e.tmp, 'linked file.ts')).href }], dragOperationsMask: 1 | 2 | 16 }
  for (const type of ['dragEnter', 'dragOver', 'drop'] as const) await cdp.send('Input.dispatchDragEvent', { type, x, y, data: link })
  await waitFor(async () => (await paneText(e.socket, sessionId)).includes('linked file.ts'), 10_000, 'linked path in prompt')
})
