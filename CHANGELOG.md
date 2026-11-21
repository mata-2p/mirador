# Changelog

All notable changes to Mirador, written for the people who run it. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- A file path in a terminal's output that names a file of its workspace (absolute, `./x`, `../x` or `a/b.ts`, with
  an optional `:line` or `:line:col`) is a link: a click opens the file in the file editor.

## [0.1.0] - 2026-11-20

The first public version: a local dashboard on `127.0.0.1` for your project folders, with agent terminals inside it.
Linux is supported, macOS is experimental, and Windows works through WSL2. Mirador sends no telemetry.

### Added

**Install and start**

- `install.sh` checks Node, pnpm and the build tools, prints how to install what is missing, sets Mirador up and runs
  the doctor. A one-line bootstrap clones Mirador and runs the installer.
- `pnpm run doctor` lists what the machine has or lacks; `pnpm run doctor --report` prints a bug-report block with
  no personal paths, user or host names.
- An example config and a quickstart that needs neither gentle-shell nor Engram.
- `bin/mirador` starts the server and opens an app window in a Chromium-family browser, or a tab in any other browser.
  It runs on macOS and inside WSL2, where the window opens in the Windows browser.
- The web UI is bundled with esbuild when the server starts, with the plain files as a fallback.

**Folders, workspaces and terminals**

- A folder tree with agent terminals in tabs or a grid, and a daily summary panel.
- Named workspaces that group the folders you choose, each with an editable mission.
- Terminals grouped by workspace, reordered by drag and drop, with the agent's icon in each tab.
- A git terminal that runs lazygit in a floating panel.
- A file editor for a folder's text files, dotenv files first, that asks before overwriting an agent's change; it can
  create `.env` from `.env.example`.
- The interface in English and Spanish.

**Agents**

- Choose which agent opens in a folder: gentle-shell, pi, Claude Code, opencode, Antigravity, Codex, Gemini CLI, Kimi
  or a plain `bash`.
- Claude Code, opencode and Antigravity report when they work, wait for you or finish, through per-launch hooks that
  never edit the agent's own config.
- Open agents come back after Mirador restarts or the machine reboots. gentle-shell, pi, Claude Code, opencode
  and Antigravity resume their session; Codex, Gemini CLI and Kimi only return to their folder.
- Open one agent in several folders at once.

**Memory and resources**

- One systemd scope per agent on Linux, so an out-of-memory kill takes one terminal, not all of them.
  Mirador sets no per-agent memory limit.
- A launch gate: agents opened together start in batches and wait while free memory is low, with a progress bar and
  a Pause button.
- After a restart, agents that had finished their turn sleep with no process until you wake them.
- Agents idle for 4 hours save their session and go to sleep; `idleSleepHours` changes the delay, `0` turns it off.
- Choose the MCP servers of each project folder, which saves memory in every agent opened there.
- RAM and CPU per agent and the machine's free memory.

**Attention and memory views**

- An attention inbox with the agents that wait for your answer or finished their turn.
- Where each folder left off and a workspace summary, read from Engram, shown in three levels with
  folded sections.
- A tracking view of agents in lanes by what they need from you.
- The memory panel follows the active tab or grid pane.
- A read-only Engram memory health card.

**Modes and look**

- Two modes: gentle-deck, with memory, the night shift and Pi MCP, and plain, for any setup without gentle-shell or
  Engram; `auto` picks one.
- The gentle-deck theme with three themes, SVG icons, a settings sheet and a layout for narrow windows.
- A filter by agent state, a help guide opened with `?`, and credits.

**Night shift and autopilot**

- An autopilot that answers agent questions with the option it recommends, guided by the workspace mission, and leaves
  sensitive actions for you.
- It continues after a question in an agent's final message and limits how many agents work at once.
- A judge that reviews its moves and learns from your Right/Wrong feedback, with desktop notifications and an optional
  Telegram bot of your own.
- A schedule, a bedtime reminder and notes you leave for each agent.
- Answer held questions and pi's select and confirm dialogs from Telegram.
- Resource profiles (Ahorro, Equilibrado, Potencia) and a nightly budget of Claude calls. Each call is logged
  on your machine without its text; nothing is sent anywhere.
- Delegate an instruction to Mirador from a folder or a selection, with proposals drawn from each project's
  next steps and an optional **Mejorar con IA** rewrite.

**Project**

- The Apache-2.0 licence and a public README with screenshots, diagrams and a demo.
- CONTRIBUTING.md, SECURITY.md, sponsoring links and a CI workflow on Ubuntu and macOS.

### Changed

- The interface opens in Spanish by default.
- The night shift became one autopilot you can also switch on by hand.
- Telegram keeps only decisions and the morning summary.
- Memory translation moved to the browser's own translator, with each memory marked with its language, instead of a
  Claude call.
- The launch link lives 60 seconds instead of 10, because a browser in WSL2 can take that long to open.
- The interface, the window title and the doctor say Mirador in every mode; the doctor calls the gentle-shell mode
  "full mode" and prints `Mode: full`. The `mode: gentle-deck` config value is unchanged.

### Fixed

- `mirador stop` left agents running, so the next start ran each project twice; a terminal killed for lack of memory
  showed "exit 0" instead of its signal.
- A folder opened by hand during a paused restore ran twice at the next start.
- Sessions in use were dropped when new ones passed the cap.
- The launch link is redeemed as soon as the page opens, and Edge opens on WSL2.
- Clearer installer hints for WSL drives, apt and Node through mise.
- The terminal replay keeps pi's screen modes and the pty size.
- Fixes from the workspaces review: shutdown hooks, open dialogs, deleted folders, slow Engram tags and the panel view.
- Keyboard access to terminal tabs and the tree, themed dialogs and ARIA gaps.
- Where it left off shows the whole goal, nested lists and task marks.
- Sidebar names stay visible, row icons keep their size and the agent menu opens in place.
- Hand-edited workspaces and symlinked configs stay intact on save.
- A clear error when the server cannot start.

### Security

- The server listens on `127.0.0.1` only and checks a session token, the `Host` header and the app's own `Origin` on
  every change.
- The launch link works once, expires after 60 seconds and stays out of error output.
- Folders and files resolve, after symlinks, inside the workspace root.
- Temporary files are created owner-only, and the ones a crash left are swept.
- The attention bridge bounds what an agent can report.
- The autopilot never decides sensitive actions, and a delegated task cannot widen that guard.
- The Telegram bot token lives in a file only you can read and is never shown or logged; credential shapes
  are hidden in Telegram messages.
- CI scans the git history for secrets with gitleaks.
- No telemetry and no accounts.

[0.1.0]: https://github.com/mata-2p/mirador/releases/tag/v0.1.0
