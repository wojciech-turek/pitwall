import { execFile } from 'node:child_process'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import { ChangesService } from '../../src/main/changes'
import { exec } from '../../src/main/exec'
import { GitClient } from '../../src/main/git'
import type { SessionManager } from '../../src/main/sessions/manager'
import type { Store } from '../../src/main/store'
import type { HookEvent, Session, SubProject } from '../../src/shared/types'
import { makeRepo } from '../helpers/repo'
import { waitFor } from '../helpers/wait'

const run = promisify(execFile)
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function setup(kind: 'repo' | 'folder' = 'repo', baseBranch: string | null = 'main') {
  const r = await makeRepo()
  cleanups.push(r.cleanup)
  const git = new GitClient(exec, r.env)
  const wt = join(r.root, '..', 'wt')
  await git.addWorktree({ repoRoot: r.root, path: wt, branch: 'pitwall/x', mode: 'new', base: 'main' })
  const baseCommit = await git.revParse(r.root, 'main')
  const sh = (...a: string[]) => run('git', a, { cwd: wt, env: r.env })
  const session: Session = {
    id: 's1', subProjectId: 'sp', title: 't', slug: 'x', claudeSessionId: 'c', cwd: wt, worktreePath: wt,
    branch: 'pitwall/x', branchCreatedByPitwall: true, baseBranch: baseBranch ?? undefined, baseCommit, createdAt: 0, lastViewedAt: 0
  }
  const sp: SubProject = { id: 'sp', projectId: 'p', name: 'n', kind, path: r.root, createdAt: 0 }
  const store = { state: { sessions: [session], subProjects: [sp], projects: [] } } as unknown as Store
  const cbs: ((id: string, ev: HookEvent) => void)[] = []
  const extras: Record<string, unknown>[] = []
  const manager = {
    onSessionEvent: (cb: (id: string, ev: HookEvent) => void) => { cbs.push(cb); return () => { cbs.splice(cbs.indexOf(cb), 1) } },
    updateSessionExtras: (_id: string, p: Record<string, unknown>) => { extras.push(p) }
  } as unknown as SessionManager
  const svc = new ChangesService({ store, git, manager, debounceMs: 50 })
  const emit = (e: string) => cbs.forEach((cb) => cb('s1', { c: 's1', t: 1, e }))
  return { r, wt, sh, svc, emit, extras, session, sp }
}

describe('ChangesService', () => {
  test('list covers committed, uncommitted and untracked work', async () => {
    const { wt, sh, svc } = await setup()
    await writeFile(join(wt, 'committed.txt'), 'a\nb\n')
    await sh('add', '-A'); await sh('commit', '-m', 'c')
    await writeFile(join(wt, 'README.md'), '# test\nmore\n')
    await mkdir(join(wt, 'sub'))
    await writeFile(join(wt, 'sub/new.txt'), 'x\n')
    const res = await svc.list('s1')
    expect(res.baseLabel).toMatch(/^main @ [0-9a-f]{7}$/)
    const m = new Map(res.files.map((f) => [f.path, f]))
    expect(m.get('committed.txt')).toMatchObject({ status: 'A', additions: 2 })
    expect(m.get('README.md')).toMatchObject({ status: 'M', additions: 1, deletions: 0 })
    expect(m.get('sub/new.txt')).toMatchObject({ status: '?', additions: 1 })
  })

  test('baseLabel is the short sha without a base branch', async () => {
    const { svc } = await setup('repo', null)
    expect((await svc.list('s1')).baseLabel).toMatch(/^[0-9a-f]{7}$/)
  })

  test('research folder has no changes', async () => {
    const { svc } = await setup('folder')
    expect(await svc.list('s1')).toEqual({ base: '', baseLabel: '', files: [] })
  })

  test('readDiff modified, deleted, untracked, binary, too large', async () => {
    const { wt, sh, svc } = await setup()
    await writeFile(join(wt, 'README.md'), 'new\n')
    expect(await svc.readDiff('s1', 'README.md')).toEqual({ original: '# test\n', modified: 'new\n', binary: false, tooLarge: false })
    await rm(join(wt, 'README.md'))
    expect(await svc.readDiff('s1', 'README.md')).toMatchObject({ original: '# test\n', modified: '' })
    await writeFile(join(wt, 'u.txt'), 'u\n')
    expect(await svc.readDiff('s1', 'u.txt')).toMatchObject({ original: '', modified: 'u\n' })
    await writeFile(join(wt, 'b.bin'), Buffer.from([1, 0, 2]))
    expect(await svc.readDiff('s1', 'b.bin')).toEqual({ original: '', modified: '', binary: true, tooLarge: false })
    await writeFile(join(wt, 'big.txt'), 'x'.repeat(2 * 1024 * 1024 + 1))
    expect(await svc.readDiff('s1', 'big.txt')).toEqual({ original: '', modified: '', binary: false, tooLarge: true })
    await expect(svc.readDiff('s1', '../escape')).rejects.toThrow()
    void sh
  })

  test('diffStat and liveBranch refresh after Stop event', async () => {
    const { wt, sh, svc, emit, extras } = await setup()
    svc.start()
    await writeFile(join(wt, 'n.txt'), '1\n2\n3\n')
    emit('Stop')
    await waitFor(async () => extras.some((e) => JSON.stringify(e.diffStat) === '{"additions":3,"deletions":0}'), 5000, 'diffStat')
    expect(extras.at(-1)).toMatchObject({ liveBranch: 'pitwall/x' })
    await sh('branch', '-m', 'renamed')
    emit('PostToolUse')
    await waitFor(async () => extras.at(-1)?.liveBranch === 'renamed', 5000, 'liveBranch')
    svc.stop()
  })

  test('start refreshes all repo sessions once, and one failure does not stop the others', async () => {
    const a = await setup()
    await writeFile(join(a.wt, 'a.txt'), '1\n2\n')
    const b = await setup()
    await writeFile(join(b.wt, 'b.txt'), '1\n')
    const broken = { ...b.session, id: 'broken', worktreePath: join(b.wt, 'gone') }
    const store = { state: { sessions: [broken, a.session, { ...b.session, id: 's2' }], subProjects: [a.sp, b.sp] } } as unknown as Store
    const seen: [string, unknown][] = []
    const manager = {
      onSessionEvent: () => () => undefined,
      updateSessionExtras: (id: string, p: { diffStat?: unknown }) => { seen.push([id, p.diffStat]) }
    } as unknown as SessionManager
    const svc = new ChangesService({ store, git: new GitClient(exec, a.r.env), manager, debounceMs: 50 })
    svc.start()
    await waitFor(async () => seen.some(([id]) => id === 's1'), 5000, 's1 refreshed')
    expect(seen.find(([id]) => id === 's1')![1]).toEqual({ additions: 2, deletions: 0 })
    expect(seen.some(([id]) => id === 'broken')).toBe(false)
    svc.stop()
  })

  test('PostToolUseFailure triggers a refresh', async () => {
    const { wt, svc, emit, extras } = await setup()
    svc.start()
    await waitFor(async () => extras.length > 0, 5000, 'initial refresh')
    extras.length = 0
    await writeFile(join(wt, 'f.txt'), '1\n')
    emit('PostToolUseFailure')
    await waitFor(async () => extras.some((e) => JSON.stringify(e.diffStat) === '{"additions":1,"deletions":0}'), 5000, 'refresh')
    svc.stop()
  })

  test('detached HEAD clears liveBranch', async () => {
    const { sh, svc, emit, extras } = await setup()
    svc.start()
    await waitFor(async () => extras.at(-1)?.liveBranch === 'pitwall/x', 5000, 'branch')
    await sh('checkout', '--detach')
    emit('Stop')
    await waitFor(async () => extras.length > 1 && extras.at(-1)?.liveBranch === undefined, 5000, 'cleared')
    expect(extras.at(-1)).toHaveProperty('liveBranch', undefined)
    svc.stop()
  })
})
