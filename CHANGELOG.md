# Changelog

All notable changes to Mirador, written for the people who run it. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- **Olvidar / Forget** on a sleeping agent now leaves every open window, not only the one that pressed it:
  the inbox stream carries the number of sleeping agents, and a window re-reads the list when it changes.

- On Linux x64 and arm64 with glibc 2.28 or newer, the one-line install (`curl … bootstrap.sh | sh`) installs the
  prebuilt release of 0.2.0 instead of building Mirador from source: it needs no git, Node, pnpm or compiler, and
  it checks the archive against the sha256 written in `scripts/bootstrap.sh` before unpacking it. When
  `~/.local/share/mirador` is already a git clone from an earlier one-line install, running the line again leaves the
  clone as it is, stops and says how to keep updating it from source or move it away to switch to the prebuilt
  release. macOS, other systems and glibc older than 2.28 keep installing from source.

## [0.2.0] - 2026-11-26

0.2.0 adds the phone inbox, as an experimental feature, `mirador link` and signing out the other windows, clearer
browser notifications, **Dónde quedó / Where it left off** without Engram for Claude Code, file links in terminal
output and a sidebar tree that follows the terminal. It also lays the groundwork for installing on Linux without
compiling: prebuilt archives, which `scripts/bootstrap.sh` does not pin yet; a later change pins a release in it.
It was rehearsed as the pre-releases [0.2.0-rc.1] and [0.2.0-rc.2], and everything they shipped is in this section.

### Added

- On a phone (under 600 px wide), Mirador opens on the **Te esperan / Waiting for you** inbox, full screen, as an
  experimental feature: it was tested on one iPhone, and
  [The phone inbox is experimental](docs/attention.md#the-phone-inbox-is-experimental) gives what was measured, how
  to get out of **Reconectando… / Reconnecting…** and the limits of finger scrolling. The inbox covers the whole
  screen, also when Seguimiento was on screen. It has a header that stays on top with the count and **En vivo /
  Live** or **Reconectando… / Reconnecting…**, cards that read the reason first, and 44 px touch targets on a touch
  screen. The header never says **En vivo / Live** over a dead connection: after 60 s with no line from the server
  (it sends one every 25 s) it shows **Reconectando… / Reconnecting…** and the stream reconnects, and a tab that
  comes back after 60 s or more hidden reconnects at once (#66). See
  [Opening Mirador from another machine](docs/security.md#opening-mirador-from-another-machine) for the `ssh -L`
  tunnel (#41, #67).
- On a phone, a card opens its terminal full screen, also over Seguimiento, with a key bar (Esc, Tab, the arrows,
  Enter). The key bar and the header follow the terminal on screen: another terminal activated while the view is
  open takes the keys, and closing the terminal on screen goes back to the inbox instead of typing into another one
  (#65). A finger dragged over the terminal does what the mouse wheel does on a desktop, and the page does not move.
  In programs that do not track the mouse, such as Claude Code or a shell, it scrolls the history, and typing or a
  key-bar key goes back to the end. Programs that track the mouse, such as gentle-shell or fzf --height, get the
  drag as the mouse wheel. Full-screen programs that do not track it, such as vim or less, get nothing from the
  drag (#87). A tap opens the keyboard and links. In the full interface a finger still moves the page, and in this
  view pinch-zoom does not work over the terminal, which uses a 12 px font (#41, #67, #89).
- `mirador link` prints a fresh one-time link for a phone or another machine, without trying to open a window (#41).
- **Cerrar sesión en las demás ventanas / Sign out the other windows** under **Ajustes / Settings** signs out every
  other window and closes its terminals, for a lost phone (#41).
- Browser notifications say who waits: Mirador's icon, the project and reason as the title ("mi-proyecto · Needs
  you to choose"), and the question, agent and path in the body (a blocked agent shows only its project and reason,
  never a command, unless it asks a questionnaire or a choice). A blocker or a dialog stays on screen until you act,
  unless you turn off **Los avisos que piden respuesta se quedan hasta que actúes / Notices that need an answer stay
  until you act**; a notification may arrive up to 1.5 s after its card, and 3 or more new cards within 1.5 s share
  one notification, whose click opens the inbox; and **Discretos / Discreet** mode, off by default, hides the
  project, question and path for screen sharing. See [Attention inbox](docs/attention.md#attention-inbox) (#76).
- Clicking a terminal's tab, or a grid tile that makes another terminal active, opens its workspace and folders down
  to its project in the sidebar tree and collapses the rest, without changing the layout Mirador saves. It is on by
  default; turn it off with **El árbol sigue a la terminal / Tree follows the terminal** under **Ajustes /
  Settings**.
- A file path in a terminal's output that names a file of its workspace (absolute, `./x`, `../x` or `a/b.ts`, with
  an optional `:line` or `:line:col`) is a link: a click opens the file in the file editor. Only files the editor
  opens are links: not a symlink whose target leaves the workspace, nor a file over 1 MiB.
- **Dónde quedó / Where it left off** works without Engram for Claude Code. Mirador keeps a local record per folder
  of your last message, Claude's final message and its latest compaction summary, as Claude Code's hooks hand them
  over (`prompt`, `last_assistant_message`, `compact_summary`), each cut to 16 KiB. The view shows the newer of this
  record's text and Engram's latest session summary (a tie, or a record with only your prompt, keeps Engram's), with
  your last message above it, and its foot names the source; plain mode shows the record above the git state. The
  hook sends the text over Mirador's local socket and the server validates and writes it
  (`~/.local/state/mirador/left-off/`, files 0600). It is plaintext on disk, never sent anywhere and never logged.
  Records are removed after 30 days, or after the days set in the new config key `leftOffDays`; `leftOff: false`
  turns the capture off. Mirador does not read Claude Code's configuration.
- **Dónde quedó / Where it left off** shows the newer of Claude's final message and its compaction summary, not
  always the final message; a block from the local record has **Olvidar / Forget**, which removes that record after
  a confirmation, as forgetting the folder's sleeping Claude Code agent (chosen as Claude Code or started as the
  configured `agentCommand`) or removing the workspace now does too; the record also keeps when and why the session
  ended (`SessionEnd`, stored only); and the workspace **Resumen / Summary** rows use the record the same way as the
  folder view, answering from it when Engram is down, under a notice that Engram is not responding.
- The groundwork for installing on Linux without compiling. A release workflow builds a prebuilt archive for
  Linux x64 and arm64 (the official Node 24, checked against a sha256 pinned per architecture in the workflow,
  Mirador's TypeScript sources as they are, and production `node_modules` with `node-pty` built for glibc 2.28),
  checks every archive in clean AlmaLinux 8 (glibc 2.28) and Debian 13 containers in a `smoke` job (doctor, server
  start, size and timings in the job summary), and only then, with `SHA256SUMS` and a build-provenance
  attestation, attaches them to a draft release that a maintainer reviews and publishes. `scripts/bootstrap.sh`
  installs such a release once one is pinned in it, checking the archive against the sha256 written in the script;
  until then, and on macOS, it installs from source as before. It never overwrites or deletes a git clone in
  `~/.local/share/mirador`, and it checks for no updates. A first prebuilt install cut off abruptly does not block
  the next run, which removes the half-done `.download.*` folders it left and goes on; an update says when a
  running server keeps the previous version until `mirador stop && mirador`. `bin/mirador` runs the Node bundled
  in a prebuilt release before any other.

### Changed

- The foot of **Dónde quedó / Where it left off** names Engram when the summary comes from it ("Engram session
  summary · …").

### Fixed

- A terminal closed in another window now leaves every open window: its tab goes away, and a phone that shows it
  goes back to the inbox. The same happens when an agent goes to sleep, and then a short line says so for a few
  seconds, with Despertar (Wake) to open it again; on the phone it shows above the inbox. Before, the tab stayed on
  a dead terminal until a reload (#65).
- Coming back to the tab after 60 s or more hidden while the inbox waits to reconnect now reconnects at once, as
  described in [Attention and tracking](docs/attention.md), instead of waiting out the backoff of up to 30 s; a
  shorter hide keeps the wait (#66).
- A terminal opened in another window after this page loaded now joins it as a tab: when the inbox names it, or
  when the page shows again. Before, its card said **abierta en otra ventana de Mirador / open in another Mirador
  window** and a tap did nothing until a reload; now the tap opens it (#67).
- A terminal used from a narrower window, such as a phone, no longer stays at that width on the desktop when the
  desktop window never lost the focus: typing or clicking in that terminal on the desktop gives it back the
  desktop's width, at most once a second (#67).

### Documentation

- The README says what Mirador focuses on, rather than what other agent dashboards do not do.
- The README has a **How Mirador compares** table (form, platforms, license, worktrees, remote and phone) for
  Herdr, Paradev, Claude Code Desktop, cmux and Emdash, from each project's own site or repository.
- The README's table of what Mirador does adds the **Cambios / Changes** view, browser notifications and the night
  shift, each linked to its description in `docs/`.
- The README says that what stays on the machine is Mirador itself, not the agents running inside it, names what
  the full mode's night shift and **Mejorar con IA** send to Claude, and says that `bin/herdr-shim` is a
  gentle-shell compatibility layer with no relation to the Herdr product.
- `docs/security.md` explains how to open Mirador from another machine through an `ssh -L` tunnel, and its risks.
  The server still listens on `127.0.0.1` only.
- `docs/attention.md` shows a browser notification and its **Discretos / Discreet** form, from the demo workspace
  (#76), and its section [The phone inbox is experimental](docs/attention.md#the-phone-inbox-is-experimental) gives
  what was measured on one iPhone, how to get out of **Reconectando… / Reconnecting…** and the limits of finger
  scrolling.
- `docs/releasing.md` tells maintainers how to cut a release or a release candidate, review its draft and pin it
  in `scripts/bootstrap.sh`.

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

[Unreleased]: https://github.com/mata-2p/mirador/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/mata-2p/mirador/releases/tag/v0.2.0
[0.2.0-rc.2]: https://github.com/mata-2p/mirador/releases/tag/v0.2.0-rc.2
[0.2.0-rc.1]: https://github.com/mata-2p/mirador/releases/tag/v0.2.0-rc.1
[0.1.0]: https://github.com/mata-2p/mirador/releases/tag/v0.1.0
