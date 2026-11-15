# Switching Claude accounts on demand: design

Date: 2026-11-15. Status: awaiting approval.

## Intent

Someone with two Claude subscriptions (say personal and work) hits a limit on one and wants to carry on with the
other, without leaving Pitwall, signing out, or losing the conversation. Today the only way to use a second account is
to type `CLAUDE_CONFIG_DIR` as a raw variable in a project's dialog and sign in to that folder by hand, and a session
can never move from one account to the other.

Asked for by the user: a switch on demand, placed at the bottom right beside the usage limits, that sets the account
for new sessions and offers to move the running ones too. Everything else below is the author's call unless marked
**(user)**.

## Goals

- Add a Claude account from inside Pitwall by signing in in the browser. Adding one never signs another out.
- One click beside the usage meters makes another account the active one **(user)**.
- Switching sets the account for sessions started from now on, and asks whether to move the running sessions too.
  Idle ones move at once; ones mid-reply move when they finish. One session can also be moved alone **(user)**.
- A moved session continues the same conversation.
- Two accounts can run side by side (some sessions on each).

## Non-goals

- Switching automatically when a limit is hit. The limit banner offers the switch; the user clicks.
- API keys, Bedrock, Vertex or Console accounts as "accounts". Subscriptions only.
- Per-project account pickers. A project that sets `CLAUDE_CONFIG_DIR` itself keeps working as now (see Pinned).
- Balancing load across accounts.

## Anti-goals

- Pitwall reading, copying or storing a Claude login. The README promises "reads no Keychain entries and makes no API
  calls"; that stays true. Claude Code keeps each login itself.
- A session silently running on a different account from the one shown for it.
- A move that loses the conversation, or ends up starting a fresh one, without saying so.
- Touching the user's own `~/.claude` beyond what is listed under Shared and separate.

## Constraints

- Claude Code has no built-in account switch. Its supported way is one `CLAUDE_CONFIG_DIR` per account; the login
  lives in the macOS Keychain under a name derived from the literal path of that folder (elsewhere in
  `<folder>/.credentials.json`). So a folder must always be passed with exactly the same spelling: absolute, no
  trailing slash, no symlinked variant.
- Older Claude Code versions shared one Keychain entry across folders. A minimum version is needed (to be found, see
  Check first).
- A session's environment is read fresh at every start of Claude from `env.sh` (tmux, `resources/bin/pitwall-launch`)
  or `env.json` (the host launcher, `src/host/launcher.ts`). Both launchers must behave the same.
- Credentials in the environment (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`) outrank a
  subscription login, so an inherited one would make the shown account a lie.
- Never test against the installed Pitwall or the user's real sessions (Pitwall Dev and the quiet e2e only).

## Approaches

1. **A config folder per account, history linked to the default folder. Chosen.** What Orca does. Uses Claude Code's
   supported mechanism, stores no login, lets accounts run side by side. Cost: a config folder also holds settings,
   plugins, MCP servers and history, so Pitwall has to decide what each account shares (below).
2. **One folder, swap the Keychain entry.** No sharing problem, but Pitwall would read and write logins (breaks a
   stated promise), and every running session would flip together. Rejected.
3. **One folder, a `claude setup-token` token per account in `CLAUDE_CODE_OAUTH_TOKEN`.** No sharing problem either,
   but Pitwall would store year-long tokens, and those tokens can't use claude.ai connectors or Remote Control.
   Rejected.

The user handed over this choice; 1 is the author's pick.

## The design

### Accounts

An account is still identified by its config folder, as now (`accountKey` in `src/main/accounts.ts`).

- **Default**: the folder Pitwall uses today (the app's `CLAUDE_CONFIG_DIR`, else `~/.claude`). Always listed, can't
  be removed.
- **Added**: a folder Pitwall creates at `<dataDir>/claude-accounts/<id>`. Listed in the app's settings as
  `{ id, dir, addedAt }`. Its label is the signed-in email from the folder's `.claude.json`, as now.
- Two accounts are the same account when both the email and the organisation (`oauthAccount.organizationUuid`) match.
  One email can hold a personal plan and a seat in a work organisation; those are two accounts. When two rows share an
  email, each label adds the organisation's name (`oauthAccount.organizationName`), else "Personal".
- `settings.activeAccount` is the account new sessions start on (absent means Default).

### Which account a session runs on

In order:

1. **Pinned**: the session's project sets `CLAUDE_CONFIG_DIR` in its extra variables. That wins, as today. Such
   sessions are never moved, are not counted in "Move N running sessions", and the switch says why when one is
   selected.
2. The session's own account, a new `Session.account` field (an account id), set when the session starts and changed
   only by a move.
3. Sessions that exist before this ships have no field and run on Default, which is where they run now.

A new session takes the active account. A helper session started with `pitwall new` takes its parent's account, so a
helper never lands on an exhausted account its parent just left... unless the parent is itself on one; that is
accepted. A session resumed from the archive takes the active account.

The account is applied by writing `CLAUDE_CONFIG_DIR` into the session's `env.sh` / `env.json` (Default with no app
variable writes nothing, so today's behaviour is byte-for-byte unchanged for people who never add an account).
`claudeConfigDir` and `accountKey` take the session as well as the project; every caller is updated (history,
continue, usage, the status-line lookup, the manager's snapshot).

When a session runs on an added account, both launchers drop inherited `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and
`CLAUDE_CODE_OAUTH_TOKEN` before starting Claude, then re-apply the session's own variables, so one a project set on
purpose still stands. This is the same pattern the launchers already use for GitHub tokens. Sessions on Default are
left exactly as now.

### Shared and separate

When an added account's folder is created:

- **Linked to the Default folder** (symlinks; directory junctions on Windows): `projects`, `todos`, `plans`,
  `file-history`, `shell-snapshots`. This is what lets a conversation resume on another account, and keeps search and
  "Continue a conversation" seeing one history.
- **Linked too**: `settings.json`, `CLAUDE.md`, `commands`, `agents`, `skills`, `plugins`, `keybindings.json`, when
  they exist in Default. The aim is that an account differs only in who pays. (Orca copies settings; linking is chosen
  here so a later edit shows up everywhere. If a link target doesn't exist yet, it is skipped and looked for again
  the next time the account is used.)
- **Separate, never linked**: `.claude.json` (it holds the signed-in profile), `.credentials.json`, `sessions`,
  `statsig`, and anything not named above.
- **Copied from Default's `.claude.json`** (which is `~/.claude.json`, beside the folder, for the built-in default;
  inside the folder otherwise) into the new account's, after sign-in, and only these keys:
  - `mcpServers` (user-level MCP servers). Not kept in sync; the account's row offers "Copy MCP servers from Default"
    to do it again. OAuth sign-ins to MCP servers are per account and have to be repeated.
  - `hasCompletedOnboarding` and the other onboarding flags found in Check first, so a new account doesn't replay
    the first-run screens in every session.
- **Copied at each move**, from the account the session is leaving to the one it is joining: that session folder's
  entry under `projects` in `.claude.json` (folder trust, its allowed tools, its project-level MCP choices). Without
  it Claude would stop at the folder-trust prompt, which blocks before any hook fires. A new session on an added
  account still gets the trust prompt once, as every new worktree does today.
- Pitwall never copies `oauthAccount`, `userID` or anything else from `.claude.json`.

Pitwall writes nothing into the Default folder. It only creates links that point at it, and reads its
`.claude.json` (which it already reads for the email).

### Adding and removing an account

**Add account…** (under the meters) opens a dialog with a terminal running `claude auth login` with
`CLAUDE_CONFIG_DIR` set to the new folder. Claude opens the browser; the user signs in. When the command exits 0 and
the folder's `.claude.json` has an email, the account appears in the list. If it is the same account as an existing one (email and
organisation), the new folder is discarded and the user is told it's already there. Cancelling discards the folder. Adding does not
make the account active.

**Remove** (in an account's menu) is offered only when no session runs on it or is waiting to move to it. It runs
`claude auth logout` in that folder (so Claude removes its own Keychain entry), then deletes the folder. The links
inside are removed as links; Default's files are never followed.

**Sign in again** re-runs the login for an account whose login has lapsed.

### The switch

At the bottom of the right panel, where `UsageMeter` is now. Every account is always listed (today an account shows
only once it has reported usage), the active one first and marked:

```
 ● work@company.com              5h   ▓▓▓▓▓▓▓▓▓░ 96%  14:20
                                 Week ▓▓▓▓░░░░░░ 41%  Thu
 ○ me@gmail.com        [Switch]  5h   ▓░░░░░░░░░  8%  16:05
                                 Week ▓▓░░░░░░░░ 22%  Mon
 + Add account…
```

- An account with no usage reported yet shows "No usage yet" in place of its bars.
- An account reports only while a session runs on it, so an inactive account's numbers can be hours old. Each
  account whose last report is over 10 minutes old shows "updated 3h ago"; a window whose reset time has passed
  shows as empty.
- With only Default and nothing added, the panel looks as it does today plus the "Add account…" line.
- If the selected session runs on a different account from the active one, that account's row says "This session".
- **Switch** on a row makes it active at once. If any unpinned running session is on another account, a dialog
  follows: "Move 4 running sessions to me@gmail.com too?" with **Move sessions** / **New sessions only**. It lists how
  many will move now (idle) and how many when they finish (working or waiting on the user).
- A session's header menu has **Move to account ▸**, listing the other accounts, for moving one session.
- The limit banner in `SessionHeader` gains a **Switch to <other account>** button beside "Continue at …" when another
  account exists; it does the same as the row's Switch. With more than one other account, it names the one with the
  most room in its 5-hour window.

### Moving a session

1. Record the target on the session (`Session.moveTo`), so a pending move survives a restart of Pitwall.
2. Wait until it is idle: status `read` or `unread`. A session that is working, starting, or waiting on a permission
   or question moves when it next reaches idle. A session whose Claude has exited moves at once.
3. Set `Session.account`, clear `moveTo`, cancel any scheduled "continue", rewrite the session files, end the
   session's Claude terminal and start it again. The launcher resumes the same conversation id on the new account.
4. If the limit banner was showing, type `continue` once Claude is up, as the scheduled continue does today. The user
   clicked Switch to get going again, so this is not a surprise. A session moved for any other reason is left idle.
   "Up" means a `SessionStart` event has arrived since the relaunch; nothing is ever typed before it (a sign-in or
   trust prompt must never receive the text).

A pending move shows on the session ("Moves to me@gmail.com when it finishes") with a **Cancel**. Switching again
before it happens replaces the target; switching back to its current account cancels it.

Ending the terminal stops anything the session's Claude was running in the background (a background shell command, a
running subagent can't be, since the session is idle). The dialog says so in one line. The Shell and Server tabs are
separate terminals and are not touched; they pick up nothing from the Claude account.

**When the move doesn't take.** Today, when `--resume` exits non-zero before `SessionStart`, both launchers start a
fresh conversation themselves. For a moved session that is the anti-goal, so:

- The app writes a marker file in the session folder (`moved-from`, holding the previous account id) before the
  relaunch. While it exists, both launchers skip the fresh-conversation fallback: they log a `pitwall:move-failed`
  event and wait at "Press Enter to resume" as after any exit.
- **Success** is a `SessionStart` after the relaunch: the app deletes the marker.
- **`pitwall:move-failed`**: the app puts the session back on its previous account, deletes the marker, relaunches,
  and shows "Couldn't continue this conversation on me@gmail.com". If that relaunch fails too, nothing special
  happens: the launcher's normal behaviour and messages apply.
- **No `SessionStart` within 60 seconds and no failure** (Claude is sitting at a sign-in or trust prompt): nothing is
  reverted automatically. The session shows "Waiting on me@gmail.com: check the terminal" with a **Move back**
  button. The marker stays until `SessionStart` or Move back.
- **Resumed, but the new account refuses the first reply** (its own limit, a plan without the model): that is an
  ordinary error in an ordinary session. The limit banner and the Move menu are there; no revert.

### Usage and limits

`UsageTracker` already keys usage by account folder and each session's status line reports its own account's limits,
so a moved session starts reporting the new account from its first reply. The only changes: the session-to-account
mapping uses the session's account, and the list always includes every account. "Continue at …" reads the reset time
of the session's current account, as now.

### Platforms

macOS and Windows both. Windows uses `.credentials.json` per folder, junctions for linked folders and, for linked
files (`settings.json`, `CLAUDE.md`, `keybindings.json`), a copy made at creation, since file symlinks need
privileges there; the account's row offers "Copy settings from Default" to refresh them.

## Check first (before the plan's build steps)

These need a real Claude Code and a second signed-in account, so they are the plan's first task, done by hand with
the user in Pitwall Dev or a plain terminal. Each can change the design:

1. **Does a conversation started on one account resume on another** (different plan, possibly a different
   organisation) when `projects` is shared? If Claude refuses, moving falls back to starting a new conversation with
   a note pointing at the old transcript, and the "same conversation" goal is restated to the user before building.
2. **The oldest Claude Code version that keeps logins apart per config folder** on macOS. Below it, "Add account…" is
   disabled with the reason.
3. **Does `claude auth login` honour `CLAUDE_CONFIG_DIR`** and exit when sign-in completes, and does
   `claude auth logout` remove only that folder's login?
4. **Does Claude follow links** for each linked item (notably `plugins` and `settings.json`), and does it ever replace
   a linked file with a regular one when it saves?
5. **Two accounts running at once**: no login is wiped when both refresh (a reported race).
6. **Which keys in `.claude.json`** carry onboarding and folder trust, and whether copying them (as described under
   Shared and separate) is enough to skip those prompts.

If a check fails:

- 3 fails (`claude auth login` ignores the folder or never exits): the dialog runs plain `claude` in the new folder
  and the user types `/login`, then closes the dialog; the account is accepted when its `.claude.json` has an email.
  If logout isn't per folder, Remove only deletes the folder and says the login may remain in the Keychain.
- 4 fails for an item (not followed, or the link gets replaced on save): that item is copied at creation instead,
  on every platform, with the "Copy settings from Default" refresh, as on Windows.
- 5 fails (logins get wiped): stop and go back to the user. Side-by-side accounts is a goal; the alternative
  (moving always moves every session, one account live at a time) is a different product and theirs to choose.
- 6 fails: accept the prompts. The 60-second "Waiting on …: check the terminal" state covers them, and `continue`
  is already gated on `SessionStart`.

## Left to the builder

- Names of IPC channels, store fields beyond those named, and component structure.
- How the add-account terminal is hosted (the existing pty bridge, or a short-lived one).
- How "end the Claude terminal and start it again" is done per backend, provided both backends behave the same.
- Migration: none is needed for sessions (absent field means Default); settings gain two optional fields.
- Tests, following the existing suites (`tests/main/accounts.test.ts`, `launcher.test.ts`, `manager.test.ts`,
  `usage.test.ts`, `tests/host/launcher.test.ts`, the Windows suites, an e2e with a fake `claude`).
- The two known gaps in `docs/todo.md` under Accounts (`~` in the app's `CLAUDE_CONFIG_DIR`, symlinked spellings)
  matter more now; fix them as part of normalising account folders.

## Check first: results (2026-11-15, Claude Code 2.1.325, macOS)

Done by hand with two real accounts in different organisations: a Team seat (the default folder) and a personal Max
plan (a scratch folder), then signed out and removed again.

1. **Resume across accounts: works, both ways.** A conversation started on the Team account resumed on the Max
   account with `projects` linked, back on Team, and on Max again: same conversation id, full history each time.
   Across organisations Claude says once "Claude can't use thinking from another organization": the earlier
   thinking isn't deleted, but the next replies reread the conversation and may be slower and use more tokens.
2. **Logins are kept apart per folder at 2.1.325** (two Keychain entries, `Claude Code-credentials` and
   `Claude Code-credentials-<8 hex>`). The oldest version that does this was **not found**: Claude's changelog doesn't
   say. `MIN_CLAUDE_FOR_ACCOUNTS` stays a placeholder.
3. **`claude auth login` honours `CLAUDE_CONFIG_DIR`**, and `claude auth logout` there removed only that folder's
   login: the default account stayed signed in.
4. **Links are followed and survive.** `projects`, `file-history`, `shell-snapshots`, `skills`, `plugins` and
   `settings.json` were still links after four runs; the same 16 plugins were listed on both accounts. Not tried:
   changing a setting from inside Claude on the added account (whether a save replaces the `settings.json` link).
5. **Two accounts refreshing at once: not checked** (needs both idle for over an hour).
6. **First-run prompts.** A profile fresh from `claude auth login` opens on the first-run theme picker; with
   `hasCompletedOnboarding` and `lastOnboardingVersion` copied it reaches the folder-trust prompt; with the folder's
   `projects` entry (`hasTrustDialogAccepted`) it reaches a further one-time prompt ("Claude in Chrome extension
   detected"). With every "already seen" flag copied from the default profile it opens at its prompt. So a new
   account now takes those flags by shape (`isProfileKey` in `src/main/account-folders.ts`), not three named keys.
   User-level MCP servers are listed there but need signing in again, as designed.

### In the app itself (same day, an isolated dev build, real Claude Code, two real logins)

- Add account…, Switch, moving a session from its header and Move back all worked. The moved session opened at its
  prompt on the other account in about 2.5 seconds and answered from the conversation it had before the move.
- Found and fixed there: Claude keeps a worktree's folder trust under the **main repo's** folder, so the first move
  stopped at the trust prompt (the "Waiting on …" banner and Move back did their job); and a moved session's last
  usage report was counted for its new account.
- **A setting changed inside Claude on the added account (`/effort high`) is written through the `settings.json`
  link** to the default folder's file. The link stays a link. So settings really are shared, both ways.
- Not covered: the default folder was re-signed to the personal account part-way through (`/login` in a terminal),
  so from then on both folders held the same account. Two folders signed in to one account are listed as two rows
  with the same label.
- Token refresh with two folders in use at once: being watched (a session on each, prompted every 90 minutes).

