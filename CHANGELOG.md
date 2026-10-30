# Changelog

All notable changes to Pitwall are listed here, newest first. Pitwall shows these notes when an update is available, before you download it.

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
- **Update notifications.** Once a day Pitwall checks GitHub Releases and shows an "Update available" pill with these notes. Turn it off in Settings.
