import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
async function writeTranscript(cwd: string, claudeId: string, lines: unknown[]): Promise<void> {
  const dir = join(e.env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${claudeId}.jsonl`), lines.map((l) => JSON.stringify(l) + '\n').join(''))
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
  await waitFor(async () => (await paneText(e.socket, id)).includes('STUB CLAUDE READY'), 15_000, 'ready')

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
  await waitFor(async () => (await paneText(e.socket, id)).includes('STUB CLAUDE READY'), 15_000, 'ready after resume')
  const back = (await state()).sessions.find((x) => x.id === id)!
  expect(back.archivedAt).toBeUndefined()
  expect(back.worktreePath).toBe(s.worktreePath)
  expect(existsSync(s.worktreePath!)).toBe(true)

  await page.getByTestId('terminal-claude').click()
  await page.keyboard.type('still there?')
  await page.keyboard.press('Enter')
  await waitFor(async () => (await paneText(e.socket, id)).includes('echo: still there?'), 15_000, 'echo after resume')
  await shot(page, '21-resumed')
})

test('a resume that fails shows the error, and Retry works once the cause is gone', async () => {
  const s = (await state()).sessions[0]
  await page.getByTestId('session-row').hover()
  await page.getByTestId('session-menu').click()
  await page.getByTestId('session-archive').click()
  await page.getByTestId('archive-confirm').click()
  await expect(page.getByTestId('archive-dialog')).toHaveCount(0, { timeout: 30_000 })
  // Something else takes the branch name: Pitwall's branch went with the archive, a user branch with that name is
  // checked out in the main folder.
  const git = (...args: string[]) => execFileSync('git', ['-C', e.repo.root, ...args], { env: e.repo.env })
  git('checkout', '-b', s.branch!)

  // The list stays open, with the last search, while it has nothing to show.
  await expect(page.getByTestId('archived-toggle')).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('archived-search')).toHaveValue('wombat')
  await page.getByTestId('archived-search').fill('')
  await page.getByTestId('archived-row').hover()
  await page.getByTestId('resume-session').click()
  const dialog = page.getByTestId('resume-dialog')
  await expect(dialog.locator('[data-step="worktree"]')).toHaveAttribute('data-state', 'failed', { timeout: 30_000 })
  await expect(dialog).toContainText(`Branch ${s.branch} is checked out in`)
  await shot(page, '22-resume-failed')
  git('checkout', 'main')
  await page.getByTestId('retry-resume').click()
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByTestId('session-row')).toHaveCount(1)
})
