import { test, type ElectronApplication, type Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { waitFor } from '../helpers/wait'
import { launchApp, makeE2eEnv, paneText, tmux, type E2eEnv } from './helpers'

// Opt-in: PITWALL_BENCH=1. Compares the renderer's CPU with parking off and on; it asserts only that the sessions start.
test.skip(process.env.PITWALL_BENCH !== '1', 'benchmark, opt-in')
test.skip(process.platform === 'win32', 'tmux only')
test.setTimeout(240_000)

const N = 8

// Repaints the whole screen about 20 times a second, as Claude's TUI does.
const LOOP = `while :; do printf '\\033[H\\033[2J'; i=0; while [ $i -lt 40 ]; do printf '%s %s\\n' "$i" "$(date +%s%N)xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; i=$((i+1)); done; sleep 0.05; done`

async function measure(parkAfterMs: string): Promise<number> {
  const e: E2eEnv = await makeE2eEnv()
  e.env.PITWALL_PARK_AFTER_MS = parkAfterMs
  let app: ElectronApplication | undefined
  let page: Page
  try {
    ;({ app, page } = await launchApp(e.env))
    await page.getByTestId('create-first-project').click()
    await page.getByTestId('project-name-input').fill('Acme')
    await page.getByTestId('git-name-input').fill('Jane Doe')
    await page.getByTestId('git-email-input').fill('jane@acme.test')
    await page.getByTestId('save-project').click()
    await page.getByTestId('project-row').hover()
    await page.getByTestId('add-folder').click()
    const ids: string[] = []
    for (let i = 0; i < N; i++) {
      await page.getByTestId('subproject-row').hover()
      await page.getByTestId('new-session').click()
      await page.getByTestId('session-title-input').fill(`S${i}`)
      await page.getByTestId('start-session').click()
      await expect(page.getByTestId('new-session-dialog')).toHaveCount(0, { timeout: 30_000 })
      const id = (await page.getByTestId('session-row').filter({ hasText: `S${i}` }).getAttribute('data-session-id'))!
      await waitFor(async () => (await paneText(e, id)).includes('STUB CLAUDE READY'), 15_000, `S${i} ready`)
      ids.push(id)
      await page.getByTestId('tab-shell').click()
      await page.getByTestId('terminal-shell').click()
      await page.keyboard.type(LOOP)
      await page.keyboard.press('Enter')
      await waitFor(async () => (await tmux(e.socket, 'capture-pane', '-p', '-t', `=pw-${id}-sh:`).catch(() => '')).includes('xxxxxxxx'), 15_000, `S${i} looping`)
    }
    await page.getByTestId('session-row').filter({ hasText: 'S0' }).click() // one left selected
    await page.waitForTimeout(3000) // parking
    const attached = async (): Promise<number> => {
      let n = 0
      for (const id of ids) if ((await tmux(e.socket, 'list-clients', '-t', `=pw-${id}-sh`).catch(() => '')).trim() !== '') n++
      return n
    }
    const expected = parkAfterMs === '500' ? 1 : N
    const got = await attached()
    console.log(`BENCH park_after_ms=${parkAfterMs} attached_shell_clients=${got} (expected ${expected})`)
    expect(got).toBe(expected)
    const mem: Array<{ gpu: number; renderer: number }> = []
    const samples: number[] = []
    for (let i = 0; i < 3; i++) {
      const m = await app.evaluate(({ app }) => app.getAppMetrics().map((p) => ({ type: p.type, cpu: p.cpu.percentCPUUsage, ws: p.memory.workingSetSize })))
      samples.push(m.filter((p) => ['Tab', 'Renderer'].includes(p.type)).reduce((s, p) => s + p.cpu, 0))
      const kb = (t: (p: string) => boolean): number => m.filter((p) => t(p.type)).reduce((s, p) => s + p.ws, 0)
      mem.push({ gpu: kb((t) => t === 'GPU'), renderer: kb((t) => ['Tab', 'Renderer'].includes(t)) })
      await page.waitForTimeout(5000)
    }
    const avg = samples.reduce((s, x) => s + x, 0) / samples.length
    console.log(`BENCH park_after_ms=${parkAfterMs} renderer_cpu_samples=${samples.map((x) => x.toFixed(1)).join(',')} avg=${avg.toFixed(1)}%`)
    const mb = (k: number): string => (k / 1024).toFixed(0)
    const last = mem[mem.length - 1]
    console.log(`BENCH park_after_ms=${parkAfterMs} gpu_ws_mb=${mem.map((x) => mb(x.gpu)).join(',')} renderer_ws_mb=${mem.map((x) => mb(x.renderer)).join(',')} (last gpu=${mb(last.gpu)} renderer=${mb(last.renderer)})`)
    return avg
  } finally {
    await app?.close().catch(() => undefined)
    await e.cleanup() // kills the test socket, and with it the loops
  }
}

test('renderer CPU with parking off vs on', async () => {
  await measure('3600000')
  await measure('500')
})
