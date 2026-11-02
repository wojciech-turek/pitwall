import { readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { waitFor } from '../helpers/wait'
import { fromGit } from '../../src/main/git'
import { WINDOWS } from '../helpers/processes'
import {
  clearLine, hasSession, hostPids, launchApp, makeE2eEnv, MOD, PACKAGED_EXE, paneText, sendKeys, SESSION_BACKEND, sessionIdOf, sessionNames,
  shot, tmux, type E2eEnv
} from './helpers'

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
    sessionId = await waitFor(() => sessionIdOf(e), 15_000, 'tmux session')
    await waitFor(async () => (await paneText(e, sessionId)).includes('STUB CLAUDE READY'), 15_000, 'STUB CLAUDE READY')
    await expect(page.getByTestId('terminal-claude')).toBeVisible()
    await shot(page, '5-session-running')
    // Only the selected backend runs sessions: no tmux server with the host, no host with tmux.
    if (SESSION_BACKEND === 'host') {
      expect(await tmux(e.socket, 'list-sessions').catch(() => 'no server')).toBe('no server')
      expect(await hostPids(e.dataDir)).toHaveLength(1)
    } else {
      expect(await hostPids(e.dataDir)).toEqual([])
    }

    await typeLine('hello')
    await waitFor(async () => (await paneText(e, sessionId)).includes('echo: hello'), 15_000, 'echo: hello')
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
    expect(await hasSession(e, sessionId)).toBe(true)
    ;({ app, page } = await launchApp(e.env))
    await expect(page.getByTestId('session-row')).toHaveCount(1)
    await expect(page.getByTestId('usage-5h')).toContainText('42%') // last known usage, without a new reply
    await waitFor(async () => (await paneText(e, sessionId)).includes('STUB CLAUDE READY'), 15_000, 'reattached screen')
    await expect(page.getByTestId('session-row')).toHaveAttribute('data-status', 'needs_you')
    await page.getByTestId('session-row').click()
    await expect(page.getByTestId('terminal-claude')).toBeVisible()
    await page.waitForTimeout(1000)
    await expect(page.getByTestId('session-row')).toHaveAttribute('data-status', 'needs_you')
    await shot(page, '7-after-restart')
    await typeLine('again')
    await waitFor(async () => (await paneText(e, sessionId)).includes('echo: again'), 15_000, 'typing after reattach')
    expect(await sessionNames(e)).toContain(`pw-${sessionId}`)
  })

  test("the terminal's rows and columns fit inside its frame at any window size (no clipped last line)", async () => {
    await page.getByTestId('session-row').click()
    await expect(page.getByTestId('terminal-claude')).toBeVisible()
    // How far the terminal's text area reaches past its frame's inner edge (≤ 0: it fits).
    const overflow = (): Promise<{ bottom: number; right: number }> => page.evaluate(`(() => {
      const host = document.querySelector('[data-testid="terminal-claude"]')
      const h = host.getBoundingClientRect(), cs = getComputedStyle(host)
      const s = host.querySelector('.xterm-screen').getBoundingClientRect()
      return { bottom: s.bottom - (h.bottom - parseFloat(cs.paddingBottom)), right: s.right - (h.right - parseFloat(cs.paddingRight)) }
    })()`)
    // One height per pixel across a whole text row: wherever the frame's padding would leave room for "one more row".
    for (let height = 880; height < 900; height++) {
      await app!.evaluate(({ BrowserWindow }, hh) => BrowserWindow.getAllWindows()[0].setContentSize(1400, hh), height)
      await page.waitForTimeout(120) // the terminal refits 50 ms after a resize
      const o = await overflow()
      expect(o.bottom, `last row past the frame at height ${height}`).toBeLessThanOrEqual(0.5)
      expect(o.right, `last column past the frame at height ${height}`).toBeLessThanOrEqual(0.5)
    }
    // What's left under the last row (less than a row) is the terminal's own background, never xterm's default black.
    const below = await page.evaluate(`(() => {
      const host = document.querySelector('[data-testid="terminal-claude"]')
      return getComputedStyle(host.querySelector('.xterm-viewport')).backgroundColor
    })()`)
    expect(below).not.toBe('rgb(0, 0, 0)')
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900))
  })

  test('files tab: open a file, edit, save, send to agent', async () => {
    await page.getByTestId('session-row').click()
    await page.getByTestId('file-README.md').click()
    await expect(page.getByTestId('editor-README.md')).toBeVisible()
    await page.locator('.cm-content').click()
    await page.keyboard.type('x')
    await expect(page.locator('.tab-dirty')).toHaveCount(1)
    await page.keyboard.press(`${MOD}+s`)
    await expect(page.locator('.tab-dirty')).toHaveCount(0)
    await shot(page, '8-file-editor')
    await page.getByTestId('send-to-agent').click()
    await expect(page.getByTestId('terminal-claude')).toBeVisible()
    await waitFor(async () => (await paneText(e, sessionId)).includes('@README.md'), 15_000, '@README.md in prompt')

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
    // Quoted as the platform's shell would need it: '/…/drop me.txt' on macOS, "C:\…\drop me.txt" on Windows.
    const dropped = WINDOWS ? /"[A-Za-z]:\\[^"\n]*\\drop me\.txt"/ : /'\/[^'\n]*\/drop me\.txt'/
    await waitFor(async () => dropped.test(await paneText(e, sessionId)), 15_000, 'dropped path in prompt')
    expect(await paneText(e, sessionId)).not.toMatch(/echo: .*drop me\.txt/) // pasted, never submitted

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

  // macOS keeps the app running with no window (the Dock reopens it); on Windows closing the last window quits.
  test('closing the window stops viewing; reopening for a notification selects the session', async () => {
    test.skip(WINDOWS, 'macOS: an app without windows')
    const row = page.getByTestId('session-row')
    await row.click()
    await expect(row).toHaveClass(/selected/)
    // Otherwise the saved layout restores the pane on reopen and legitimately marks the session read.
    await page.evaluate(() => localStorage.removeItem('pitwall.layout.v1'))
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await expect.poll(() => app!.windows().length).toBe(0)

    // Claude finishes while the window is closed: nothing is being viewed, so it's Unread.
    await clearLine(e, sessionId)
    await sendKeys(e, sessionId, 'closed', 'Enter')
    await waitFor(async () => (await paneText(e, sessionId)).includes('echo: closed'), 15_000, 'echo: closed')

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

    await clearLine(e, sessionId)
    await sendKeys(e, sessionId, 'exit', 'Enter')
    await waitFor(async () => (await paneText(e, sessionId)).includes('Press Enter to resume'), 15_000, 'claude exited')
    await sendKeys(e, sessionId, 'Enter')
    await waitFor(async () => (await readFile(e.env.STUB_CLAUDE_LOG, 'utf8')).includes('GIT_AUTHOR_EMAIL=jane@new.test'), 15_000, 'new identity after relaunch')
  })
})

test.describe('dev build changes', () => {
  test.skip(PACKAGED, 'packaged run only')

  test('changes tab lists work, opens a diff, sidebar shows line counts', async () => {
    const { stdout } = await run('git', ['-C', e.repo.root, 'worktree', 'list', '--porcelain'], { env: e.repo.env })
    const wt = stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => fromGit(l.slice(9))).find((p) => p !== e.repo.root)!
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
    // the version, quietly after the name, so you can always see which one you're on
    const { version } = JSON.parse(await readFile('package.json', 'utf8')) as { version: string }
    await expect(page.getByTestId('titlebar-version')).toHaveText(version)
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
    const wt = stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => fromGit(l.slice(9))).find((p) => p !== e.repo.root)!
    expect(existsSync(wt)).toBe(true)
    await page.getByTestId('session-row').hover()
    await page.getByTestId('session-menu').click()
    await page.getByTestId('session-archive').click()
    await expect(page.getByTestId('archive-dialog')).toBeVisible()
    await expect(page.getByTestId('archive-actions')).toContainText(/Delete worktree .*worktrees[\\/]tax-service[\\/]fix-tax-rounding/)
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
    expect(await sessionNames(e)).not.toContain(`pw-${sessionId}`)
  })

  test('teardown: failure offers Cancel and Archive anyway, success archives', async () => {
    const wtDirs = async (): Promise<string[]> => {
      const { stdout } = await run('git', ['-C', e.repo.root, 'worktree', 'list', '--porcelain'], { env: e.repo.env })
      return stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => fromGit(l.slice(9))).filter((p) => p !== e.repo.root)
    }
    const setTeardown = async (cmd: string): Promise<void> => {
      await page.getByTestId('subproject-row').hover()
      await page.getByTestId('subproject-menu').click()
      await page.getByTestId('subproject-setup').click()
      await page.getByTestId('teardown-command').fill(cmd)
      await page.getByTestId('setup-command-save').click()
      await expect(page.getByTestId('subproject-settings-dialog')).toHaveCount(0)
    }
    const startSession = async (title: string): Promise<void> => {
      await page.getByTestId('subproject-row').hover()
      await page.getByTestId('new-session').click()
      await page.getByTestId('session-title-input').fill(title)
      await page.getByTestId('start-session').click()
      await expect(page.getByTestId('new-session-dialog')).toHaveCount(0, { timeout: 30_000 })
      await expect(page.getByTestId('session-row')).toHaveCount(1)
    }
    const openArchive = async (): Promise<void> => {
      await page.getByTestId('session-row').hover()
      await page.getByTestId('session-menu').click()
      await page.getByTestId('session-archive').click()
      await page.getByTestId('archive-confirm').click()
    }
    const ok = join(e.tmp, 'teardown-ok')

    await startSession('Teardown fails')
    const failingId = await waitFor(() => sessionIdOf(e), 15_000, 'tmux session')
    await waitFor(async () => (await paneText(e, failingId)).includes('STUB CLAUDE READY'), 15_000, 'STUB CLAUDE READY')
    expect(await wtDirs()).toHaveLength(1)
    // Teardown runs in sh on macOS, in cmd.exe on Windows.
    await setTeardown(WINDOWS ? 'echo teardown-said-no& exit /b 5' : 'echo teardown-said-no; exit 5')
    await openArchive()
    await expect(page.getByTestId('teardown-failed')).toContainText('exit code 5', { timeout: 30_000 })
    await expect(page.getByTestId('teardown-output')).toContainText('teardown-said-no')
    await shot(page, '15-teardown-failed')
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByTestId('archive-dialog')).toHaveCount(0)
    await expect(page.getByTestId('session-row')).toHaveCount(1)
    expect(await wtDirs()).toHaveLength(1)
    // The agent was stopped for the teardown. Its terminal isn't frozen: a key (or focus, which tmux reports as
    // one) brings the agent back, resuming its conversation.
    await page.getByTestId('terminal-claude').click()
    await waitFor(async () => {
      await page.keyboard.press('x')
      return (await paneText(e, failingId)).includes('STUB CLAUDE READY')
    }, 20_000, 'agent relaunched by a key')
    const claudeId = (await readFile(join(e.dataDir, 'sessions', failingId, 'claude-id'), 'utf8')).trim()
    await waitFor(async () => (await readFile(e.env.STUB_CLAUDE_LOG, 'utf8')).includes(`--resume ${claudeId}`), 10_000, 'claude --resume')

    await openArchive()
    await expect(page.getByTestId('archive-anyway')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('archive-anyway').click()
    await expect(page.getByTestId('archive-dialog')).toHaveCount(0, { timeout: 30_000 })
    await expect(page.getByTestId('session-row')).toHaveCount(0)
    expect(await wtDirs()).toHaveLength(0)

    await startSession('Teardown works')
    await setTeardown(WINDOWS ? `type nul > "${ok}"` : `touch ${ok}`)
    await openArchive()
    await expect(page.getByTestId('archive-dialog')).toHaveCount(0, { timeout: 30_000 })
    expect(existsSync(ok)).toBe(true)
    expect(await wtDirs()).toHaveLength(0)
  })
})

test.describe('packaged app', () => {
  test.skip(!PACKAGED, 'set PACKAGED=1 (after pnpm package)')

  test('packaged app launches and starts a session', async () => {
    const exe = PACKAGED_EXE
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
    const id = await waitFor(() => sessionIdOf(e), 15_000, 'tmux session')
    await waitFor(async () => (await paneText(e, id)).includes('STUB CLAUDE READY'), 15_000, 'STUB CLAUDE READY')
    expect(await hostPids(e.dataDir)).toHaveLength(SESSION_BACKEND === 'host' ? 1 : 0) // the packaged app runs its own host
    await typeLine('hello')
    await waitFor(async () => (await paneText(e, id)).includes('echo: hello'), 15_000, 'echo: hello')
  })
})
