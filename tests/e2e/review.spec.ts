import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { fromGit } from '../../src/main/git'
import { waitFor } from '../helpers/wait'
import { launchApp, makeE2eEnv, paneText, sessionIdOf, type E2eEnv } from './helpers'

const run = promisify(execFile)

test.describe.configure({ mode: 'serial' })

let e: E2eEnv
let app: ElectronApplication | undefined
let page: Page

test.beforeAll(async () => {
  e = await makeE2eEnv()
  const git = (...args: string[]): Promise<unknown> => run('git', ['-C', e.repo.root, ...args], { env: e.repo.env })
  await writeFile(join(e.repo.root, 'a.txt'), 'one\ntwo\nthree\nfour\n')
  await git('add', 'a.txt')
  await git('commit', '-m', 'add a.txt')
})
test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  await e?.cleanup()
})

test('comment on lines of a diff, then send the review to the agent', async () => {
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
  await page.getByTestId('session-title-input').fill('Review me')
  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('new-session-dialog')).toHaveCount(0, { timeout: 30_000 })
  const id = await waitFor(() => sessionIdOf(e), 15_000, 'session')
  await waitFor(async () => (await paneText(e, id)).includes('STUB CLAUDE READY'), 15_000, 'stub ready')

  const { stdout } = await run('git', ['-C', e.repo.root, 'worktree', 'list', '--porcelain'], { env: e.repo.env })
  const wt = stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => fromGit(l.slice(9))).find((p) => p !== e.repo.root)!
  await writeFile(join(wt, 'a.txt'), 'one\nTWO\nTHREE\nfour\n')

  await page.getByTestId('right-tab-changes').click()
  await expect(page.getByTestId('change-a.txt')).toBeVisible({ timeout: 20_000 })
  await page.getByTestId('change-a.txt').click()
  const diff = page.getByTestId('diff-a.txt')
  await expect(diff.locator('.cm-merge-b .cm-line').nth(2)).toContainText('THREE')

  // A selection in the old pane doesn't enable Comment.
  await diff.locator('.cm-merge-a .cm-line').nth(1).dblclick()
  await expect(page.getByTestId('diff-comment')).toBeDisabled()

  await diff.locator('.cm-merge-b .cm-line').nth(1).click({ position: { x: 2, y: 5 } })
  await expect(page.getByTestId('diff-comment')).toBeDisabled()
  await diff.locator('.cm-merge-b .cm-line').nth(2).click({ position: { x: 60, y: 5 }, modifiers: ['Shift'] })
  await expect(page.getByTestId('diff-comment')).toBeEnabled()
  await page.getByTestId('diff-comment').click()
  await page.getByTestId('review-note').fill('Use a constant')
  await page.getByTestId('review-save').click()

  await expect(page.getByTestId('review-item')).toHaveCount(1)
  await expect(page.getByTestId('review-item')).toContainText('a.txt (lines 2-3)')
  await expect(page.getByTestId('review-item')).toContainText('Use a constant')

  await page.getByTestId('review-send').click()
  await waitFor(async () => (await paneText(e, id)).includes('echo: Review of your changes (1 comment):'), 5_000, 'review echoed')
  await expect(page.getByTestId('review-item')).toHaveCount(0)
})
