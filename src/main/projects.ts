import { access } from 'node:fs/promises'
import { basename } from 'node:path'
import type { AddFolderResult, ProjectInput } from '@shared/api'
import type { GitIdentity, Project, RepoIdentity, SubProject } from '@shared/types'
import type { Exec } from './exec'
import type { GitClient } from './git'
import {
  applyRepoIdentity, buildSshCommand, envVarNameError, identityMatches, readRepoIdentity, replaceRepoIdentity
} from './identity'
import { newId, type Store } from './store'

export type { AddFolderResult, ProjectInput }

interface Deps {
  store: Store
  git: GitClient
  exec: Exec
  env: Record<string, string>
  home: string
  pickFolder: () => Promise<string | null>
  /** Runs after a project is saved, e.g. to rewrite its sessions' env.sh. */
  onProjectUpdated?: (projectId: string) => Promise<void>
}

const exists = (p: string) => access(p).then(() => true, () => false)
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export class ProjectService {
  constructor(private readonly deps: Deps) {}

  private async validate(i: ProjectInput): Promise<ProjectInput> {
    const name = i.name.trim()
    if (!name) throw new Error('Give the project a name.')
    if (i.identity.sshKeyPath && !(await exists(i.identity.sshKeyPath))) throw new Error(`SSH key not found: ${i.identity.sshKeyPath}`)
    if (!i.identity.gitEmail.includes('@')) throw new Error('Enter a commit email.')
    // Same rules as buildSessionEnv, so a saved project can always start a session.
    const extraEnv = i.extraEnv.map((e) => ({ key: e.key.trim(), value: e.value })).filter((e) => e.key)
    for (const { key } of extraEnv) {
      const error = envVarNameError(key)
      if (error) throw new Error(error)
    }
    return { name, identity: { ...i.identity, gitName: i.identity.gitName.trim(), gitEmail: i.identity.gitEmail.trim() }, extraEnv }
  }

  async createProject(input: ProjectInput): Promise<Project> {
    const i = await this.validate(input)
    const project: Project = { id: newId('p'), name: i.name, identity: i.identity, extraEnv: i.extraEnv, createdAt: Date.now() }
    await this.deps.store.update((d) => { d.projects.push(project) })
    return project
  }

  async setProjectMuted(id: string, muted: boolean): Promise<void> {
    await this.deps.store.update((d) => {
      const p = d.projects.find((x) => x.id === id)
      if (!p) throw new Error('Project not found.')
      if (muted) p.muted = true
      else delete p.muted
    })
  }

  async updateProject(id: string, input: ProjectInput): Promise<Project> {
    const before = this.project(id)
    if (!before) throw new Error('Project not found.')
    const from = { ...before.identity }
    const i = await this.validate(input)
    let out!: Project
    await this.deps.store.update((d) => {
      const p = d.projects.find((x) => x.id === id)
      if (!p) throw new Error('Project not found.')
      p.name = i.name
      p.identity = i.identity
      p.extraEnv = i.extraEnv
      out = { ...p }
    })
    await this.deps.onProjectUpdated?.(id)
    const to = i.identity
    if (from.sshKeyPath !== to.sshKeyPath || from.gitName !== to.gitName || from.gitEmail !== to.gitEmail) {
      await this.updateRepoIdentities(id, from, to)
    }
    return out
  }

  /** Repos that still carry the project's old identity get the new one; any other local config is left alone. */
  private async updateRepoIdentities(projectId: string, from: GitIdentity, to: GitIdentity): Promise<void> {
    const { store, exec, env, home } = this.deps
    const roots = new Set(store.state.subProjects
      .filter((s) => s.projectId === projectId && s.kind === 'repo' && s.repoRoot)
      .map((s) => s.repoRoot!))
    const failed: string[] = []
    for (const root of roots) {
      try {
        await replaceRepoIdentity(root, from, to, exec, env, home)
      } catch (e) {
        failed.push(`${root} (${msg(e)})`)
      }
    }
    if (failed.length) throw new Error(`Saved, but couldn't update the git identity in ${failed.join(', ')}.`)
  }

  async removeProject(id: string): Promise<{ ok: boolean; message?: string }> {
    if (this.deps.store.state.subProjects.some((s) => s.projectId === id)) {
      return { ok: false, message: 'Remove its sub-projects first.' }
    }
    await this.deps.store.update((d) => { d.projects = d.projects.filter((p) => p.id !== id) })
    return { ok: true }
  }

  async addFolder(projectId: string): Promise<AddFolderResult> {
    const picked = await this.deps.pickFolder()
    if (!picked) return { status: 'cancelled' }
    return this.add(projectId, picked, undefined)
  }

  confirmAddFolder(projectId: string, path: string, overwriteIdentity: boolean): Promise<AddFolderResult> {
    return this.add(projectId, path, overwriteIdentity)
  }

  async removeSubProject(id: string): Promise<{ ok: boolean; message?: string }> {
    if (this.deps.store.state.sessions.some((s) => s.subProjectId === id && s.archivedAt === undefined)) {
      return { ok: false, message: 'Archive its sessions first.' }
    }
    await this.deps.store.update((d) => { d.subProjects = d.subProjects.filter((s) => s.id !== id) })
    return { ok: true }
  }

  async updateSubProject(id: string, patch: { setupCommand?: string; teardownCommand?: string }): Promise<void> {
    await this.deps.store.update((d) => {
      const sp = d.subProjects.find((s) => s.id === id)
      if (!sp) return
      if (patch.setupCommand !== undefined) {
        if (patch.setupCommand.trim()) sp.setupCommand = patch.setupCommand
        else delete sp.setupCommand
      }
      if (patch.teardownCommand !== undefined) {
        if (typeof patch.teardownCommand !== 'string') throw new Error('Teardown command must be text.')
        if (patch.teardownCommand.trim()) sp.teardownCommand = patch.teardownCommand
        else delete sp.teardownCommand
      }
    })
  }

  private project(id: string): Project | undefined {
    return this.deps.store.state.projects.find((p) => p.id === id)
  }

  /** overwrite: undefined = first pass (ask on mismatch), true = apply, false = leave the repo config alone. */
  private async add(projectId: string, path: string, overwrite: boolean | undefined): Promise<AddFolderResult> {
    const { store, git, exec, env, home } = this.deps
    const project = this.project(projectId)
    if (!project) return { status: 'error', message: 'Project not found.' }
    try {
      const dup = store.state.subProjects.find((s) => s.path === path)
      if (dup) {
        const owner = store.state.projects.find((p) => p.id === dup.projectId)
        return { status: 'error', message: `That folder is already added (in ${owner?.name ?? 'another project'}).` }
      }
      const info = await git.detectFolder(path)
      const sp: SubProject = { id: newId('sp'), projectId, name: basename(path), path, kind: 'folder', createdAt: Date.now() }
      if (info.kind === 'repo') {
        sp.kind = 'repo'
        sp.repoRoot = info.repoRoot
        sp.relPath = info.relPath
        const current = await readRepoIdentity(info.repoRoot, exec, env)
        if (overwrite === true) {
          await applyRepoIdentity(info.repoRoot, project.identity, exec, env, home)
        } else if (overwrite === undefined) {
          const unset = current.sshCommand === undefined && current.name === undefined && current.email === undefined
          if (unset) {
            await applyRepoIdentity(info.repoRoot, project.identity, exec, env, home)
          } else if (!identityMatches(current, project.identity, home)) {
            // No key: applying the identity leaves core.sshCommand as it is, so propose none.
            const proposed: RepoIdentity = { name: project.identity.gitName, email: project.identity.gitEmail }
            if (project.identity.sshKeyPath) proposed.sshCommand = buildSshCommand(project.identity.sshKeyPath, home)
            return { status: 'needs_identity_confirm', path, current, proposed }
          }
        }
      }
      await store.update((d) => { d.subProjects.push(sp) })
      return { status: 'added', subProject: sp }
    } catch (e) {
      return { status: 'error', message: msg(e) }
    }
  }
}
