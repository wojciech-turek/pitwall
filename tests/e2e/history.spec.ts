import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { PersistedState } from '../../src/shared/types'
import { waitFor } from '../helpers/wait'
import { launchApp, makeE2eEnv, paneText, shot, type E2eEnv } from './helpers'

test.describe.configure({ mode: 'serial' })
test.skip(process.env.PACKAGED === '1', 'dev build only')

let e: E2eEnv
let app: ElectronApplication | undefined
let page: Page

test.beforeAll(async () => { e = await makeE2eEnv() })
test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  await e?.cleanup()
})

const state = async (): Promise<PersistedState> => JSON.parse(await readFile(join(e.dataDir, 'state.json'), 'utf8'))
const claudeLog = (): Promise<string> => readFile(e.env.STUB_CLAUDE_LOG, 'utf8').catch(() => '')

/** A Claude transcript as Claude Code writes it: <config>/projects/<cwd, non-alphanumerics as '-'>/<id>.jsonl */
async function writeTranscript(cwd: string, claudeId: string, lines: unknown[]): Promise<string> {
  const dir = join(e.env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${claudeId}.jsonl`)
  await writeFile(file, lines.map((l) => JSON.stringify(l) + '\n').join(''))
  return file
}

/** A conversation run with plain `claude` in `cwd` on `branch`, as its transcript records it. */
const outsideChat = (cwd: string, typed: string, reply: string, branch = 'main'): unknown[] => {
  const at = { cwd, gitBranch: branch, isSidechain: false, userType: 'external', timestamp: new Date().toISOString() }
  return [
    { type: 'user', message: { role: 'user', content: typed }, ...at },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] }, ...at }
  ]
}

test('search an archived session by a word in its conversation, resume it, and the conversation continues', async () => {
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
  await page.getByTestId('session-title-input').fill('Invoice export')
  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('new-session-dialog')).toHaveCount(0, { timeout: 30_000 })
  const id = (await page.getByTestId('session-row').getAttribute('data-session-id'))!
  await waitFor(async () => (await paneText(e, id)).includes('STUB CLAUDE READY'), 15_000, 'ready')

  const s = (await state()).sessions.find((x) => x.id === id)!
  await writeTranscript(s.cwd, s.claudeSessionId, [
    { type: 'user', message: { role: 'user', content: 'Make the invoice exporter handle the wombat edge case' } },
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'consider the numbat' },
      { type: 'text', text: 'Done: wombat totals now round half-even.' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo platypus' } }
    ] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'platypus' }] } }
  ])

  await page.getByTestId('session-row').hover()
  await page.getByTestId('session-menu').click()
  await page.getByTestId('session-archive').click()
  await page.getByTestId('archive-confirm').click()
  await expect(page.getByTestId('archive-dialog')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByTestId('session-row')).toHaveCount(0)
  expect(existsSync(s.worktreePath!)).toBe(false)

  await page.getByTestId('archived-toggle').click()
  const search = page.getByTestId('archived-search')
  await search.fill('WOMBAT edge')
  await expect(page.getByTestId('archived-row')).toHaveCount(1)
  await expect(page.getByTestId('archived-snippet')).toContainText('wombat edge case')
  for (const hidden of ['platypus', 'numbat']) { // tool output and thinking aren't searched
    await search.fill(hidden)
    await expect(page.getByTestId('archived-row')).toHaveCount(0)
  }
  await search.fill('invoice')
  await expect(page.getByTestId('archived-row')).toHaveCount(1) // title
  await search.fill('wombat')
  await expect(page.getByTestId('archived-snippet')).toContainText('wombat')
  await shot(page, '20-archived-search')

  await page.getByTestId('archived-row').hover()
  await page.getByTestId('resume-session').click()
  await expect(page.getByTestId('resume-dialog')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByTestId('session-row')).toHaveCount(1)
  await expect(page.getByTestId('session-row')).toHaveAttribute('data-session-id', id)
  await expect(page.getByTestId('archived-list')).toHaveCount(0)
  await expect(page.locator('[data-testid="pane"][data-active="true"]')).toHaveAttribute('data-session-id', id)

  await waitFor(async () => (await claudeLog()).includes(`--resume ${s.claudeSessionId}`), 15_000, 'claude --resume')
  await waitFor(async () => (await paneText(e, id)).includes('STUB CLAUDE READY'), 15_000, 'ready after resume')
  const back = (await state()).sessions.find((x) => x.id === id)!
  expect(back.archivedAt).toBeUndefined()
  expect(back.worktreePath).toBe(s.worktreePath)
  expect(existsSync(s.worktreePath!)).toBe(true)

  await page.getByTestId('terminal-claude').click()
  await page.keyboard.type('still there?')
  await page.keyboard.press('Enter')
  await waitFor(async () => (await paneText(e, id)).includes('echo: still there?'), 15_000, 'echo after resume')
  await shot(page, '21-resumed')
})

test('a resume that fails shows the error, and Retry works once the cause is gone', async () => {
  const s = (await state()).sessions[0]
  await page.getByTestId('session-row').hover()
  await page.getByTestId('session-menu').click()
  await page.getByTestId('session-archive').click()
  await page.getByTestId('archive-confirm').click()
  await expect(page.getByTestId('archive-dialog')).toHaveCount(0, { timeout: 30_000 })
  expect((await state()).sessions[0].branchDeleted).toBe(true)
  // A branch of that name is back, checked out in the main folder: resume makes its own instead of taking it.
  const git = (...args: string[]) => execFileSync('git', ['-C', e.repo.root, ...args], { env: e.repo.env })
  git('checkout', '-b', s.branch!)
  // And the repo is moved away for now.
  const away = `${e.repo.root}-away`
  await rename(e.repo.root, away)

  // The list stays open, with the last search, while it has nothing to show.
  await expect(page.getByTestId('archived-toggle')).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('archived-search')).toHaveValue('wombat')
  await page.getByTestId('archived-search').fill('')
  await page.getByTestId('archived-row').hover()
  await page.getByTestId('resume-session').click()
  const dialog = page.getByTestId('resume-dialog')
  await expect(dialog.locator('[data-step="worktree"]')).toHaveAttribute('data-state', 'failed', { timeout: 30_000 })
  await expect(dialog).toContainText(`The repo isn't there any more: ${e.repo.root}`)
  await shot(page, '22-resume-failed')
  await rename(away, e.repo.root)
  await page.getByTestId('retry-resume').click()
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByTestId('session-row')).toHaveCount(1)
  const back = (await state()).sessions[0]
  expect(back.branch).toBe(`${s.branch}-2`)
  expect(back.worktreePath).toBe(s.worktreePath)
  expect(git('rev-parse', '--abbrev-ref', 'HEAD').toString().trim()).toBe(s.branch)
})

test("the folder row's clock lists outside conversations; picking one continues it in a new session", async () => {
  const root = e.repo.root
  const dialog = page.getByTestId('conversations-dialog')
  const openContinue = async (): Promise<void> => {
    await page.getByTestId('subproject-row').hover()
    await page.getByTestId('continue-conversation').click()
    await expect(dialog).toBeVisible()
  }
  // Nothing to continue yet: the open session's conversation is in the sidebar, so it isn't listed.
  await openContinue()
  await expect(dialog.getByRole('heading')).toHaveText('Continue a conversation · tax-service')
  await expect(dialog).toContainText('No past conversations in tax-service yet.')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  const claudeId = randomUUID()
  const file = await writeTranscript(root, claudeId,
    outsideChat(root, 'Fix the flaky login test', 'Found it: the pelican fixture raced the session cookie.'))
  const hourAgo = new Date(Date.now() - 3600_000)
  await utimes(file, hourAgo, hourAgo)
  const transcript = await readFile(file)
  const count = (await state()).sessions.length

  await openContinue()
  const row = dialog.locator(`[data-testid="conversation-row"][data-kind="outside"][data-id="${claudeId}"]`)
  await expect(row).toContainText('Fix the flaky login test')
  await expect(row).toContainText('outside Pitwall')
  await expect(row).toContainText('1h ago · main')
  await expect(dialog).toContainText(
    "A conversation from outside Pitwall continues in a new session on its own branch. Changes you haven't committed in tax-service stay there.")
  await shot(page, '23-continue-conversation')

  // Not in the title: found in the conversation, with where.
  await dialog.getByTestId('conversations-search').fill('pelican')
  await expect(dialog.getByTestId('conversation-row')).toHaveCount(1)
  await expect(row.getByTestId('conversation-snippet')).toContainText('pelican fixture')
  await row.click()
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByTestId('session-row')).toHaveCount(count + 1)
  const s = (await state()).sessions.find((x) => x.claudeSessionId === claudeId)!
  expect(s.title).toBe('Fix the flaky login test')
  expect(s.worktreePath).toBeTruthy()
  await expect(page.locator('[data-testid="pane"][data-active="true"]')).toHaveAttribute('data-session-id', s.id)

  await waitFor(async () => (await claudeLog()).includes(`--resume ${claudeId}`), 15_000, 'claude --resume')
  const log = await claudeLog()
  expect(log.split('\n').find((l) => l.includes(`--resume ${claudeId}`))).toContain('--system-prompt-snapshot off')
  expect(log).toContain(`NOTE=This conversation began in ${root}. It now continues in a separate git worktree at ${s.cwd}, on branch ${s.branch}.`)
  await waitFor(async () => (await paneText(e, s.id)).includes('STUB CLAUDE READY'), 15_000, 'ready')
  expect(await readFile(file)).toEqual(transcript) // only read, never changed
})

test('a conversation active minutes ago asks before continuing; Cancel starts nothing, Continue anyway does', async () => {
  const root = e.repo.root
  const claudeId = randomUUID()
  await writeTranscript(root, claudeId, outsideChat(root, 'Tidy up the release script', 'Starting with the changelog step.'))
  const count = (await state()).sessions.length

  await page.getByTestId('subproject-row').hover()
  await page.getByTestId('continue-conversation').click()
  const dialog = page.getByTestId('conversations-dialog')
  const row = dialog.locator(`[data-testid="conversation-row"][data-kind="outside"][data-id="${claudeId}"]`)
  await row.click()
  await expect(dialog).toContainText('This conversation was active 1 min ago and may still be open in a terminal. ' +
    'Continuing it in two places at once mixes them up.')
  await shot(page, '24-continue-recent')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog.getByTestId('continue-anyway')).toHaveCount(0)
  await expect(dialog.getByTestId('conversations-search')).toBeFocused()
  await expect(row).toBeVisible()
  expect((await state()).sessions).toHaveLength(count)
  expect(await claudeLog()).not.toContain(claudeId)

  await row.click()
  await dialog.getByTestId('continue-anyway').click()
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByTestId('session-row')).toHaveCount(count + 1)
  await waitFor(async () => (await claudeLog()).includes(`--resume ${claudeId}`), 15_000, 'claude --resume')
  expect((await state()).sessions.filter((x) => x.claudeSessionId === claudeId)).toHaveLength(1)
})

test('an archived session is listed too and opens the Resume dialog', async () => {
  const s = (await state()).sessions.find((x) => x.title === 'Invoice export')!
  const sessionRow = page.locator(`[data-testid="session-row"][data-session-id="${s.id}"]`)
  await sessionRow.hover()
  await sessionRow.getByTestId('session-menu').click()
  await page.getByTestId('session-archive').click()
  await page.getByTestId('archive-confirm').click()
  await expect(page.getByTestId('archive-dialog')).toHaveCount(0, { timeout: 30_000 })
  await expect(sessionRow).toHaveCount(0)

  await page.getByTestId('subproject-row').hover()
  await page.getByTestId('continue-conversation').click()
  const dialog = page.getByTestId('conversations-dialog')
  const row = dialog.locator(`[data-testid="conversation-row"][data-kind="archived"][data-id="${s.id}"]`)
  await expect(row).toContainText('Invoice export')
  await expect(row).not.toContainText('outside Pitwall')
  // The conversations continued above are Pitwall's now: in the sidebar, not here.
  await expect(dialog.locator('[data-testid="conversation-row"][data-kind="outside"]')).toHaveCount(0)
  await dialog.getByTestId('conversations-search').fill('wombat')
  await expect(row.getByTestId('conversation-snippet')).toContainText('wombat edge case')

  // The Resume dialog may come and go quickly: watch for it.
  await page.evaluate(`(() => {
    window.sawResume = false
    new MutationObserver((_, o) => {
      if (!document.querySelector('[data-testid="resume-dialog"]')) return
      window.sawResume = true
      o.disconnect()
    }).observe(document.body, { childList: true, subtree: true })
  })()`)
  const resumes = (await claudeLog()).split(`--resume ${s.claudeSessionId}`).length
  await page.keyboard.press('Enter') // the only row, picked from the search box
  await page.waitForFunction('window.sawResume === true')
  await expect(page.getByTestId('resume-dialog')).toHaveCount(0, { timeout: 30_000 })
  await expect(dialog).toHaveCount(0)
  await expect(sessionRow).toHaveCount(1)
  await expect(page.locator('[data-testid="pane"][data-active="true"]')).toHaveAttribute('data-session-id', s.id)
  await waitFor(async () => (await claudeLog()).split(`--resume ${s.claudeSessionId}`).length > resumes, 15_000, 'claude --resume')
})
