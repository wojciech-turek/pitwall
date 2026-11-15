import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { waitFor } from '../helpers/wait'
import { launchApp, makeE2eEnv, paneText, shot, type E2eEnv } from './helpers'

test.describe.configure({ mode: 'serial' })
test.skip(process.env.PACKAGED === '1', 'dev build only')

let e: E2eEnv
let app: ElectronApplication | undefined
let page: Page

test.beforeAll(async () => {
  e = await makeE2eEnv()
  // The stub's `claude auth login` signs in as this.
  e.env.STUB_CLAUDE_LOGIN_EMAIL = 'b@example.com'
})
test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  await e?.cleanup()
})

// Account folders are real paths (a temp folder is reached through a symlink on macOS).
const accountsDir = (): string => join(realpathSync(e.dataDir), 'claude-accounts')
const sessionFile = (id: string, name: string): Promise<string> => readFile(join(e.dataDir, 'sessions', id, name), 'utf8')
const claudeLog = async (): Promise<string[]> => (await readFile(e.env.STUB_CLAUDE_LOG, 'utf8').catch(() => '')).split('\n')
const idOf = async (title: string): Promise<string> =>
  (await page.getByTestId('session-row').filter({ hasText: title }).getAttribute('data-session-id'))!

async function startSession(title: string): Promise<string> {
  await page.getByTestId('subproject-row').hover()
  await page.getByTestId('new-session').click()
  await page.getByTestId('session-title-input').fill(title)
  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('new-session-dialog')).toHaveCount(0, { timeout: 30_000 })
  const id = await idOf(title)
  await waitFor(async () => (await paneText(e, id)).includes('STUB CLAUDE READY'), 15_000, `${title} ready`)
  return id
}

test('add a Claude account, switch to it with the running session, and carry on in the same conversation', async () => {
  ;({ app, page } = await launchApp(e.env))
  await page.getByTestId('create-first-project').click()
  await page.getByTestId('project-name-input').fill('Acme')
  await page.getByTestId('git-name-input').fill('Jane Doe')
  await page.getByTestId('git-email-input').fill('jane@acme.test')
  await page.getByTestId('save-project').click()
  await page.getByTestId('project-row').hover()
  await page.getByTestId('add-folder').click()
  const alpha = await startSession('Alpha')
  const conversation = (await sessionFile(alpha, 'claude-id')).trim()
  expect(await sessionFile(alpha, 'env.sh')).not.toContain('PITWALL_CLAUDE_ACCOUNT')
  // One account, nothing to switch to, nowhere to move a session.
  await expect(page.getByTestId('usage-account')).toHaveCount(0)
  await expect(page.getByTestId('move-menu')).toHaveCount(0)

  // Add account: the stub signs in in the dialog's terminal; the account is listed, and never made active by that.
  await page.getByTestId('account-add').click()
  await expect(page.getByTestId('add-account-dialog')).toBeVisible()
  await expect(page.getByTestId('add-account-dialog')).toHaveCount(0, { timeout: 20_000 })
  await expect(page.getByTestId('usage-account')).toHaveCount(2)
  await expect(page.getByTestId('usage-account').nth(1)).toHaveText('b@example.com')
  await expect(page.getByTestId('account-switch-1')).toBeVisible()
  await expect(page.getByTestId('account-switch-0')).toHaveCount(0)
  await expect(page.getByTestId('account-nousage-1')).toHaveText('No usage yet')
  await shot(page, 'accounts-1-added')
  // Signed in to a folder of its own, not the default one.
  expect((await claudeLog()).filter((l) => l.startsWith('auth login'))).toEqual([expect.stringContaining(accountsDir())])

  // Switch: one session runs on the other account, so the dialog asks; Move sessions restarts it on the new one.
  await page.getByTestId('account-switch-1').click()
  const dialog = page.getByTestId('switch-account-dialog')
  await expect(dialog).toContainText('Move 1 running session to b@example.com too?')
  await expect(dialog).toContainText('It moves now.')
  await shot(page, 'accounts-1b-switch-dialog')
  await page.getByTestId('switch-move').click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('usage-account').first()).toHaveText('b@example.com')
  await waitFor(async () => (await claudeLog()).some((l) => l.startsWith(`--resume ${conversation} `)), 15_000, 'the same conversation resumed')
  expect(await sessionFile(alpha, 'env.sh')).toContain(`export CLAUDE_CONFIG_DIR='${accountsDir()}`)
  // It started there: the move is done, and the terminal attached again by itself.
  await waitFor(async () => !existsSync(join(e.dataDir, 'sessions', alpha, 'moved-from')), 15_000, 'the move settled')
  await expect(page.getByTestId('move-waiting')).toHaveCount(0)
  await waitFor(async () => (await paneText(e, alpha)).includes('STUB CLAUDE READY'), 15_000, 'running on the new account')
  await shot(page, 'accounts-2-moved')
  // Never a new conversation for it.
  expect((await claudeLog()).filter((l) => l.startsWith(`--session-id ${conversation} `))).toHaveLength(1)
})

test('a new session starts on the active account', async () => {
  const beta = await startSession('Beta')
  expect(await sessionFile(beta, 'env.sh')).toContain(`export CLAUDE_CONFIG_DIR='${accountsDir()}`)
})

test("a conversation that won't resume on the other account goes back where it was, with a message, never a new conversation", async () => {
  const alpha = await idOf('Alpha')
  const conversation = (await sessionFile(alpha, 'claude-id')).trim()
  // The default account can't resume it (the stub refuses there).
  // (And the conversation has something in it: Claude keeps a transcript of it, which the stub doesn't write.)
  await mkdir(join(e.env.CLAUDE_CONFIG_DIR, 'projects', '-stub'), { recursive: true })
  await writeFile(join(e.env.CLAUDE_CONFIG_DIR, 'projects', '-stub', `${conversation}.jsonl`), '{}\n')
  await writeFile(join(e.env.CLAUDE_CONFIG_DIR, '.stub-resume-fail'), '')
  await page.getByTestId('session-row').filter({ hasText: 'Alpha' }).click()
  await page.getByTestId('move-menu').click()
  await page.getByTestId('move-to-default').click()
  await expect(page.getByTestId('move-failed')).toContainText("Couldn't continue this conversation on", { timeout: 20_000 })
  await waitFor(async () => (await sessionFile(alpha, 'env.sh')).includes(`export CLAUDE_CONFIG_DIR='${accountsDir()}`), 15_000, 'back on b@example.com')
  expect(existsSync(join(e.dataDir, 'sessions', alpha, 'moved-from'))).toBe(false)
  await waitFor(async () => (await paneText(e, alpha)).includes('STUB CLAUDE READY'), 15_000, 'running again')
  expect((await claudeLog()).filter((l) => l.startsWith(`--session-id ${conversation} `))).toHaveLength(1)
  // The message outlives the session starting again, until it is dismissed.
  await expect(page.getByTestId('move-failed')).toBeVisible()
  await page.getByTestId('move-dismiss').click()
  await expect(page.getByTestId('move-failed')).toHaveCount(0)
})

test('an account that sessions are using is not removed', async () => {
  await page.getByTestId('account-menu-0').click()
  await page.getByTestId('account-remove-0').click()
  await expect(page.getByText('Move or archive the 2 sessions using this account first.')).toBeVisible()
  await expect(page.getByTestId('usage-account')).toHaveCount(2)
  expect((await claudeLog()).some((l) => l.startsWith('auth logout'))).toBe(false)
})
