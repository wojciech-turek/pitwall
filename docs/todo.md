# To do

These are small things found while reviewing the November 2026 features (parking, review to agent, the Server tab,
subagents, the `pitwall` command, the resource view, accounts, and running without tmux). None blocks a release.

## Small bugs worth fixing first

- **Review comments added while a send is in progress are lost.** `ChangesTab` clears every comment for the session
  after `sendToAgent` returns. It should remove only the ones it sent.
- **`pitwall wait` output can be cut short when piped.** `src/cli/index.ts` calls `process.exit()` straight after
  writing, and replies can now be up to 64 KB. Set `process.exitCode` and let the process end instead.
- **A paste that fails after "sent" was logged leaves the session showing Working** until its next event. This
  affects `pitwall send` and continue-at. On failure, log an event that undoes it.
- **`initial-prompt.txt` is written with default permissions.** Make it 0600, like `env.sh`.
- **Split diff:** a selection made earlier on the new side keeps "Comment" enabled while you select on the old side.
- **Collapsed subagent rows still re-render every second.** Gate the timer on "open and something running".
- **`pitwall send <id> "… --json …"` swallows a literal `--json`** in the message text.
- **The CLI does nothing if `VITEST` is set** in the environment. Use a direct-run check instead.
- **`sendPrFeedback` doesn't re-check that the PR is still open** before pasting.
- **Clean up worktrees:** if deleting a merged branch fails, the toast still says "Removed N" without mentioning the
  branch.
- **Continue at reset:**
  - The timer is armed before the store update.
  - Archiving doesn't cancel the timer. This is harmless, but untidy.
  - The "limit" text match could also catch "context limit reached".
- **The Server tab's "▸ command" line** goes through `echo`, which turns backslashes into escapes. Use `printf '%s'`.
- **`.worktreeinclude`:**
  - A `**` pattern scans everything before the 200-file cap applies.
  - A directory line such as `secrets/` copies nothing and says nothing.
- **A PR with a URL Pitwall can't parse** keeps its old open-thread count instead of clearing it.

## Robustness

- **The CLI socket:**
  - If `chmod` fails after `listen`, the server keeps listening.
  - There's a short window between `listen` and `chmod`. Creating the socket in a 0700 folder would close it.
  - `stop()` should key on "listen succeeded", not on "server created".
- **SystemMonitor:** `start()` after `stop()` lets a sample that was already in flight publish. Use a generation
  counter.
- **Accounts:**
  - A `CLAUDE_CONFIG_DIR` in the app's own environment that starts with `~` isn't expanded.
  - Symlinked spellings of one folder count as two accounts.
- **Sidebar:**
  - The hover card can say "Started by" a parent that has been archived.
  - In the warning popover, a session that has since been removed can't be selected.
- **Accessibility:** subagent rows can't be reached with the keyboard.
- **Theme:** the Server tab's bar and dot use a hard-coded green instead of theme tokens.

## Check with real Claude Code

- Does the permission `Notification` for a subagent's prompt carry `agent_id`? This decides whether a session always
  returns from Needs you.
- What's on screen when a subscription limit is hit: plain text, or a menu? Typing `continue` plus Enter must not
  pick a menu item.
- Find the oldest Claude Code version that accepts `--append-system-prompt-file` in interactive mode. Every session
  now passes it.
- When does `SessionStart` arrive relative to the folder-trust prompt and a first prompt's `UserPromptSubmit`?

## Tests to add

- **Parking:** font change and two views of one terminal, at component level.
- **Review:** the line maths (column-0 end, the 3-line and 160-character quote cap), and the `sendPrFeedback` handler's
  branches.
- **PRs:** muted "new review comments", the 10-entry failing cap, a closed PR dropping its thread count.
- **Ports:** a start that fails after a port is allocated leaves no session behind.
- **`.worktreeinclude`:** the 200-file and total-size limits, file mode, a copy error rolling back, the resume path.
- **Server tab:**
  - a process under `-srv` is stopped on archive;
  - Windows refuses the tab;
  - the watcher with several sessions.
- **Subagents:** `snapshot()` copies runs; an `aid: null` event; an unknown run id.
- **The `pitwall` command:**
  - array and null request bodies;
  - non-string fields;
  - the `timeoutSec` clamp;
  - a socket error during `wait`;
  - the wrapper's exit 2;
  - the built CLI imports no chunks.
- **Clean up worktrees:** symlinked or trailing-slash spellings of a live session's path.
- **Accounts:** the multi-account meter at component level; `SessionView.account` and its cache.
- **No tmux:** `createBackend` when the record write fails, and tmux with no path.
- **Windows:** split `cli-server.test.ts` so its socket-free tests (token, key, socket path) run on Windows too.

## Tidy-ups

- Remove the duplicates:
  - `prefixLines` in `review-text.ts`
  - the `statusCheckRollup` check in `pr.ts`
  - the shown-tabs assembly in `PaneLayout` and `MainArea`
  - the third copy of the gh-token block in `pitwall-server`
- `configureParking` only runs because `TitleBar` uses `useAppInfo()`. Call it from `main.tsx`.
- Dead or unused code:
  - the trailing-slash strip in `accounts.ts`
  - `deps.now` in the CLI server
  - `_gone` in `state/review.ts`
- The `defaultAccount` computation in `index.ts` should call `accountKey`, so the two can't drift apart.
- The comment in `parking-bench.spec.ts` says it repaints about 20 times a second. The real rate is lower.

## Ideas, not decided

- A cap on how many helper sessions one agent can start.
- PR comment text from anyone is pasted into Claude. It's never sent without Enter, but it's still untrusted input.
- Fold the Server tab watcher's sampling into SystemMonitor's: one `ps` and one tmux listing per tick.

## Known flaky test

`tests/main/continue.test.ts`, "refuses an id…", sometimes fails under heavy load. It compares the stub Claude's log
before and after, and a stub started earlier in the test can write late. It passes when run alone.
