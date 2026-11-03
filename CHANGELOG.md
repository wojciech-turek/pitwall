# Changelog

All notable changes to Pitwall are listed here, newest first. Pitwall shows these notes when an update is available, before you download it.

## [0.3.3] - 2026-11-03

### Changed

- **Folders and sessions are easier to tell apart in the sidebar.** Each folder has a folder icon, and its sessions hang off a thin line beneath it, so an idle session no longer looks like another folder.

## [0.3.2] - 2026-11-02

### Fixed

- **No black strip under the terminal's last line.** 0.3.1's fix for the clipped last line left a thin black bar below it; it's the terminal's own colour now.
- **Windows: a teardown command that runs too long is reported as stopped only once it is.** Before, the archive dialog could say so a few seconds early, while the command was still being stopped.

## [0.3.1] - 2026-11-01

### Added

- **Continue a conversation**, from the clock button on a folder's row. It lists the folder's archived sessions and the Claude conversations you ran there outside Pitwall (with plain `claude`), newest first, and searches their titles and text. Picking an outside conversation continues it in a new session on a branch of its own, starting from the branch it was on (or main), and Claude remembers everything said. Continuing a conversation from outside Pitwall needs Claude Code 2.1.257 or newer. Changes you haven't committed in the folder stay there. If the conversation was used in the last few minutes, Pitwall asks first, since it may still be open in a terminal. Pitwall only reads Claude's conversation files, never changes them.
- **The version in the title bar**, small and dim after the name, so you can always see which Pitwall you're on.

### Fixed

- **The terminal's last line is never cut off at the bottom.** At some window sizes the terminal fitted one row too many, and Claude's bottom line was clipped.

## [0.3.0] - 2026-10-31

### Added

- **Windows (beta).** Pitwall runs on Windows 10 (version 1809 or later) and Windows 11, on x64 and ARM, with the same projects, worktrees, identities and live status as on a Mac. Download `Pitwall-0.3.0-x64-setup.exe`, or `Pitwall-0.3.0-arm64-setup.exe` for Windows on ARM. The installer isn't signed yet, so SmartScreen asks once per version: click **More info**, then **Run anyway**. It installs for your user only, with no administrator rights.
- **Agents keep running on Windows too.** Windows has no tmux, so a small background process of Pitwall's own, the host, keeps the agents' terminals running while the app is closed, and Pitwall reattaches when you reopen it.
- **Made for Windows:** Ctrl shortcuts (in a terminal, `Ctrl+Shift+K` and so on, so a plain `Ctrl+K` still reaches the program there), Windows notifications, a count on the taskbar button that flashes when a session needs you, and a PowerShell Shell tab.

### Windows notes

- Updating Pitwall on Windows stops running agents: the installer (and the uninstaller) asks first, then closes Pitwall and its background host, also when the host is all that's left running after you quit. Each agent resumes its conversation when you reopen Pitwall.
- Status hooks run in Windows PowerShell, about half a second each, so tool calls feel a little slower than on a Mac.
- If PowerShell scripts can't run (a Group Policy that blocks them, say), Claude still works, but the session's status doesn't update, and its header says so and why.
- Teardown commands run in `cmd.exe`.
- The README's **Windows (beta)** section has the requirements (Claude Code, Git for Windows), where things live and the known limitations.

### Changed

- **Archiving retries when a file is briefly in use** (a virus scan, the indexer, an editor) on every platform, and, if git has already let go of the worktree but a file in it stays in use, it finishes and tells you which folder to delete later.
- **Archiving a folder's last session removes its now-empty folder** in `~/pitwall/worktrees` (only when nothing else is in it).

## [0.2.0] - 2026-10-30

### Added

- **Command palette (⌘K).** Type to jump to any session, file, past session or action. **⌘Enter** opens a session split to the right, and **⌘P** opens a file in the current session.
- **Search and resume past sessions.** Find sessions by title or by anything said in their Claude conversation, archived ones included. **Resume** brings an archived session back in its folder and continues the same conversation: on its branch if it still exists (or from its pushed copy), otherwise on a new branch from main.
- **Mute a project** from its ⋯ menu: no notifications and no Dock badge from its sessions, while the sidebar still shows their status.
- **Mark as unread** from a session's ⋯ menu, so it waits for you like a fresh reply.
- **Teardown command** per folder, next to the setup command, for example `docker compose down`. It runs when you archive a session, before the worktree is deleted. If it fails, you can cancel or archive anyway.
- **Archiving cleans up after the agent.** Processes a session left running, such as a dev server started in the background, are stopped when you archive it.

### Fixed

- Quitting right after a terminal opened could leave Pitwall unable to finish quitting.
- A GitHub token set in your shell environment (`GITHUB_TOKEN`, `GH_TOKEN`) could stand in for a project's own GitHub account. Now only the project's account is used, and `gh` runs signed out if its token can't be found.

## [0.1.0] - 2026-10-30

First public release.

### Added

- **Projects, folders and sessions.** A project groups the folders and repos that share one git identity. Any local folder works, with or without GitHub.
- **One identity per project.** SSH key, GitHub account, and commit name and email are applied to every git and `gh` command in that project's sessions. Pitwall never touches your global git or SSH config.
- **Real Claude Code in a real terminal**, plus a Shell tab per session with the same folder and identity.
- **Live status** for every session: Working, Needs you, Unread or Read. Title bar counts, macOS notifications, a Dock badge, and **⌘J** to jump to the next session that needs you.
- **A git worktree and branch per session**, started from your main branch. Archiving warns about uncommitted or unpushed work first.
- **Agents survive quitting the app.** Sessions run in tmux on Pitwall's own socket and reattach when you reopen it.
- **Split view** with up to 4 panes, saved across restarts.
- **Files and changes.** Browse and edit files, review split or unified diffs against the base branch, and **Send to agent** with one click.
- **PR badges** with checks status, and an offer to archive a session when its PR is merged.
- **Claude usage meter** for your 5-hour and weekly limits.
- **Setup command per folder**, and **Open in Cursor**.
- **Update notifications.** About once a day Pitwall checks GitHub Releases and shows an "Update available" pill with these notes. Turn it off in Settings.
