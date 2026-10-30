import { readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { waitFor } from '../helpers/wait'
import { launchApp, makeE2eEnv, paneText, sessionIdOf, shot, tmux, type E2eEnv } from './helpers'

const run = promisify(execFile)
const PACKAGED = process.env.PACKAGED === '1'

test.describe.configure({ mode: 'serial' })

let e: E2eEnv
let app: ElectronApplication | undefined
let page: Page
let sessionId = ''

test.beforeAll(async () => { e = await makeE2eEnv() })
test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  await e?.cleanup()
})

async function typeLine(text: string): Promise<void> {
  await page.getByTestId('terminal-claude').click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

test.describe('dev build', () => {
  test.skip(PACKAGED, 'packaged run only')

  test('create project, add repo, start session, agent replies', async () => {
    ;({ app, page } = await launchApp(e.env))
    await expect(page.getByTestId('create-first-project')).toBeVisible()
    await expect(page.getByTestId('usage-meter')).toHaveText("Usage shows after Claude's next reply")
    await shot(page, '1-empty-state')

    await page.getByTestId('create-first-project').click()
    await page.getByTestId('project-name-input').fill('Acme')
    await expect(page.getByTestId('ssh-key-select').locator('option', { hasText: 'id_test' })).toHaveCount(1)
    await page.getByTestId('ssh-key-select').selectOption({ label: 'id_test' })
    await expect(page.getByTestId('gh-account-select').locator('option', { hasText: 'dev-work' })).toHaveCount(1)
    await page.getByTestId('gh-account-select').selectOption('dev-work')
    await page.getByTestId('git-name-input').fill('Jane Doe')
    await page.getByTestId('git-email-input').fill('jane@acme.test')
    await shot(page, '2-project-dialog')
    await page.getByTestId('save-project').click()
    await expect(page.getByTestId('project-row')).toContainText('Acme')
    await expect(page.getByTestId('project-row')).toContainText('dev-work')

    await page.getByTestId('project-row').hover()
    await page.getByTestId('add-folder').click()
    await expect(page.getByTestId('subproject-row')).toContainText('tax-service')
    await shot(page, '3-sidebar-with-folder')

    await page.getByTestId('subproject-row').hover()
    await page.getByTestId('new-session').click()
    await page.getByTestId('session-title-input').fill('Fix tax rounding')
    await expect(page.getByTestId('branch-input')).toHaveValue('pitwall/fix-tax-rounding')
    await shot(page, '4-new-session-dialog')
    await page.getByTestId('start-session').click()
    await expect(page.getByTestId('new-session-dialog')).toHaveCount(0, { timeout: 30_000 })

    await expect(page.getByTestId('session-row')).toHaveCount(1)
    sessionId = await waitFor(() => sessionIdOf(e.socket), 15_000, 'tmux session')
    await waitFor(async () => (await paneText(e.socket, sessionId)).includes('STUB CLAUDE READY'), 15_000, 'STUB CLAUDE READY')
    await expect(page.getByTestId('terminal-claude')).toBeVisible()
    await shot(page, '5-session-running')

    await typeLine('hello')
    await waitFor(async () => (await paneText(e.socket, sessionId)).includes('echo: hello'), 15_000, 'echo: hello')
    await expect(page.getByTestId('session-row')).toHaveAttribute('data-status', /^(read|unread)$/)

    // The stub's status line reports 42% (5h) and 18% (week); the meter picks it up.
    await expect(page.getByTestId('usage-5h')).toContainText('42%')
    await expect(page.getByTestId('usage-5h')).toContainText(/resets (\w{3} )?\d\d:\d\d/)
    await expect(page.getByTestId('usage-week')).toContainText('18%')
    await expect(page.getByTestId('usage-week')).toContainText(/resets \w{3} \d\d:\d\d/)
    await expect(page.getByTestId('usage-meter')).toHaveAttribute('title', /updated just now/)
    await shot(page, '5b-usage-meter')

    await typeLine('ask')
    await expect(page.getByTestId('session-row')).toHaveAttribute('data-status', 'needs_you')
    await expect(page.getByTestId('titlebar-counts')).toContainText('1 needs you')
    await shot(page, '6-needs-you')

    const { stdout } = await run('git', ['-C', e.repo.root, 'config', '--local', 'user.email'], { env: e.repo.env })
    expect(stdout.trim()).toBe('jane@acme.test')
  })

  test('agents survive an app restart', async () => {
    await app!.close()
    app = undefined
    await run('tmux', ['-L', e.socket, 'has-session', '-t', `=pw-${sessionId}`])
    ;({ app, page } = await launchApp(e.env))
    await expect(page.getByTestId('session-row')).toHaveCount(1)
    await expect(page.getByTestId('usage-5h')).toContainText('42%') // last known usage, without a new reply
    await waitFor(async () => (await paneText(e.socket, sessionId)).includes('STUB CLAUDE READY'), 15_000, 'reattached screen')
    await expect(page.getByTestId('session-row')).toHaveAttribute('data-status', 'needs_you')
    await page.getByTestId('session-row').click()
    await expect(page.getByTestId('terminal-claude')).toBeVisible()
    await page.waitForTimeout(1000)
    await expect(page.getByTestId('session-row')).toHaveAttribute('data-status', 'needs_you')
    await shot(page, '7-after-restart')
    await typeLine('again')
    await waitFor(async () => (await paneText(e.socket, sessionId)).includes('echo: again'), 15_000, 'typing after reattach')
    expect(await tmux(e.socket, 'list-sessions', '-F', '#{session_name}')).toContain(`pw-${sessionId}`)
  })

  test('files tab: open a file, edit, save, send to agent', async () => {
    await page.getByTestId('session-row').click()
    await page.getByTestId('file-README.md').click()
    await expect(page.getByTestId('editor-README.md')).toBeVisible()
    await page.locator('.cm-content').click()
    await page.keyboard.type('x')
    await expect(page.locator('.tab-dirty')).toHaveCount(1)
    await page.keyboard.press('Meta+s')
    await expect(page.locator('.tab-dirty')).toHaveCount(0)
    await shot(page, '8-file-editor')
    await page.getByTestId('send-to-agent').click()
    await expect(page.getByTestId('terminal-claude')).toBeVisible()
    await waitFor(async () => (await paneText(e.socket, sessionId)).includes('@README.md'), 15_000, '@README.md in prompt')

    // closing a dirty tab asks first
    await page.getByTestId('file-README.md').click()
    await page.locator('.cm-content').click()
    await page.keyboard.type('y')
    await expect(page.locator('.tab-dirty')).toHaveCount(1)
    await page.getByRole('button', { name: 'Close README.md' }).click()
    await expect(page.getByTestId('discard-file-dialog')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByTestId('editor-README.md')).toHaveCount(1)
    await page.getByRole('button', { name: 'Close README.md' }).click()
    await page.getByTestId('discard-confirm').click()
    await expect(page.getByTestId('editor-README.md')).toHaveCount(0)
    await expect(page.locator('.tab-dirty')).toHaveCount(0)
  })
})

test.describe('dev build window', () => {
  test.skip(PACKAGED, 'packaged run only')

  test('dropped files paste their paths into the terminal and never navigate the window', async () => {
    await page.getByTestId('session-row').click()
    await page.getByTestId('tab-claude').click()
    await expect(page.getByTestId('terminal-claude')).toBeVisible()
    const file = join(e.tmp, 'drop me.txt')
    await writeFile(file, 'x')
    const url = page.url()
    // Only a file input yields File objects with a real path (as a Finder drag does).
    await page.evaluate(`(() => {
      const i = document.createElement('input')
      i.type = 'file'
      i.id = 'e2e-file'
      i.style.display = 'none'
      document.body.appendChild(i)
    })()`)
    await page.setInputFiles('#e2e-file', file)
    // Returns dispatchEvent's result: false = someone called preventDefault.
    const dropOn = (selector: string): Promise<boolean> => page.evaluate(`(() => {
      const dt = new DataTransfer()
      for (const f of document.getElementById('e2e-file').files) dt.items.add(f)
      const target = document.querySelector(${JSON.stringify(selector)})
      target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
      return target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    })()`)

    expect(await dropOn('[data-testid="terminal-claude"]')).toBe(false) // handled, default prevented
    await waitFor(async () => /'\/[^'\n]*\/drop me\.txt'/.test(await paneText(e.socket, sessionId)), 15_000, 'dropped path in prompt')
    expect(await paneText(e.socket, sessionId)).not.toMatch(/echo: .*drop me\.txt/) // pasted, never submitted

    expect(await dropOn('.sidebar')).toBe(false) // anywhere else: swallowed
    expect(await page.evaluate('window.open("about:blank") === null')).toBe(true) // no new windows
    await page.waitForTimeout(500)
    expect(page.url()).toBe(url)
    expect(app!.windows()).toHaveLength(1)
    await expect(page.getByTestId('session-row')).toHaveCount(1)
    // (Navigation itself is refused in finder.spec.ts: a cancelled navigation confuses Playwright's page tracking.)
  })

  test('a render error shows the error boundary, and Reload brings the app back', async () => {
    await app!.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('pitwall:snapshot', { projects: null })
    })
    await expect(page.getByTestId('error-boundary')).toBeVisible()
    await expect(page.getByTestId('error-boundary')).toContainText('Something went wrong')
    await shot(page, '15-error-boundary')
    await page.getByTestId('error-reload').click()
    await expect(page.getByTestId('error-boundary')).toHaveCount(0)
    await expect(page.getByTestId('session-row')).toHaveCount(1)
  })

  test('closing the window stops viewing; reopening for a notification selects the session', async () => {
    const row = page.getByTestId('session-row')
    await row.click()
    await expect(row).toHaveClass(/selected/)
    // Otherwise the saved layout restores the pane on reopen and legitimately marks the session read.
    await page.evaluate(() => localStorage.removeItem('pitwall.layout.v1'))
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await expect.poll(() => app!.windows().length).toBe(0)

    // Claude finishes while the window is closed: nothing is being viewed, so it's Unread.
    await tmux(e.socket, 'send-keys', '-t', `=pw-${sessionId}:`, 'C-u', 'closed', 'Enter')
    await waitFor(async () => (await paneText(e.socket, sessionId)).includes('echo: closed'), 15_000, 'echo: closed')

    // Reopen (Dock click) and let the OS focus it: the old selection must not mark the session read.
    const reopened = app!.waitForEvent('window')
    await app!.evaluate(({ app: a }) => { a.emit('activate') })
    page = await reopened
    await page.waitForLoadState('domcontentloaded')
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('focus'))
    await expect(page.getByTestId('session-row')).toHaveAttribute('data-status', 'unread')
    await page.waitForTimeout(1000)
    await expect(page.getByTestId('session-row')).toHaveAttribute('data-status', 'unread')
    await expect(page.getByTestId('session-row')).not.toHaveClass(/selected/)

    // A notification click with no window: main creates one and sends focusSession as soon as it has loaded.
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await expect.poll(() => app!.windows().length).toBe(0)
    const again = app!.waitForEvent('window')
    await app!.evaluate(({ app: a, BrowserWindow }, id) => {
      a.emit('activate')
      const w = BrowserWindow.getAllWindows()[0]
      w.webContents.once('did-finish-load', () => w.webContents.send('pitwall:focusSession', id))
    }, sessionId)
    page = await again
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900))
    await expect(page.getByTestId('session-row')).toHaveClass(/selected/)
    await expect(page.getByTestId('session-status')).toBeVisible()
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('focus'))
    await expect(page.getByTestId('session-row')).toHaveAttribute('data-status', 'read')
  })

  test('editing the identity reaches the running session and the repo, and says how to apply it', async () => {
    await page.getByTestId('project-row').hover()
    await page.getByTestId('project-menu').click()
    await page.getByRole('menuitem', { name: 'Edit project' }).click()
    await expect(page.getByTestId('gh-account-select').locator('option').first()).toHaveText('None — gh uses its active account')
    await page.getByTestId('git-email-input').fill('jane@new.test')
    await page.getByTestId('save-project').click()
    await expect(page.getByTestId('identity-restart-note')).toHaveText(
      'Running agents keep their current identity until they restart. To apply it now, exit Claude in the session and press Enter.'
    )
    await shot(page, '18-identity-restart-note')
    await page.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByTestId('project-dialog')).toHaveCount(0)
    expect(await readFile(join(e.dataDir, 'sessions', sessionId, 'env.sh'), 'utf8')).toContain("GIT_AUTHOR_EMAIL='jane@new.test'")
    const { stdout } = await run('git', ['-C', e.repo.root, 'config', '--local', 'user.email'], { env: e.repo.env })
    expect(stdout.trim()).toBe('jane@new.test')

    await tmux(e.socket, 'send-keys', '-t', `=pw-${sessionId}:`, 'C-u', 'exit', 'Enter')
    await waitFor(async () => (await paneText(e.socket, sessionId)).includes('Press Enter to resume'), 15_000, 'claude exited')
    await tmux(e.socket, 'send-keys', '-t', `=pw-${sessionId}:`, 'Enter')
    await waitFor(async () => (await readFile(e.env.STUB_CLAUDE_LOG, 'utf8')).includes('GIT_AUTHOR_EMAIL=jane@new.test'), 15_000, 'new identity after relaunch')
  })
})

test.describe('dev build changes', () => {
  test.skip(PACKAGED, 'packaged run only')

  test('changes tab lists work, opens a diff, sidebar shows line counts', async () => {
    const { stdout } = await run('git', ['-C', e.repo.root, 'worktree', 'list', '--porcelain'], { env: e.repo.env })
    const wt = stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).find((p) => p !== e.repo.root)!
    await writeFile(join(wt, 'changed-by-test.txt'), 'one\ntwo\nthree\n')
    await page.getByTestId('session-row').click()
    await page.getByTestId('tab-claude').click()
    await typeLine('refresh') // the stub emits Stop, which triggers a diff refresh
    await page.getByTestId('right-tab-changes').click()
    await expect(page.getByTestId('change-changed-by-test.txt')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('change-changed-by-test.txt')).toContainText('+3')
    await expect(page.getByTestId('session-row')).toContainText('+', { timeout: 15_000 })
    await page.getByTestId('change-changed-by-test.txt').click()
    await expect(page.getByTestId('diff-changed-by-test.txt')).toBeVisible()
    await expect(page.getByTestId('diff-changed-by-test.txt').locator('.cm-mergeView')).toHaveCount(1)
    await shot(page, '9-diff-split')
    await page.getByTestId('diff-unified').click()
    await expect(page.getByTestId('diff-changed-by-test.txt').locator('.cm-mergeView')).toHaveCount(0)
    await expect(page.getByTestId('diff-changed-by-test.txt').locator('.cm-content')).toContainText('three')
    await shot(page, '10-diff-unified')
  })

  test('menu shortcuts, settings, setup command and hover card', async () => {
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
    const state = async (): Promise<{ settings: { monoFontSize: number }; subProjects: { setupCommand?: string }[] }> =>
      JSON.parse(await readFile(join(e.dataDir, 'state.json'), 'utf8'))

    // hover card after the delay, gone on leave
    await page.getByTestId('session-row').hover()
    await expect(page.getByTestId('hover-card')).toBeVisible()
    await expect(page.getByTestId('hover-card')).toContainText('Fix tax rounding')
    await expect(page.getByTestId('hover-card')).toContainText('Acme · tax-service')
    await expect(page.getByTestId('hover-card')).toContainText('pitwall/fix-tax-rounding')
    await shot(page, '13-hover-card')
    await page.mouse.move(700, 500)
    await expect(page.getByTestId('hover-card')).toHaveCount(0)

    // ⌘1 selects the first session, ⌘J with nothing waiting says so
    await menu('CmdOrCtrl+1')
    await expect(page.getByTestId('session-status')).toBeVisible()
    await expect(page.getByTestId('open-in-cursor')).toBeVisible()
    await menu('CmdOrCtrl+J')
    await expect(page.getByRole('status').filter({ hasText: 'Nothing needs you' })).toBeVisible()

    // ⌘W: never closes Claude/Shell, asks before closing a dirty file tab
    await menu('CmdOrCtrl+W')
    await expect(page.getByTestId('tab-claude')).toBeVisible()
    await page.getByTestId('right-tab-files').click()
    await page.getByTestId('file-README.md').click()
    await page.locator('.cm-content').click()
    await page.keyboard.type('z')
    await expect(page.locator('.tab-dirty')).toHaveCount(1)
    await menu('CmdOrCtrl+W')
    await expect(page.getByTestId('discard-file-dialog')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await menu('CmdOrCtrl+S')
    await expect(page.locator('.tab-dirty')).toHaveCount(0)
    await menu('CmdOrCtrl+W')
    await expect(page.getByTestId('editor-README.md')).toHaveCount(0)

    // font settings apply to the open editor and persist
    await page.getByTestId('file-README.md').click()
    await expect(page.locator('.cm-editor')).toBeVisible()
    await menu('CmdOrCtrl+,')
    await expect(page.getByTestId('settings-version')).toHaveText(/^Pitwall \d+\.\d+\.\d+ \(dev build\)$/)
    await expect(page.getByTestId('titlebar-name')).toHaveText('Pitwall Dev')
    expect(await app!.evaluate(({ app }) => app.getName())).toBe('Pitwall Dev')
    await page.getByTestId('setting-size').fill('17')
    await page.getByTestId('settings-save').click()
    await expect(page.getByTestId('settings-dialog')).toHaveCount(0)
    await expect.poll(async () => (await state()).settings.monoFontSize).toBe(17)
    await expect.poll(() => page.evaluate("getComputedStyle(document.querySelector('.cm-editor')).fontSize")).toBe('17px')

    // setup command
    await page.getByTestId('subproject-row').hover()
    await page.getByTestId('subproject-menu').click()
    await page.getByTestId('subproject-setup').click()
    await expect(page.getByTestId('subproject-settings-dialog')).toContainText('Runs once in each new worktree before Claude starts.')
    await page.getByTestId('setup-command').fill('echo $PITWALL_ROOT_PATH')
    await shot(page, '14-setup-command')
    await page.getByTestId('setup-command-save').click()
    await expect.poll(async () => (await state()).subProjects[0].setupCommand).toBe('echo $PITWALL_ROOT_PATH')
    await page.getByTestId('editor-README.md').waitFor()
    await page.getByRole('button', { name: 'Close README.md' }).click()
  })

  test('archive warns about uncommitted work, then removes the worktree and lists the session as archived', async () => {
    const { stdout } = await run('git', ['-C', e.repo.root, 'worktree', 'list', '--porcelain'], { env: e.repo.env })
    const wt = stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).find((p) => p !== e.repo.root)!
    expect(existsSync(wt)).toBe(true)
    await page.getByTestId('session-row').hover()
    await page.getByTestId('session-menu').click()
    await page.getByTestId('session-archive').click()
    await expect(page.getByTestId('archive-dialog')).toBeVisible()
    await expect(page.getByTestId('archive-actions')).toContainText(/Delete worktree .*worktrees\/tax-service\/fix-tax-rounding/)
    await expect(page.getByTestId('archive-actions')).toContainText('Delete branch pitwall/fix-tax-rounding')
    await expect(page.getByTestId('archive-warning')).toContainText('uncommitted file')
    await shot(page, '11-archive-dialog')
    await page.getByTestId('archive-confirm').click()
    await expect(page.getByTestId('archive-dialog')).toHaveCount(0, { timeout: 30_000 })
    await expect(page.getByTestId('session-row')).toHaveCount(0)
    expect(existsSync(wt)).toBe(false)
    await expect(page.getByTestId('archived-toggle')).toContainText('Archived (1)')
    await page.getByTestId('archived-toggle').click()
    await expect(page.getByTestId('archived-row')).toContainText('Fix tax rounding')
    await page.getByTestId('archived-search').fill('zzz')
    await expect(page.getByTestId('archived-row')).toHaveCount(0)
    await page.getByTestId('archived-search').fill('TAX')
    await expect(page.getByTestId('archived-row')).toHaveCount(1)
    await shot(page, '12-archived-list')
    const branches = await run('git', ['-C', e.repo.root, 'branch', '--format=%(refname:short)'], { env: e.repo.env })
    expect(branches.stdout).not.toContain('pitwall/fix-tax-rounding')
    expect(await tmux(e.socket, 'list-sessions', '-F', '#{session_name}').catch(() => '')).not.toContain(`pw-${sessionId}`)
  })
})

test.describe('packaged app', () => {
  test.skip(!PACKAGED, 'set PACKAGED=1 (after pnpm package)')

  test('packaged app launches and starts a session', async () => {
    const exe = join(process.cwd(), 'release/mac-arm64/Pitwall.app/Contents/MacOS/Pitwall')
    expect(existsSync(exe)).toBe(true)
    ;({ app, page } = await launchApp(e.env, exe))
    await expect(page.getByTestId('create-first-project')).toBeVisible()
    await page.getByTestId('create-first-project').click()
    await page.getByTestId('project-name-input').fill('Packaged')
    await expect(page.getByTestId('ssh-key-select').locator('option', { hasText: 'id_test' })).toHaveCount(1)
    await page.getByTestId('ssh-key-select').selectOption({ label: 'id_test' })
    await expect(page.getByTestId('gh-account-select').locator('option', { hasText: 'dev-work' })).toHaveCount(1)
    await page.getByTestId('gh-account-select').selectOption('dev-work')
    await page.getByTestId('git-name-input').fill('P')
    await page.getByTestId('git-email-input').fill('p@acme.test')
    await page.getByTestId('save-project').click()
    await expect(page.getByTestId('project-row')).toContainText('Packaged')
    await page.getByTestId('project-row').hover()
    await page.getByTestId('add-folder').click()
    await expect(page.getByTestId('subproject-row')).toContainText('tax-service')
    await page.getByTestId('subproject-row').hover()
    await page.getByTestId('new-session').click()
    await page.getByTestId('session-title-input').fill('Packaged run')
    await page.getByTestId('start-session').click()
    await expect(page.getByTestId('new-session-dialog')).toHaveCount(0, { timeout: 30_000 })
    const id = await waitFor(() => sessionIdOf(e.socket), 15_000, 'tmux session')
    await waitFor(async () => (await paneText(e.socket, id)).includes('STUB CLAUDE READY'), 15_000, 'STUB CLAUDE READY')
    await typeLine('hello')
    await waitFor(async () => (await paneText(e.socket, id)).includes('echo: hello'), 15_000, 'echo: hello')
  })
})
