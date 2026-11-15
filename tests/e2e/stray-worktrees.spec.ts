import { execFile } from 'node:child_process'
import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp, makeE2eEnv, shot, type E2eEnv } from './helpers'

test.skip(process.env.PACKAGED === '1', 'dev build only')
test.skip(process.platform === 'win32', 'worktree clean-up is checked on macOS and Linux (lsof)')

const run = promisify(execFile)
let e: E2eEnv
let app: ElectronApplication | undefined
let page: Page

test.beforeAll(async () => { e = await makeE2eEnv() })
test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  await e?.cleanup()
})

const git = (cwd: string, ...args: string[]) => run('git', args, { cwd, env: e.repo.env })
const exists = (p: string) => stat(p).then(() => true, () => false)

test('"Clean up worktrees…" lists strays, picks the merged one, and removes only that', async () => {
  // What an agent leaves behind: worktrees made with plain `git worktree add`, outside Pitwall.
  const merged = join(e.tmp, 'agent-wts', 'merged-one')
  const unmerged = join(e.tmp, 'agent-wts', 'unmerged-one')
  await git(e.repo.root, 'worktree', 'add', '-q', '-b', 'merged-one', merged, 'main')
  await git(e.repo.root, 'worktree', 'add', '-q', '-b', 'unmerged-one', unmerged, 'main')
  await writeFile(join(unmerged, 'wip.txt'), 'work\n')
  await git(unmerged, 'add', '-A')
  await git(unmerged, 'commit', '-q', '-m', 'unmerged work')

  ;({ app, page } = await launchApp(e.env))
  await page.getByTestId('create-first-project').click()
  await page.getByTestId('project-name-input').fill('Acme')
  await page.getByTestId('git-name-input').fill('Jane Doe')
  await page.getByTestId('git-email-input').fill('jane@acme.test')
  await page.getByTestId('save-project').click()
  await page.getByTestId('project-row').hover()
  await page.getByTestId('add-folder').click()
  await expect(page.getByTestId('subproject-row')).toHaveCount(1)

  await page.getByTestId('subproject-row').hover()
  await page.getByTestId('subproject-menu').click()
  await page.getByTestId('subproject-cleanup').click()

  const rows = page.getByTestId('stray-row')
  await expect(rows).toHaveCount(2)
  // Git deletes a removed worktree's ignored files with it: the dialog says so before anything goes.
  await expect(page.getByTestId('stray-dialog')).toContainText('also deletes its ignored files, such as .env files, local databases and build output')
  const mergedRow = rows.filter({ hasText: 'merged-one' }).filter({ hasNotText: 'unmerged-one' })
  const unmergedRow = rows.filter({ hasText: 'unmerged-one' })
  await expect(mergedRow.getByTestId('stray-check')).toBeChecked()
  await expect(unmergedRow.getByTestId('stray-check')).not.toBeChecked()
  await expect(unmergedRow.getByTestId('stray-check')).toBeDisabled()
  await expect(page.getByTestId('stray-remove')).toHaveText(/^Remove 1 worktree( \(.+\))?$/)
  await shot(page, 'stray-worktrees')

  await page.getByTestId('stray-remove').click()
  await expect(page.getByTestId('stray-dialog')).toHaveCount(0)
  await expect(page.locator('.toast')).toContainText('Removed 1 worktree')
  expect(await exists(merged)).toBe(false)
  expect(await exists(unmerged)).toBe(true)
  const branches = (await git(e.repo.root, 'branch', '--format=%(refname:short)')).stdout
  expect(branches.split('\n')).not.toContain('merged-one')
  expect(branches.split('\n')).toContain('unmerged-one')
})
