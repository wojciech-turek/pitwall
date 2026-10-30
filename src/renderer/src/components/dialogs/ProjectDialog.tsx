import { useEffect, useState } from 'react'
import type { EnvVar, GhAccount } from '@shared/types'
import Dialog from './Dialog'
import { useUi } from '../../state/ui'
import { useSnapshot } from '../../state/snapshot'
import { cleanIpcError } from '../../state/errors'
import { baseName } from '@shared/base-name'

export default function ProjectDialog({ projectId }: { projectId?: string }): React.JSX.Element {
  const close = useUi((s) => s.closeDialog)
  const snap = useSnapshot()
  const existing = projectId ? snap?.projects.find((p) => p.id === projectId) : undefined

  const [name, setName] = useState(existing?.name ?? '')
  const [sshKeyPath, setSsh] = useState(existing?.identity.sshKeyPath ?? '')
  const [ghAccount, setGh] = useState(existing?.identity.ghAccount ?? '')
  const [gitName, setGitName] = useState(existing?.identity.gitName ?? '')
  const [gitEmail, setGitEmail] = useState(existing?.identity.gitEmail ?? '')
  const [env, setEnv] = useState<EnvVar[]>(existing?.extraEnv ?? [])
  const [keys, setKeys] = useState<string[]>([])
  const [accounts, setAccounts] = useState<GhAccount[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [restartNote, setRestartNote] = useState(false)

  useEffect(() => {
    void window.pitwall.listSshKeys().then(setKeys).catch((e) => setError(cleanIpcError(e)))
    void window.pitwall.listGhAccounts().then(setAccounts).catch((e) => setError(cleanIpcError(e)))
  }, [])

  const keyOptions = sshKeyPath && !keys.includes(sshKeyPath) ? [sshKeyPath, ...keys] : keys
  const accountOptions = ghAccount && !accounts.some((a) => a.login === ghAccount)
    ? [{ login: ghAccount, active: false, ok: true }, ...accounts] : accounts

  const save = async (): Promise<void> => {
    setError(null)
    if (!name.trim()) { setError('Give the project a name.'); return }
    setSaving(true)
    const input = {
      name: name.trim(),
      identity: { sshKeyPath, ghAccount, gitName: gitName.trim(), gitEmail: gitEmail.trim() },
      extraEnv: env.filter((e) => e.key.trim()).map((e) => ({ key: e.key.trim(), value: e.value }))
    }
    const identityChanged = !!existing && (['sshKeyPath', 'ghAccount', 'gitName', 'gitEmail'] as const)
      .some((k) => existing.identity[k] !== input.identity[k])
    const hasSessions = !!snap?.sessions.some((x) =>
      snap.subProjects.find((sp) => sp.id === x.subProjectId)?.projectId === projectId)
    try {
      if (projectId) await window.pitwall.updateProject(projectId, input)
      else await window.pitwall.createProject(input)
      if (identityChanged && hasSessions) {
        setRestartNote(true)
        return
      }
      close()
    } catch (e) {
      setError(cleanIpcError(e))
      setSaving(false)
    }
  }

  const setEnvAt = (i: number, patch: Partial<EnvVar>): void =>
    setEnv((cur) => cur.map((e, j) => (j === i ? { ...e, ...patch } : e)))

  if (restartNote) {
    return (
      <Dialog key="restart-note" title="Edit project" testId="project-dialog" onClose={close}>
        <div className="form">
          <p className="muted-text help" role="status" data-testid="identity-restart-note">
            Running agents keep their current identity until they restart. To apply it now, exit Claude in the session and press Enter.
          </p>
          <div className="dialog-actions">
            <button type="button" className="btn primary" data-autofocus onClick={close}>Done</button>
          </div>
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog title={projectId ? 'Edit project' : 'New project'} testId="project-dialog" onClose={close}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void save() }}>
        <label>Name
          <input data-testid="project-name-input" data-autofocus value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>SSH key
          <select data-testid="ssh-key-select" value={sshKeyPath} onChange={(e) => setSsh(e.target.value)}>
            <option value="">None — use my default SSH setup</option>
            {keyOptions.map((k) => <option key={k} value={k}>{baseName(k)}</option>)}
          </select>
        </label>
        <label>GitHub account
          <select data-testid="gh-account-select" value={ghAccount} onChange={(e) => setGh(e.target.value)}>
            <option value="">None — gh uses its active account</option>
            {accountOptions.map((a) => <option key={a.login} value={a.login}>{a.login}{a.ok ? '' : ' (token invalid)'}</option>)}
          </select>
        </label>
        <div className="form-row">
          <label>Commit name
            <input data-testid="git-name-input" value={gitName} onChange={(e) => setGitName(e.target.value)} />
          </label>
          <label>Commit email
            <input data-testid="git-email-input" type="email" value={gitEmail} onChange={(e) => setGitEmail(e.target.value)} />
          </label>
        </div>
        <fieldset className="env">
          <legend>Extra environment variables</legend>
          {env.map((e, i) => (
            <div className="env-row" key={i}>
              <input placeholder="KEY" aria-label="Variable name" value={e.key} onChange={(ev) => setEnvAt(i, { key: ev.target.value })} />
              <input placeholder="value" aria-label="Variable value" value={e.value} onChange={(ev) => setEnvAt(i, { value: ev.target.value })} />
              <button type="button" className="icon-btn always" aria-label="Remove variable"
                onClick={() => setEnv((cur) => cur.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <button type="button" className="btn small" data-testid="add-env" onClick={() => setEnv((cur) => [...cur, { key: '', value: '' }])}>
            Add variable
          </button>
        </fieldset>
        {error && <div className="form-error" role="alert" data-testid="dialog-error">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button type="submit" className="btn primary" data-testid="save-project" disabled={saving}>Save</button>
        </div>
      </form>
    </Dialog>
  )
}
