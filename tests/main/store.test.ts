import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, newId } from '../../src/main/store'
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
    await s.update((d) => { d.settings = { monoFont: 'Menlo', monoFontSize: 15 } })
    const s2 = await Store.open(f)
    expect(s2.state.settings).toEqual({ monoFont: 'Menlo', monoFontSize: 15 })
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
})

test('newId format', () => {
  expect(newId('s')).toMatch(/^s_[a-z0-9]{8}$/)
  expect(newId('sp')).toMatch(/^sp_[a-z0-9]{8}$/)
  expect(newId('p')).not.toBe(newId('p'))
})
