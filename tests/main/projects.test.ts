import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { exec } from '../../src/main/exec'
import { GitClient } from '../../src/main/git'
import { ProjectService } from '../../src/main/projects'
import { newId, Store } from '../../src/main/store'
import { makeRepo } from '../helpers/repo'
import { makeTestEnv } from '../helpers/env'
import type { ProjectInput } from '../../src/shared/api'

const run = promisify(execFile)
let t: Awaited<ReturnType<typeof makeTestEnv>>
let repo: Awaited<ReturnType<typeof makeRepo>>
let store: Store
let svc: ProjectService
let picked: string | null
let keyPath: string
let updated: string[]

const input = (o: Partial<ProjectInput['identity']> & { name?: string } = {}): ProjectInput => ({
  name: o.name ?? 'Acme',
  identity: { sshKeyPath: keyPath, ghAccount: 'acme-bot', gitName: 'Acme Bot', gitEmail: 'bot@acme.io', ...o },
  extraEnv: []
})
const gitCfg = async (cwd: string, key: string) => {
  try { return (await run('git', ['-C', cwd, 'config', '--local', '--get', key], { env: repo.env })).stdout.trim() } catch { return '' }
}

beforeEach(async () => {
  t = await makeTestEnv()
  repo = await makeRepo()
  keyPath = join(t.tmp, 'ssh', 'id_acme')
  await mkdir(join(t.tmp, 'ssh'), { recursive: true })
  await writeFile(keyPath, 'key')
  store = await Store.open(t.paths.stateFile)
  const env = repo.env
  updated = []
  svc = new ProjectService({
    store, git: new GitClient(exec, env), exec, env, home: t.tmp, pickFolder: async () => picked,
    onProjectUpdated: async (id) => { updated.push(id) }
  })
  picked = null
})
afterEach(async () => { await repo.cleanup(); await t.cleanup() })

describe('ProjectService', () => {
  test('ssh key and gh account are optional', async () => {
    const p = await svc.createProject(input({ sshKeyPath: '', ghAccount: '' }))
    expect(p.identity.sshKeyPath).toBe('')
    expect(p.identity.ghAccount).toBe('')
  })

  test('createProject validates', async () => {
    await expect(svc.createProject(input({ name: '  ' }))).rejects.toThrow('Give the project a name.')
    await expect(svc.createProject(input({ sshKeyPath: '/nope/key' }))).rejects.toThrow('SSH key not found: /nope/key')
    await expect(svc.createProject(input({ gitEmail: 'nope' }))).rejects.toThrow('Enter a commit email.')
    const p = await svc.createProject(input())
    expect(store.state.projects).toHaveLength(1)
    expect(p.name).toBe('Acme')
    const u = await svc.updateProject(p.id, input({ name: 'Acme 2' }))
    expect(u.name).toBe('Acme 2')
    await expect(svc.updateProject(p.id, input({ gitEmail: 'x' }))).rejects.toThrow('Enter a commit email.')
  })

  test('add plain folder', async () => {
    const p = await svc.createProject(input())
    picked = t.tmp
    const r = await svc.addFolder(p.id)
    expect(r.status).toBe('added')
    if (r.status === 'added') expect(r.subProject).toMatchObject({ kind: 'folder', path: t.tmp, projectId: p.id })
  })

  test('cancelled', async () => {
    const p = await svc.createProject(input())
    expect(await svc.addFolder(p.id)).toEqual({ status: 'cancelled' })
  })

  test('add repo without local identity applies it', async () => {
    const p = await svc.createProject(input())
    picked = repo.root
    const r = await svc.addFolder(p.id)
    expect(r.status).toBe('added')
    expect(await gitCfg(repo.root, 'user.email')).toBe('bot@acme.io')
    expect(await gitCfg(repo.root, 'user.name')).toBe('Acme Bot')
    expect(await gitCfg(repo.root, 'core.sshCommand')).toContain('id_acme')
    if (r.status === 'added') expect(r.subProject).toMatchObject({ kind: 'repo', repoRoot: repo.root, relPath: '', name: 'repo' })
  })

  test('add repo with different identity asks', async () => {
    const p = await svc.createProject(input())
    await run('git', ['-C', repo.root, 'config', '--local', 'user.email', 'other@x'], { env: repo.env })
    picked = repo.root
    const r = await svc.addFolder(p.id)
    expect(r.status).toBe('needs_identity_confirm')
    if (r.status === 'needs_identity_confirm') {
      expect(r.current.email).toBe('other@x')
      expect(r.path).toBe(repo.root)
      expect(r.proposed.email).toBe('bot@acme.io')
      expect(r.proposed.name).toBe('Acme Bot')
      expect(r.proposed.sshCommand).toContain('id_acme')
    }
    expect(store.state.subProjects).toHaveLength(0)
  })

  test('project without an ssh key proposes no ssh command (left unchanged)', async () => {
    const p = await svc.createProject(input({ sshKeyPath: '' }))
    await run('git', ['-C', repo.root, 'config', '--local', 'user.email', 'other@x'], { env: repo.env })
    picked = repo.root
    const r = await svc.addFolder(p.id)
    expect(r.status).toBe('needs_identity_confirm')
    if (r.status === 'needs_identity_confirm') {
      expect(r.proposed).toEqual({ name: 'Acme Bot', email: 'bot@acme.io' })
      expect('sshCommand' in r.proposed).toBe(false)
    }
  })

  test('extra environment variables are checked on save', async () => {
    const env = (key: string) => ({ ...input(), extraEnv: [{ key, value: 'v' }] })
    await expect(svc.createProject(env('1BAD'))).rejects.toThrow('Environment variable name is invalid: 1BAD')
    await expect(svc.createProject(env('MY VAR'))).rejects.toThrow('Environment variable name is invalid: MY VAR')
    await expect(svc.createProject(env('GH_TOKEN'))).rejects.toThrow('Environment variable name is reserved: GH_TOKEN')
    await expect(svc.createProject(env('PITWALL_X'))).rejects.toThrow('Environment variable name is reserved: PITWALL_X')
    expect(store.state.projects).toHaveLength(0)
    const p = await svc.createProject(env('CLAUDE_CONFIG_DIR'))
    await expect(svc.updateProject(p.id, env('GIT_SSH_COMMAND'))).rejects.toThrow('Environment variable name is reserved: GIT_SSH_COMMAND')
    expect(store.state.projects[0].extraEnv).toEqual([{ key: 'CLAUDE_CONFIG_DIR', value: 'v' }])
  })

  test('confirm with overwrite applies; without keeps config', async () => {
    const p = await svc.createProject(input())
    await run('git', ['-C', repo.root, 'config', '--local', 'user.email', 'other@x'], { env: repo.env })
    const keep = await svc.confirmAddFolder(p.id, repo.root, false)
    expect(keep.status).toBe('added')
    expect(await gitCfg(repo.root, 'user.email')).toBe('other@x')
    await svc.removeSubProject(store.state.subProjects[0].id)
    const over = await svc.confirmAddFolder(p.id, repo.root, true)
    expect(over.status).toBe('added')
    expect(await gitCfg(repo.root, 'user.email')).toBe('bot@acme.io')
  })

  test('duplicate folder rejected', async () => {
    const p = await svc.createProject(input())
    picked = t.tmp
    await svc.addFolder(p.id)
    const p2 = await svc.createProject(input({ name: 'Other' }))
    const r = await svc.addFolder(p2.id)
    expect(r).toEqual({ status: 'error', message: 'That folder is already added (in Acme).' })
  })

  test('monorepo subfolder recorded with repoRoot and relPath', async () => {
    const p = await svc.createProject(input())
    await mkdir(join(repo.root, 'packages', 'web'), { recursive: true })
    picked = join(repo.root, 'packages', 'web')
    const r = await svc.addFolder(p.id)
    expect(r.status).toBe('added')
    if (r.status === 'added') {
      expect(r.subProject).toMatchObject({ kind: 'repo', repoRoot: repo.root, relPath: 'packages/web', name: 'web' })
    }
  })

  test('remove guards', async () => {
    const p = await svc.createProject(input())
    picked = t.tmp
    const r = await svc.addFolder(p.id)
    if (r.status !== 'added') throw new Error('expected added')
    expect(await svc.removeProject(p.id)).toEqual({ ok: false, message: 'Remove its sub-projects first.' })
    await store.update((d) => {
      d.sessions.push({
        id: newId('s'), subProjectId: r.subProject.id, title: 't', slug: 't', claudeSessionId: 'c', cwd: t.tmp,
        branchCreatedByPitwall: false, createdAt: 1, lastViewedAt: 1
      })
    })
    expect(await svc.removeSubProject(r.subProject.id)).toEqual({ ok: false, message: 'Archive its sessions first.' })
    await store.update((d) => { d.sessions[0].archivedAt = 2 })
    expect(await svc.removeSubProject(r.subProject.id)).toEqual({ ok: true })
    expect(await svc.removeProject(p.id)).toEqual({ ok: true })
    expect(store.state.projects).toHaveLength(0)
  })

  test('editing the identity updates repos that still had the old one, and only those', async () => {
    const other = await makeRepo()
    try {
      const p = await svc.createProject(input())
      picked = repo.root
      expect((await svc.addFolder(p.id)).status).toBe('added') // applies the project identity
      await run('git', ['-C', other.root, 'config', '--local', 'user.email', 'someone@else'], { env: repo.env })
      await run('git', ['-C', other.root, 'config', '--local', 'user.name', 'Someone'], { env: repo.env })
      expect((await svc.confirmAddFolder(p.id, other.root, false)).status).toBe('added') // kept its own identity

      const key2 = join(t.tmp, 'ssh', 'id_new')
      await writeFile(key2, 'key')
      await svc.updateProject(p.id, input({ sshKeyPath: key2, gitName: 'New Bot', gitEmail: 'new@acme.io' }))
      expect(await gitCfg(repo.root, 'user.email')).toBe('new@acme.io')
      expect(await gitCfg(repo.root, 'user.name')).toBe('New Bot')
      expect(await gitCfg(repo.root, 'core.sshCommand')).toContain('id_new')
      expect(await gitCfg(other.root, 'user.email')).toBe('someone@else')
      expect(await gitCfg(other.root, 'core.sshCommand')).toBe('')
      expect(updated).toEqual([p.id])
    } finally {
      await other.cleanup()
    }
  })

  test('dropping the ssh key removes the old key from repos that had the old identity', async () => {
    const p = await svc.createProject(input())
    picked = repo.root
    await svc.addFolder(p.id)
    expect(await gitCfg(repo.root, 'core.sshCommand')).toContain('id_acme')
    await svc.updateProject(p.id, input({ sshKeyPath: '' }))
    expect(await gitCfg(repo.root, 'core.sshCommand')).toBe('')
    expect(await gitCfg(repo.root, 'user.email')).toBe('bot@acme.io')
  })

  test('a repo edited by hand since is left alone', async () => {
    const p = await svc.createProject(input())
    picked = repo.root
    await svc.addFolder(p.id)
    await run('git', ['-C', repo.root, 'config', '--local', 'user.email', 'hand@edit'], { env: repo.env })
    await svc.updateProject(p.id, input({ gitEmail: 'new@acme.io' }))
    expect(await gitCfg(repo.root, 'user.email')).toBe('hand@edit')
  })

  test('updateSubProject sets setupCommand', async () => {
    const p = await svc.createProject(input())
    picked = t.tmp
    const r = await svc.addFolder(p.id)
    if (r.status !== 'added') throw new Error('x')
    await svc.updateSubProject(r.subProject.id, { setupCommand: 'pnpm i' })
    expect(store.state.subProjects[0].setupCommand).toBe('pnpm i')
  })

  test('mute and unmute; editing the project keeps it muted', async () => {
    const p = await svc.createProject(input())
    expect(p.muted).toBeUndefined()
    await svc.setProjectMuted(p.id, true)
    expect(store.state.projects[0].muted).toBe(true)
    await svc.updateProject(p.id, input({ name: 'Acme 2' }))
    expect(store.state.projects[0].muted).toBe(true)
    await svc.setProjectMuted(p.id, false)
    expect(store.state.projects[0].muted).toBeFalsy()
    await expect(svc.setProjectMuted('nope', true)).rejects.toThrow('Project not found.')
  })
})
