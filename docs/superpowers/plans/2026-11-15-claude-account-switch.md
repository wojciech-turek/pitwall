# Claude Account Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Claude accounts inside Pitwall and switch between them from beside the usage meters, moving running sessions to the new account with their conversations intact.

**Architecture:** An account is a Claude config folder. Added accounts get a folder under Pitwall's data dir whose history and settings are links to the default folder; a session's account is written into its `env.sh`/`env.json` as `CLAUDE_CONFIG_DIR`. Moving a session rewrites those files and restarts its Claude terminal, which resumes the same conversation id; a marker file tells the launcher not to start a fresh conversation if that fails.

**Tech Stack:** Electron, TypeScript, React + zustand (renderer), vitest, Playwright, POSIX sh launcher (`resources/bin/pitwall-launch`) and its Node twin (`src/host/launcher.ts`).

**Spec:** `docs/superpowers/specs/2026-11-15-claude-account-switch-design.md`

## Global Constraints

- Pitwall never reads, copies or stores a Claude login: no Keychain access, no `.credentials.json` reads, never copy `oauthAccount` or `userID`.
- Pitwall writes nothing into the Default config folder; it only creates links pointing at it and reads its `.claude.json`.
- An account folder is always passed with one spelling: absolute, real path, no trailing slash.
- A user who never adds an account gets byte-for-byte the same `env.sh` / `env.json` as today.
- `resources/bin/pitwall-launch` and `src/host/launcher.ts` behave the same; every launcher change lands in both, with a test in `tests/main/launcher.test.ts` and `tests/host/launcher.test.ts`.
- A project that sets `CLAUDE_CONFIG_DIR` in its extra variables is pinned: never moved, never counted.
- Nothing is typed into a session before a `SessionStart` that follows its relaunch.
- Never run against the installed Pitwall or real sessions. Unit tests: `env -u GIT_SSH_COMMAND pnpm vitest run <file>`. `tests/main/continue.test.ts` flakes under load; rerun it alone before treating a failure as real.
- New suites must hold on Windows (path separators, junctions, no symlinked files there).
- User-facing copy is fixed by the spec; copy it verbatim.

## Review Focus

1. **A session's project gains or loses a pinned `CLAUDE_CONFIG_DIR` while a move is pending.** Expected: the pending move is dropped and the session follows the project. Test in Task 6.
2. **Pitwall quits between writing `moved-from` and `SessionStart`.** Expected: on next start the session is still shown on the new account with the marker honoured, not silently reverted or left half-moved. Test in Task 6.
3. **The account a session points at no longer exists** (settings edited, folder deleted by hand). Expected: the session runs on Default and says so in a start warning; nothing throws in `snapshot()`. Test in Task 1.
4. **A linked item is missing in Default at creation, or Default's `.claude.json` is missing or corrupt.** Expected: the item is skipped, the account is still created, nothing is written to Default. Test in Task 3.
5. **Switch clicked twice quickly, or switched back while moves are pending.** Expected: each session ends with exactly one target; switching back to its current account cancels its move; no session restarts twice. Test in Task 6.

---

## File structure

| File | Responsibility |
|---|---|
| `src/shared/types.ts` | `ClaudeAccount`, `AccountView`, new `Session`/`SessionView`/`AppSettings` fields |
| `src/main/accounts.ts` | Which account and folder a session uses (pure) + labels and identity read from `.claude.json` |
| `src/main/account-folders.ts` (new) | Creating, linking, copying into, and deleting an added account's folder |
| `src/main/accounts-service.ts` (new) | The account list (settings + usage), add / remove / set active, pushes to the renderer |
| `src/main/sessions/mover.ts` (new) | Pending moves, the move itself, revert, the 60-second wait |
| `src/main/identity.ts`, `src/main/sessions/starter.ts` | Account into the session environment |
| `resources/bin/pitwall-launch`, `src/host/launcher.ts` | Credential stripping; `moved-from` handling |
| `src/renderer/src/components/AccountsPanel.tsx` (new, replaces `UsageMeter.tsx`) | The list, Switch, Add account… |
| `src/renderer/src/components/dialogs/AddAccountDialog.tsx`, `SwitchAccountDialog.tsx` (new) | Sign-in terminal; "Move N running sessions…" |
| `src/renderer/src/components/SessionHeader.tsx` | Move to account menu, pending/waiting banners, limit banner button |

---

### Task 0: Check first (by hand, with the user)

Nothing here is automated; it needs a second signed-in account. Do it in a plain terminal with scratch folders, never in the installed Pitwall. Record each answer under a new "Check first: results" heading at the end of the spec, then apply the spec's "If a check fails" branch to the tasks named.

- [ ] **Step 1:** `A=$(mktemp -d)/acct; mkdir -p "$A"; CLAUDE_CONFIG_DIR="$A" claude auth login` with the second account. Record: does it honour the folder and exit 0 when done (check 3)? Does `CLAUDE_CONFIG_DIR="$A" claude auth status` show the second account while plain `claude auth status` still shows the first (check 2, at the installed version)? Affects Task 4.
- [ ] **Step 2:** Record the keys of `$A/.claude.json` (names only, no values) and which carry onboarding and per-folder trust (check 6). Affects Task 3.
- [ ] **Step 3:** In `$A`, create links to `~/.claude` for `projects`, `todos`, `plans`, `file-history`, `shell-snapshots`, `settings.json`, `CLAUDE.md`, `commands`, `agents`, `skills`, `plugins`, `keybindings.json` (those that exist). In a scratch git folder run `claude` on the first account, say "remember the word plum", exit, note the session id, then `CLAUDE_CONFIG_DIR="$A" claude --resume <id>` and ask for the word (check 1). **If it does not resume, stop and go back to the user.**
- [ ] **Step 4:** In that resumed session run `/config` and change one setting, `/plugin` list; exit; `ls -l "$A"`: is every link still a link, are plugins and skills visible (check 4)? Affects Task 3.
- [ ] **Step 5:** Leave one session on each account idle for over an hour (token refresh), then prompt both (check 5). **If a login is wiped, stop and go back to the user.**
- [ ] **Step 6:** `CLAUDE_CONFIG_DIR="$A" claude auth logout`; confirm plain `claude auth status` is still signed in (check 3). Find the oldest Claude Code version with per-folder logins from the changelog (check 2) and record it as `MIN_CLAUDE_FOR_ACCOUNTS`.
- [ ] **Step 7:** Commit the spec's results section.

---

### Task 1: Account model and resolution

**Files:**
- Modify: `src/shared/types.ts`, `src/main/accounts.ts`, `src/main/identity.ts:176-181`, `src/main/store.ts:29` (`settingsFrom`), `src/main/sessions/manager.ts:117-141`, `src/main/index.ts:280-290`, `src/main/history.ts:54`, `src/main/sessions/continue.ts:155`, `src/main/sessions/starter.ts:128`
- Test: `tests/main/accounts.test.ts`, `tests/main/store.test.ts`, `tests/main/manager.test.ts`

**Interfaces:**
- Produces (types): `interface ClaudeAccount { id: string; dir: string; addedAt: number }`; `AppSettings.claudeAccounts?: ClaudeAccount[]`; `AppSettings.activeAccount?: string`; `Session.account?: string`; `Session.moveTo?: string`; `SessionView.accountId: string`; `SessionView.accountPinned?: boolean`; `SessionView.account` stays the folder key.
- Produces (`src/main/accounts.ts`):
  - `const DEFAULT_ACCOUNT_ID = 'default'`
  - `interface AccountCtx { settings: AppSettings; home: string; env: Record<string, string> }`
  - `normalizeDir(dir: string, home: string): string` — expands a leading `~`, resolves, `realpathSync` when it exists, strips a trailing separator.
  - `defaultAccountDir(ctx: AccountCtx): string`
  - `isPinned(project: Project): boolean`
  - `sessionAccountId(project: Project, session: Pick<Session, 'account'>, ctx: AccountCtx): string | null` — `null` when pinned; an id not in settings resolves to `DEFAULT_ACCOUNT_ID`.
  - `sessionConfigDir(project: Project, session: Pick<Session, 'account'>, ctx: AccountCtx): string`
  - `accountKey(project, session, ctx): string` (replaces the two-argument form)
  - `accountMissing(session: Pick<Session, 'account'>, ctx: AccountCtx): boolean`
- `claudeConfigDir(project, home, env)` in `identity.ts` is removed; callers use `sessionConfigDir`. Callers with no session (history's project-less source, "Continue a conversation" listing) pass `{ account: ctx.settings.activeAccount }`.

- [ ] **Step 1: Write the failing tests** in `tests/main/accounts.test.ts`:

```ts
const ctx = (over: Partial<AppSettings> = {}, env = {}) => ({ settings: { ...DEFAULT_SETTINGS, ...over }, home, env })
const added = { id: 'a1', dir: join(home, 'data/claude-accounts/a1'), addedAt: 1 }

it('a session with no account runs on Default', () => {
  expect(sessionAccountId(project(), {}, ctx())).toBe('default')
  expect(sessionConfigDir(project(), {}, ctx())).toBe(join(home, '.claude'))
})
it("a session's own account gives that account's folder", () => {
  expect(sessionConfigDir(project(), { account: 'a1' }, ctx({ claudeAccounts: [added] }))).toBe(added.dir)
})
it('a project that sets CLAUDE_CONFIG_DIR is pinned and wins over the session account', () => {
  const p = project({ extraEnv: [{ key: 'CLAUDE_CONFIG_DIR', value: '~/work-claude' }] })
  expect(isPinned(p)).toBe(true)
  expect(sessionAccountId(p, { account: 'a1' }, ctx({ claudeAccounts: [added] }))).toBeNull()
  expect(sessionConfigDir(p, { account: 'a1' }, ctx({ claudeAccounts: [added] }))).toBe(join(home, 'work-claude'))
})
it('an account that no longer exists falls back to Default and is reported missing', () => {
  expect(sessionAccountId(project(), { account: 'gone' }, ctx())).toBe('default')
  expect(accountMissing({ account: 'gone' }, ctx())).toBe(true)
})
it('normalizeDir expands ~, drops a trailing slash and resolves a symlinked spelling', () => { /* real tmp dir + symlink; skip the symlink half on win32 */ })
it("the app's own CLAUDE_CONFIG_DIR starting with ~ is expanded", () => {
  expect(defaultAccountDir(ctx({}, { CLAUDE_CONFIG_DIR: '~/alt' }))).toBe(join(home, 'alt'))
})
```

In `tests/main/store.test.ts`: `settingsFrom` keeps `claudeAccounts` and `activeAccount` from `current` whatever `input` holds (the renderer's Settings dialog must not be able to edit them), and drops an `activeAccount` naming no account. In `tests/main/manager.test.ts`: `snapshot()` gives `accountId: 'a1'` and `account: added.dir` for a session with `account: 'a1'`; `accountPinned: true` for a pinned project's session; a session whose account is missing gets `startWarning` "This session's Claude account was removed. It runs on the default account." and does not throw.

- [ ] **Step 2:** Run `env -u GIT_SSH_COMMAND pnpm vitest run tests/main/accounts.test.ts tests/main/store.test.ts tests/main/manager.test.ts`. Expected: FAIL (exports missing).
- [ ] **Step 3:** Implement the types and functions above. The manager's per-project account cache (`manager.ts:61`) becomes per-session-id and is still cleared on every store change.
- [ ] **Step 4:** Update every caller listed under Files; `index.ts:282` `defaultAccount` calls `defaultAccountDir`. Remove the two Accounts lines and the `defaultAccount` tidy-up from `docs/todo.md`.
- [ ] **Step 5:** Run `pnpm typecheck` and `env -u GIT_SSH_COMMAND pnpm test`. Expected: PASS.
- [ ] **Step 6:** Commit: `Accounts: a session has its own Claude account; a project's CLAUDE_CONFIG_DIR pins it`.

---

### Task 2: The account in a session's environment

**Files:**
- Modify: `src/main/identity.ts` (`buildSessionEnv`), `src/main/sessions/starter.ts` (`writeSessionFiles`, `startSessionLocked`), `src/main/sessions/resume.ts`, `src/main/cli/*` (where `pitwall new` builds its `NewSessionInput`), `resources/bin/pitwall-launch` (`load_identity`), `src/host/launcher.ts` (`launchEnv`)
- Test: `tests/main/identity.test.ts`, `tests/main/starter.test.ts`, `tests/main/resume.test.ts`, `tests/main/launcher.test.ts`, `tests/host/launcher.test.ts`

**Interfaces:**
- Consumes: `sessionAccountId`, `sessionConfigDir`, `DEFAULT_ACCOUNT_ID` (Task 1).
- Produces: `buildSessionEnv` input gains `claudeAccountDir?: string`. When set, the env holds `CLAUDE_CONFIG_DIR=<dir>` and `PITWALL_CLAUDE_ACCOUNT=1`; a project's own `CLAUDE_CONFIG_DIR` is never overwritten (pinned sessions never pass it). `writeSessionFiles` passes it only when the session's account id is neither `null` nor `DEFAULT_ACCOUNT_ID`.
- Produces: `const CLAUDE_CREDENTIAL_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']` exported from `src/host/launcher.ts`.

- [ ] **Step 1: Write the failing tests.**
  - `identity.test.ts`: with `claudeAccountDir`, env has both variables; without it, the env's keys equal today's exactly (snapshot the key list).
  - `starter.test.ts`: a new session gets `account` = `settings.activeAccount` (absent when Default is active); with `input.createdBy` naming a session on `a1` while Default is active, the helper gets `account: 'a1'`; `env.sh` for a Default session has no `CLAUDE_CONFIG_DIR` line.
  - `resume.test.ts`: a session resumed from the archive takes the active account.
  - `launcher.test.ts` and `tests/host/launcher.test.ts` (same three cases each, with the fake `claude` that prints its environment): with `PITWALL_CLAUDE_ACCOUNT=1`, an inherited `ANTHROPIC_API_KEY` is absent in Claude's environment; one set in the session's own `env.sh`/`env.json` is present; without the flag an inherited one is passed through as today.
- [ ] **Step 2:** Run those five files. Expected: FAIL.
- [ ] **Step 3:** Implement. In `pitwall-launch`'s `load_identity`: after sourcing `env.sh`, if `PITWALL_CLAUDE_ACCOUNT` is set, `unset` the three variables and source `env.sh` again (the pattern at lines 11-15). In `launchEnv`: delete the three from the base before `mergeEnv`, as `TOKENS` is handled.
- [ ] **Step 4:** Run the five files, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `Launch: a session on an added account gets its folder, and inherited Claude credentials don't override it`.

---

### Task 3: Account folders

**Files:**
- Create: `src/main/account-folders.ts`
- Modify: `src/main/paths.ts` (add `claudeAccountsDir: join(dataDir, 'claude-accounts')`), `src/main/accounts.ts` (identity)
- Test: `tests/main/account-folders.test.ts` (new), `tests/main/accounts.test.ts`

**Interfaces:**
- Produces (`account-folders.ts`):
  - `const LINKED_DIRS = ['projects', 'todos', 'plans', 'file-history', 'shell-snapshots', 'commands', 'agents', 'skills', 'plugins']`
  - `const LINKED_FILES = ['settings.json', 'CLAUDE.md', 'keybindings.json']`
  - `const PROFILE_KEYS = ['mcpServers', 'hasCompletedOnboarding', ...]` — the onboarding keys recorded in Task 0 Step 2.
  - `profileFile(dir: string, home: string): string` — `<home>/.claude.json` when `dir` is `<home>/.claude`, else `<dir>/.claude.json` (moves here from `accountLabel`).
  - `createAccountFolder(root: string, id: string): Promise<string>` — makes `<root>/<id>` mode 0700, returns its normalized path.
  - `linkShared(dir: string, defaultDir: string, platform?: NodeJS.Platform): Promise<void>` — idempotent; skips a target missing in Default; never replaces something that isn't a link it made; win32: junctions for dirs, copies for files. Any item Task 0 Step 4 found unsafe to link is copied on every platform.
  - `copyProfileKeys(fromFile: string, toFile: string, keys: readonly string[]): Promise<void>` — merges only those keys into `toFile`, atomic write, 0600; a missing or corrupt `fromFile` is a no-op.
  - `copyProjectEntry(fromFile: string, toFile: string, cwd: string): Promise<void>` — copies `projects[cwd]` only.
  - `removeAccountFolder(dir: string, root: string): Promise<void>` — refuses a `dir` not directly inside `root`; unlinks links without following them, then removes the rest.
- Produces (`accounts.ts`): `accountIdentity(key: string, home: string): Promise<{ email: string; org: string | null; orgName: string | null } | null>` from `oauthAccount.emailAddress` / `organizationUuid` / `organizationName` (cached by mtime like `emailIn`); `sameAccount(a, b): boolean` (email and org both equal); `accountLabels(keys: string[], home): Promise<Map<string, string>>` — the email, plus ` · <orgName or "Personal">` for keys sharing an email, else the folder with `~`.

- [ ] **Step 1: Write the failing tests** in `tests/main/account-folders.test.ts` (real temp dirs):

```ts
it('links every shared item that exists in Default and skips the rest', async () => {
  // Default has projects/, settings.json; no plugins/
  await linkShared(dir, def)
  expect(realpathSync(join(dir, 'projects'))).toBe(realpathSync(join(def, 'projects')))
  expect(existsSync(join(dir, 'plugins'))).toBe(false)
})
it('picks up an item that appears in Default later', async () => { /* mkdir def/plugins; linkShared again; now linked */ })
it('never replaces a real file or folder already in the account', async () => { /* dir/settings.json is a regular file; stays */ })
it('copies only the named keys and never the signed-in profile', async () => {
  // from: { mcpServers: {x:1}, hasCompletedOnboarding: true, oauthAccount: {...}, userID: 'u' }; to: { oauthAccount: {emailAddress:'b@x'} }
  await copyProfileKeys(from, to, PROFILE_KEYS)
  expect(JSON.parse(readFileSync(to, 'utf8'))).toEqual({ oauthAccount: { emailAddress: 'b@x' }, mcpServers: { x: 1 }, hasCompletedOnboarding: true })
})
it('a missing or corrupt source profile changes nothing', ...)
it("copies one folder's project entry", ...)
it('removing an account never touches what its links point at', async () => {
  await removeAccountFolder(dir, root)
  expect(existsSync(dir)).toBe(false)
  expect(existsSync(join(def, 'projects', 'keep.jsonl'))).toBe(true)
})
it('refuses to remove a folder outside the accounts root', ...)
it('writes nothing into Default', async () => { /* snapshot def tree (names + mtimes) before/after create+link+copy */ })
it.runIf(process.platform === 'win32')('uses junctions for folders and copies for files', ...)
```

In `accounts.test.ts`: `sameAccount` is false for one email in two organisations; `accountLabels` gives `me@x.com · Acme` and `me@x.com · Personal` for those, and a bare email when unique.

- [ ] **Step 2:** Run both files. Expected: FAIL.
- [ ] **Step 3:** Implement. `accountLabel` is replaced by `accountLabels`; `UsageTracker`'s `labelFor` dep keeps its shape and is fed from it in `index.ts`.
- [ ] **Step 4:** Run both files and `tests/main/usage.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit: `Accounts: an added account's folder shares history and settings with the default one`.

---

### Task 4: The account list, adding and removing

**Files:**
- Create: `src/main/accounts-service.ts`, `src/renderer/src/state/accounts.ts`, `src/renderer/src/components/dialogs/AddAccountDialog.tsx`
- Modify: `src/shared/types.ts`, `src/shared/api.ts`, `src/preload/index.ts`, `src/main/ipc.ts`, `src/main/index.ts`, `src/main/usage.ts` (`sessions` mapping uses `accountKey(project, session, ctx)`), `src/main/pty-bridge.ts` (a one-off terminal not tied to a session)
- Test: `tests/main/accounts-service.test.ts` (new), `tests/main/ipc.test.ts`, `tests/main/usage.test.ts`

**Interfaces:**
- Consumes: Task 1 and Task 3 exports.
- Produces (types): `interface AccountView { id?: string; account: string; label: string; active: boolean; usage?: ClaudeUsage; sessions: number; signedIn: boolean }` — `id` is absent for a pinned project's folder; `sessions` counts live sessions on it plus those with `moveTo` naming it.
- Produces (`AccountsService`):
  - `list(): Promise<AccountView[]>` — Default, every added account, then pinned folders that have reported usage; active first, then by label.
  - `onChange(cb: (a: AccountView[]) => void): () => void` — fires on store and usage changes.
  - `beginAdd(): Promise<{ addId: string; dir: string }>` — creates the folder; throws `Claude Code <MIN_CLAUDE_FOR_ACCOUNTS> or newer is needed to add accounts.` below the floor (`claude --version` via `exec`).
  - `finishAdd(addId: string): Promise<{ ok: true; id: string } | { ok: false; message: string }>` — requires an email in the folder's `.claude.json`; same account as an existing one → folder discarded, message `<label> is already added.`; else `copyProfileKeys` from Default, `linkShared`, append to `settings.claudeAccounts`. Does not change `activeAccount`.
  - `cancelAdd(addId: string): Promise<void>`
  - `remove(id: string): Promise<void>` — throws `Move or archive the sessions using this account first.` when `sessions > 0`; runs `claude auth logout` with `CLAUDE_CONFIG_DIR` set, then `removeAccountFolder`; if it was active, Default becomes active.
  - `copyFromDefault(id: string): Promise<void>` — `copyProfileKeys(['mcpServers'])` and `linkShared` again.
  - `setActive(id: string): Promise<void>`
- Produces (API, each with an `IPC` channel): `getAccounts()`, `onAccounts(cb)`, `beginAddAccount()`, `finishAddAccount(addId)`, `cancelAddAccount(addId)`, `removeAccount(id)`, `copyAccountSettings(id)`. The login terminal: `openLoginTerminal(addId | accountId): Promise<void>` starts `claude auth login` (or the Task 0 fallback: plain `claude`) with `CLAUDE_CONFIG_DIR` set, streamed over the existing `termData`/`termExit` channels under the id `login:<addId>` and kind `'claude'`.
- Produces (renderer): `useAccounts(): AccountView[]` in `state/accounts.ts`, one subscription, same shape as `state/usage.ts`.

- [ ] **Step 1: Write the failing tests** in `tests/main/accounts-service.test.ts` with a fake `exec` and temp dirs: `list()` with nothing added is one Default row, `active: true`; `finishAdd` with no email → `{ ok: false }` and the folder is gone; a duplicate (same email and org) → `{ ok: false, message: 'b@x.com is already added.' }`; same email, other org → added, labels carry ` · <org>`; adding never changes `activeAccount`; `remove` with a session on it throws the fixed message; `remove` calls `claude auth logout` with that folder's `CLAUDE_CONFIG_DIR` and never without one; removing the active account makes Default active; below the version floor `beginAdd` throws the fixed message and creates no folder. In `usage.test.ts`: a session with `account: 'a1'` reports into `a1`'s folder key. In `ipc.test.ts`: every new channel rejects a non-string id.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement the service, IPC and preload wiring, and `AddAccountDialog` (a `Dialog` holding a `TerminalView` on `login:<addId>`, a **Cancel** button calling `cancelAddAccount`, and on `termExit` code 0 a call to `finishAddAccount`, showing its message on failure). Nothing opens the dialog yet; Task 7 adds the entry point.
- [ ] **Step 4:** Run the three files, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `Accounts: add one by signing in, remove one, list them with their usage`.

---

### Task 5: Launchers don't start a fresh conversation after a move

**Files:**
- Modify: `resources/bin/pitwall-launch:97-111`, `src/host/launcher.ts:285-300`
- Test: `tests/main/launcher.test.ts`, `tests/host/launcher.test.ts`

**Interfaces:**
- Produces: while `<sessionDir>/moved-from` exists and `--resume` exits non-zero before a `SessionStart`, the launcher logs `{"c":<id>,"t":<ms>,"e":"pitwall:move-failed","code":<rc>}`, does not call `launch_new` / `launchNew`, then logs `pitwall:exited` and waits at "Press Enter to resume." as after any exit. The launcher never deletes the marker.

- [ ] **Step 1: Write the failing tests**, the same three in both files: with `moved-from` present and a fake `claude` that exits 1 on `--resume`, the events file gains `pitwall:move-failed` and the fake is never run with `--session-id`; without the marker the fresh-conversation fallback still happens (existing test stays green); with the marker and a `--resume` that emits `SessionStart` then exits 1, no `pitwall:move-failed` is logged.
- [ ] **Step 2:** Run both files. Expected: the two new cases FAIL.
- [ ] **Step 3:** Implement in both launchers.
- [ ] **Step 4:** Run both files. Expected: PASS.
- [ ] **Step 5:** Commit: `Launch: a moved session whose resume fails says so rather than starting a new conversation`.

---

### Task 6: Moving sessions

**Files:**
- Create: `src/main/sessions/mover.ts`
- Modify: `src/main/sessions/manager.ts` (expose `restartClaude(id)`; `snapshot()` adds `moveTo`, `moveWaiting`), `src/main/sessions/continue-at.ts` (nothing new; `cancel` is consumed), `src/main/index.ts`, `src/main/ipc.ts`, `src/shared/api.ts`, `src/preload/index.ts`, `src/shared/types.ts`
- Test: `tests/main/mover.test.ts` (new), `tests/main/manager.test.ts`

**Interfaces:**
- Consumes: `sessionAccountId`, `isPinned` (Task 1); `copyProjectEntry`, `profileFile` (Task 3); `AccountsService.setActive` (Task 4); the `pitwall:move-failed` event (Task 5); `ContinueScheduler.cancel`; `SessionManager.sendText`, `onSessionEvent`, `snapshot`.
- Produces (`SessionManager`): `restartClaude(id: string): Promise<void>` — `backend.killSession(claudeTmuxName(id))`, then `writeSessionFiles` and `launchTmuxFor`, on both backends.
- Produces (types): `SessionView.moveWaiting?: boolean`; `Session.movedFrom?: string` (the previous account id, mirroring the marker file so the state survives a restart).
- Produces (`AccountMover`):
  - `constructor(deps: { store; manager; continueAt; accounts ctx; paths; now; timers })`, `start()`, `stop()`
  - `movable(): SessionView[]` — live, unpinned sessions.
  - `request(sessionId: string, target: string): Promise<void>` — target equal to the current account clears `moveTo`; a pinned session throws `This session's project sets its own Claude account.`
  - `requestAll(target: string): Promise<{ now: number; later: number }>`
  - `cancel(sessionId: string): Promise<void>`
  - `moveBack(sessionId: string): Promise<void>`
  - `const WAIT_MS = 60_000`
- Produces (API + IPC): `setActiveAccount(id: string, moveRunning: boolean): Promise<{ now: number; later: number }>`, `moveSession(sessionId: string, accountId: string)`, `cancelMove(sessionId)`, `moveBack(sessionId)`, `countMovable(target: string): Promise<{ now: number; later: number }>`.

Behaviour (from the spec's "Moving a session"):
- A session moves when its status is `read`, `unread` or `exited`; otherwise `moveTo` waits and the mover acts on the status change.
- The move, in order: note `limitHit`; `continueAt.cancel`; `copyProjectEntry` (leaving account's profile → joining account's, for `session.cwd`); store update (`account` = target or deleted for Default, `movedFrom` = previous id, `moveTo` deleted); write `<sessionDir>/moved-from`; `manager.restartClaude`.
- `SessionStart` after the relaunch: delete the marker and `movedFrom`; if `limitHit` was noted, `sendText(id, 'continue')`.
- `pitwall:move-failed`: set `account` back to `movedFrom`, delete marker and `movedFrom`, `restartClaude`, and set the session's error to `Couldn't continue this conversation on <label>.`
- Neither within `WAIT_MS`: `moveWaiting = true` (banner in Task 8); nothing is reverted. `moveBack` does the revert steps without the error.
- On `start()`: sessions with `moveTo` are re-evaluated; sessions with `movedFrom` re-arm the wait (the marker is still honoured by the launcher).
- On a store change: a session whose project became pinned loses `moveTo`.

- [ ] **Step 1: Write the failing tests** in `tests/main/mover.test.ts` with a fake manager (settable statuses, recorded `restartClaude`/`sendText` calls, an event emitter), fake timers and a temp session dir:

```ts
it('an idle session moves at once: account set, marker written, Claude restarted once', ...)
it('a working session waits and moves when it becomes idle', ...)
it('a session waiting on a permission prompt does not move until it is idle', ...)
it('an exited session moves at once', ...)
it('a pinned session is refused and not counted by requestAll', ...)
it('requestAll reports how many moved now and how many wait', async () => {
  expect(await mover.requestAll('a1')).toEqual({ now: 2, later: 1 })
})
it('SessionStart clears the marker; continue is typed only if the limit banner was showing', ...)
it('nothing is typed before SessionStart', ...)
it('a scheduled continue is cancelled by the move', ...)
it('move-failed puts the session back, restarts it, and reports the fixed message', ...)
it('after 60 seconds with neither, the session is marked waiting and stays on the new account', ...)
it('moveBack returns a waiting session to its previous account', ...)
it("copies the folder's trust entry to the joining account before the restart", ...)
// Review Focus
it('a project that becomes pinned drops its sessions\' pending moves', ...)                      // 1
it('after a restart of Pitwall, a session mid-move keeps its new account and re-arms the wait', ...) // 2
it('requesting twice restarts once; switching back to the current account cancels the move', ...)   // 5
it('a new target replaces a pending one', ...)
```

- [ ] **Step 2:** Run `tests/main/mover.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `restartClaude`, `AccountMover`, the IPC handlers. `setActiveAccount` calls `accounts.setActive` then, when `moveRunning`, `mover.requestAll`.
- [ ] **Step 4:** Run `tests/main/mover.test.ts tests/main/manager.test.ts tests/main/continue-at.test.ts tests/main/ipc.test.ts`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `Accounts: move a running session to another account, keeping its conversation`.

---

### Task 7: The switch beside the meters

**Files:**
- Create: `src/renderer/src/components/AccountsPanel.tsx`, `src/renderer/src/components/dialogs/SwitchAccountDialog.tsx`
- Delete: `src/renderer/src/components/UsageMeter.tsx`
- Modify: `src/renderer/src/components/RightPanel.tsx:33`, `src/renderer/src/state/usage.ts` (add `staleNote`), `src/renderer/src/state/ui.ts` (two dialog kinds), `src/renderer/src/theme.css`
- Test: `tests/renderer/usage.test.ts`, `tests/renderer/accounts.test.ts` (new)

**Interfaces:**
- Consumes: `useAccounts`, `AccountView`, `setActiveAccount`, `countMovable`, `removeAccount`, `copyAccountSettings`, `openLoginTerminal`, `AddAccountDialog` (Tasks 4, 6).
- Produces (`state/usage.ts`): `staleNote(updatedAt: number, now: number): string` — `''` under 10 minutes, else `updated <relativeTime>`; `orderAccountViews(list: AccountView[]): AccountView[]` (active first). `orderAccounts` is removed with `UsageMeter`.
- Test ids kept: `usage-meter` (the panel root), `usage-5h`, `usage-week`, `usage-5h-<i>`, `usage-week-<i>`, `usage-account`. New: `account-switch-<i>`, `account-add`, `account-menu-<i>`, `switch-move`, `switch-new-only`.

Layout, per the spec's sketch:
- With only Default and no usage: the existing "Usage shows after Claude's next reply" line, then `+ Add account…`.
- With only Default and usage: the two rows as today (no label), then `+ Add account…`.
- With more: one block per account — a dot (filled when active), the label, **Switch** on non-active rows that have an `id`, a `⋯` menu (**Sign in again**, **Copy settings from Default**, **Remove**; Remove disabled with a title when `sessions > 0`; no menu on Default), the two rows or "No usage yet", and the stale note. The selected session's account, when not the active one, shows "This session". A pinned selected session shows "Set by this session's project" on its row.
- **Switch**: `countMovable(id)`; if `now + later === 0`, `setActiveAccount(id, false)`; else open `SwitchAccountDialog`: title `Move <N> running sessions to <label> too?`, body `<now> move now. <later> move when they finish.` and `Moving restarts Claude in each session. Anything it was running in the background stops.`, buttons **Move sessions** (`setActiveAccount(id, true)`) and **New sessions only** (`setActiveAccount(id, false)`).

- [ ] **Step 1: Write the failing tests.** `tests/renderer/usage.test.ts`: `staleNote` is `''` at 9 minutes and `updated 3h ago` at 3 hours. `tests/renderer/accounts.test.ts` (render with a stubbed `window.pitwall`): only Default → no label, no Switch, `account-add` present; two accounts → active first with a filled dot, **Switch** only on the other; an account with no usage shows "No usage yet"; a row with no `id` has no Switch; Switch with nothing movable calls `setActiveAccount('a1', false)` and opens no dialog; with `{ now: 3, later: 1 }` the dialog reads "Move 4 running sessions to b@x.com too?" and **New sessions only** calls `setActiveAccount('a1', false)`; Remove is disabled when `sessions > 0`.
- [ ] **Step 2:** Run both files. Expected: FAIL.
- [ ] **Step 3:** Implement. Before styling, load the `frontend-design:frontend-design` skill and match the existing `.usage-*` rules in `theme.css` (theme tokens only, no hard-coded colours).
- [ ] **Step 4:** Run `env -u GIT_SSH_COMMAND pnpm vitest run tests/renderer`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `Accounts: switch the active account beside the usage meters`.

---

### Task 8: A session's own controls

**Files:**
- Modify: `src/renderer/src/components/SessionHeader.tsx` (the header menu; `LimitBanner` at `:55-80`; two new banners), `src/renderer/src/components/SessionRow.tsx` (hover-card line for a pending move)
- Test: `tests/renderer/accounts.test.ts`

**Interfaces:**
- Consumes: `useAccounts`, `moveSession`, `cancelMove`, `moveBack`, `setActiveAccount`, `countMovable`, `SessionView.moveTo` / `moveWaiting` / `accountId` / `accountPinned`, `SwitchAccountDialog`.
- Produces: `bestOther(accounts: AccountView[], currentId: string, now: number): AccountView | undefined` in `state/usage.ts` — among other accounts with an `id`, the lowest 5-hour `usedPercentage` (a window past its reset or never reported counts as 0); ties by label.
- Test ids: `move-menu`, `move-to-<id>`, `move-pending`, `move-cancel`, `move-waiting`, `move-back`, `limit-switch`.

- [ ] **Step 1: Write the failing tests:** the header menu lists **Move to account ▸** with every other account that has an `id`, and omits the item for a pinned session or when there is one account; a session with `moveTo` shows `Moves to b@x.com when it finishes` and **Cancel** calls `cancelMove`; `moveWaiting` shows `Waiting on b@x.com: check the terminal` and **Move back** calls `moveBack`; the limit banner shows **Switch to b@x.com** beside "Continue at …" only when another account exists, and it behaves as that row's Switch (same `countMovable` → dialog path); `bestOther` picks 8% over 40%, treats a reset window as 0, and ignores rows without an `id`.
- [ ] **Step 2:** Run `tests/renderer/accounts.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `env -u GIT_SSH_COMMAND pnpm vitest run tests/renderer`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `Accounts: move one session from its header, and switch from the limit banner`.

---

### Task 9: End to end, and the docs

**Files:**
- Create: `tests/e2e/accounts.spec.ts`
- Modify: `tests/e2e/helpers.ts` (the fake `claude`: `auth login` writes `<CLAUDE_CONFIG_DIR>/.claude.json` with `oauthAccount.emailAddress` from `PITWALL_E2E_LOGIN_EMAIL` and exits 0; `auth logout` exits 0; `--version` prints a version at the floor; every run appends its `CLAUDE_CONFIG_DIR` and arguments to a log the test reads), `README.md`, `CHANGELOG.md`, `docs/todo.md`

- [ ] **Step 1: Write the e2e** (it fails until the fake `claude` is extended):
  1. Start a session; **Add account…**; the fake signs in as `b@example.com`; the panel lists two accounts, Default still active.
  2. **Switch** on `b@example.com` → dialog "Move 1 running sessions…" → **Move sessions**; the fake's log shows a second run with `--resume <same id>` and `CLAUDE_CONFIG_DIR` under the test's data dir; the panel marks `b@example.com` active.
  3. A new session's first run has that same `CLAUDE_CONFIG_DIR`.
  4. With `PITWALL_E2E_RESUME_FAILS=1` for the next move, switching back leaves the session on `b@example.com` with the message "Couldn't continue this conversation on" visible, and the fake was never run with `--session-id` for it.
  5. **Remove** on `b@example.com` is disabled while sessions use it.
- [ ] **Step 2:** Run `pnpm test:e2e -- accounts` and `pnpm test:e2e:host-launcher -- accounts`. Expected: PASS on both backends. Then the full `env -u GIT_SSH_COMMAND pnpm test` and `pnpm test:e2e`.
- [ ] **Step 3: Docs.** README: rewrite the "Claude usage meter" feature line to cover adding and switching accounts; in "How it works" add what an added account's folder shares; in "Privacy and safety" state that Pitwall stores no Claude login and writes nothing into `~/.claude`. CHANGELOG: an Unreleased entry. `docs/todo.md`: add "Check with real Claude Code" items for anything Task 0 left open.
- [ ] **Step 4: Try it in Pitwall Dev** (never the installed app) with the user's two real accounts: add, switch with one idle and one working session, hit **Move back**, remove. Record what was seen.
- [ ] **Step 5:** Commit: `Accounts: end-to-end test, README and changelog`.
