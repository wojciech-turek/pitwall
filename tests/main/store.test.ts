import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { copyFile, mkdtemp, rename, rm, readdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, newId, settingsFrom } from '../../src/main/store'
import { DEFAULT_SETTINGS, type Project } from '@shared/types'

let dir: string
let f: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pitwall-store-'))
  f = join(dir, 'state.json')
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const proj = (id: string): Project => ({
  id,
  name: id,
  identity: { sshKeyPath: '/k', ghAccount: 'a', gitName: 'n', gitEmail: 'e@x' },
  extraEnv: [],
  createdAt: 1
})

describe('Store', () => {
  test('missing file → empty state', async () => {
    const s = await Store.open(f)
    expect(s.state).toEqual({ version: 1, projects: [], subProjects: [], sessions: [], settings: DEFAULT_SETTINGS })
  })

  test('update persists across reopen', async () => {
    const s = await Store.open(f)
    await s.update((d) => { d.projects.push(proj('p_1')) })
    const s2 = await Store.open(f)
    expect(s2.state).toEqual(s.state)
    expect(s2.state.projects[0].id).toBe('p_1')
  })

  test('missing settings in loaded file are filled with defaults', async () => {
    await writeFile(f, JSON.stringify({ version: 1, projects: [], subProjects: [], sessions: [] }))
    const s = await Store.open(f)
    expect(s.state.settings).toEqual(DEFAULT_SETTINGS)
  })

  test('settings persist', async () => {
    const s = await Store.open(f)
    await s.update((d) => { d.settings = { monoFont: 'Menlo', monoFontSize: 15, checkForUpdates: false } })
    const s2 = await Store.open(f)
    expect(s2.state.settings).toEqual({ monoFont: 'Menlo', monoFontSize: 15, checkForUpdates: false })
  })

  test('a state file from before the update check means checking is on', async () => {
    await writeFile(f, JSON.stringify({ version: 1, projects: [], subProjects: [], sessions: [], settings: { monoFont: 'Menlo', monoFontSize: 15 } }))
    const s = await Store.open(f)
    expect(s.state.settings).toEqual({ monoFont: 'Menlo', monoFontSize: 15, checkForUpdates: true })
    expect(DEFAULT_SETTINGS.checkForUpdates).toBe(true)
  })

  test('corrupt file falls back to .bak', async () => {
    const s = await Store.open(f)
    await s.update((d) => { d.projects.push(proj('p_1')) })
    await s.update((d) => { d.projects.push(proj('p_2')) }) // .bak now holds p_1 only
    await writeFile(f, 'garbage{')
    const s2 = await Store.open(f)
    expect(s2.state.projects.map((p) => p.id)).toEqual(['p_1'])
  })

  test('both corrupt → empty state and file moved aside', async () => {
    await writeFile(f, 'garbage{')
    await writeFile(f + '.bak', 'also garbage')
    const s = await Store.open(f)
    expect(s.state.projects).toEqual([])
    const names = await readdir(dir)
    expect(names.some((n) => /^state\.json\.corrupt-\d+$/.test(n))).toBe(true)
    expect(names).not.toContain('state.json')
  })

  test('20 concurrent updates are all kept', async () => {
    const s = await Store.open(f)
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.update((d) => { d.projects.push(proj('p_' + i)) })))
    expect(s.state.projects).toHaveLength(20)
    const s2 = await Store.open(f)
    expect(s2.state.projects).toHaveLength(20)
  })

  test('onChange fires after update and unsubscribes', async () => {
    const s = await Store.open(f)
    let n = 0
    const off = s.onChange(() => { n++ })
    await s.update((d) => { d.projects.push(proj('p_1')) })
    expect(n).toBe(1)
    off()
    await s.update((d) => { d.projects.push(proj('p_2')) })
    expect(n).toBe(1)
  })

  test('failed mutator rejects, leaves state untouched, and does not break the chain', async () => {
    const s = await Store.open(f)
    await expect(s.update((d) => { d.projects.push(proj('p_x')); throw new Error('boom') })).rejects.toThrow('boom')
    expect(s.state.projects).toEqual([])
    await s.update((d) => { d.projects.push(proj('p_1')) })
    expect(JSON.parse(await readFile(f, 'utf8')).projects).toHaveLength(1)
  })

  test('failed write rejects and later updates still work', async () => {
    const s = await Store.open(join(dir, 'sub', 'state.json')) // parent dir created by open
    await rm(join(dir, 'sub'), { recursive: true, force: true })
    await writeFile(join(dir, 'sub'), 'not a dir')
    await expect(s.update((d) => { d.projects.push(proj('p_1')) })).rejects.toThrow()
    expect(s.state.projects).toEqual([])
    await rm(join(dir, 'sub'), { force: true })
    await Store.open(join(dir, 'sub', 'state.json')) // recreate dir
    await s.update((d) => { d.projects.push(proj('p_2')) })
    expect(s.state.projects.map((p) => p.id)).toEqual(['p_2'])
  })

  // Windows won't replace (or copy) a file another process has open at that moment: a scanner, a backup, a reader.
  const busy = (n: number, real: (a: string, b: string) => Promise<void>) => {
    let calls = 0
    const op = async (a: string, b: string): Promise<void> => {
      if (++calls <= n) throw Object.assign(new Error(`EPERM: operation not permitted, '${a}'`), { code: 'EPERM' })
      return real(a, b)
    }
    return { op, calls: () => calls }
  }

  test('Windows: a save whose copy and rename are refused for a moment is retried and lands, leaving no .tmp', async () => {
    await writeFile(f, JSON.stringify({ version: 1, projects: [], subProjects: [], sessions: [] }))
    const r = busy(2, rename)
    const c = busy(2, copyFile)
    const s = await Store.open(f, { platform: 'win32', rename: r.op, copyFile: c.op })
    await s.update((d) => { d.projects.push(proj('p_1')) })
    expect(r.calls()).toBe(3)
    expect(c.calls()).toBe(3)
    expect(JSON.parse(await readFile(f, 'utf8')).projects.map((p: Project) => p.id)).toEqual(['p_1'])
    expect(JSON.parse(await readFile(`${f}.bak`, 'utf8')).projects).toEqual([])
    expect((await readdir(dir)).sort()).toEqual(['state.json', 'state.json.bak'])
  })

  test("Windows: a save refused for longer than the retries fails the update, logs, keeps the state as it was, leaves no .tmp", async () => {
    const r = busy(1000, rename)
    const s = await Store.open(f, { platform: 'win32', rename: r.op, retryForMs: 200 })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(s.update((d) => { d.projects.push(proj('p_1')) })).rejects.toThrow('EPERM')
      expect(log).toHaveBeenCalledWith(expect.stringContaining("couldn't save"), expect.anything())
    } finally {
      log.mockRestore()
    }
    expect(s.state.projects).toEqual([])
    expect(await readdir(dir)).toEqual([])
    expect(r.calls()).toBeGreaterThan(1)
  })
})

test('newId format', () => {
  expect(newId('s')).toMatch(/^s_[a-z0-9]{8}$/)
  expect(newId('sp')).toMatch(/^sp_[a-z0-9]{8}$/)
  expect(newId('p')).not.toBe(newId('p'))
})

describe('settingsFrom (what the renderer may save)', () => {
  const current = { monoFont: 'Menlo', monoFontSize: 15, checkForUpdates: false }

  test('takes valid fields, trimming and clamping', () => {
    expect(settingsFrom({ monoFont: ' Iosevka ', monoFontSize: 40.4, checkForUpdates: true }, current))
      .toEqual({ monoFont: 'Iosevka', monoFontSize: 32, checkForUpdates: true })
    expect(settingsFrom({ monoFont: 'Iosevka', monoFontSize: 2, checkForUpdates: false }, DEFAULT_SETTINGS))
      .toEqual({ monoFont: 'Iosevka', monoFontSize: 8, checkForUpdates: false })
  })

  test('saving fonts alone keeps the update setting', () => {
    expect(settingsFrom({ monoFont: 'Iosevka', monoFontSize: 14 }, current).checkForUpdates).toBe(false)
    expect(settingsFrom({ monoFont: 'Iosevka', monoFontSize: 14, checkForUpdates: 'no' }, current).checkForUpdates).toBe(false)
    expect(settingsFrom({ monoFont: 'Iosevka', monoFontSize: 14 }, { monoFont: 'x', monoFontSize: 13 } as never).checkForUpdates).toBe(true)
  })

  test('invalid fonts fall back to the defaults', () => {
    expect(settingsFrom(null, current)).toEqual({ ...DEFAULT_SETTINGS, checkForUpdates: false })
    expect(settingsFrom({ monoFont: '   ', monoFontSize: 'big' }, current))
      .toEqual({ monoFont: DEFAULT_SETTINGS.monoFont, monoFontSize: DEFAULT_SETTINGS.monoFontSize, checkForUpdates: false })
  })
})
