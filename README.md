<img src="public/icon.svg" width="64" height="64" alt="Mirador logo: a window split into two panes, with a terminal prompt in the left one">

# Mirador

Mirador is a local web dashboard for running many coding agents on one Linux or WSL2 machine without filling its memory. When you open several agents at once, it starts them in batches and waits for free memory, leaves finished ones asleep after a restart, and shows where each project left off.

- **Memory:** a launch gate for agents opened in a row; agents that can resume their session go to sleep after 4 h finished (configurable in [Settings](docs/resources.md#idle-sleep), in minutes), and after a restart every finished agent stays asleep; on Linux, one systemd scope per agent.
- **Where it left off:** each project shows where its last session stopped.
- **Stays on the machine:** no telemetry, no accounts, the server listens on 127.0.0.1 only.

[![test](https://github.com/mata-2p/mirador/actions/workflows/test.yml/badge.svg)](https://github.com/mata-2p/mirador/actions/workflows/test.yml) [![GitHub Sponsors](https://img.shields.io/github/sponsors/mata-2p)](https://github.com/sponsors/mata-2p) [![Ko-fi](https://img.shields.io/badge/Ko--fi-support-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/matiasjbarriah) [![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

English · [Español](README.es.md)

[Why Mirador](#why-mirador) · [Quickstart](#quickstart) · [What it does](#what-it-does) · [Each agent](#what-mirador-does-with-each-agent) · [How Mirador compares](#how-mirador-compares) · [How it works](#how-it-works) · [Configuration](#configuration) · [Development](#development) · [Install guide](docs/install.md)

![A short tour of Mirador in an invented demo workspace with the projects acme-api, acme-web and field-notes](docs/img/demo.gif)

## Why Mirador

What Mirador focuses on:

- **Memory.** Before the launch gate, opening 11 agents at once filled 24 GB of RAM and the swap, and systemd-oomd killed agents and the Mirador window. Now a [launch gate](docs/agents.md#opening-many-agents-without-filling-the-memory) holds agents opened in a row while MemAvailable is under the reserve. Agents that can resume their session go to sleep after 4 h finished (configurable in [Settings](docs/resources.md#idle-sleep), in minutes), and after a restart every finished agent stays asleep; on Linux each agent gets [one systemd scope](docs/agents.md#one-systemd-scope-per-terminal), so an out-of-memory kill takes one agent.
- **Where it left off.** Each project shows where its last session stopped, from Engram or Claude Code's last messages ([details](docs/attention.md#where-it-left-off)); a [tracking view](docs/attention.md#tracking-view) follows the day.
- **For gentle-shell users.** A [night shift](docs/extending.md#night-shift) whose autopilot answers agents' questions while you are away, and [MCP servers per project](docs/agents.md#mcp-servers-per-project) to turn off the ones a folder does not need.

The tracking view, then the attention inbox and a folder's **Where it left off** panel, in the demo workspace; each opens at full size:

<p><a href="docs/img/tracking.png"><img src="docs/img/tracking.png" alt="The tracking view in the demo workspace, with agents in lanes by what they need from you"></a></p>

<p><a href="docs/img/inbox.png"><img src="docs/img/inbox.png" width="600" alt="The Waiting for you list of the attention inbox in the demo workspace"></a> <a href="docs/img/left-off.png"><img src="docs/img/left-off.png" width="210" alt="The Where it left off panel of a demo folder: its last worked day and the next steps of its latest session"></a></p>

Mirador is an independent project, not an official part of gentle-shell; it builds on [gentle-shell](https://github.com/Gentleman-Programming/gentle-shell), pi and Engram, and thanks that community.

## Quickstart

This path needs neither gentle-shell nor Engram: each folder opens a plain `bash`, and the Gentle extras stay hidden.

On Linux x64 and arm64 with glibc 2.28 or newer, one line installs the prebuilt release, with nothing to compile; on other systems it installs from source. Read [the script](scripts/bootstrap.sh) before running it:

```sh
curl -fsSL https://raw.githubusercontent.com/mata-2p/mirador/main/scripts/bootstrap.sh | sh
```

**Starting it.** After the one-line install of the prebuilt release, `bin/mirador` is `~/.local/share/mirador/current/bin/mirador`; after the one-line install from source it is `~/.local/share/mirador/bin/mirador`. On Linux the installer also links `~/.local/bin/mirador`, so `mirador` works from any folder once `~/.local/bin` is on `PATH` (the installer warns when it is not). `bin/mirador stop` stops it.

**The workspace folder.** Mirador shows the folders inside the `root` of each workspace. On the first start, with no config file yet, it shows one workspace, Dev, on `~/Dev`, or on your home folder when `~/Dev` does not exist. To add another, click **Add** next to **Workspaces** in the sidebar; in **Add a workspace**, type the **Folder** (the full path of an existing folder; `~` means your home folder) and, if you like, a **Name (optional)**, then click **Add workspace**. Mirador writes the workspaces to `~/.config/mirador/config.json` the first time you change one from the app. The install from source writes that file when it installs: [The workspace folder](docs/install.md#the-workspace-folder).

**Language.** The interface follows the browser's language (Spanish for `es-*`, English otherwise) until you choose one in **Settings** (the sliders button at the top right) → **Language**, with **EN** or **ES**.

Everything else, from the requirements and the install from source to macOS, WSL2, the manual steps, the modes and the doctor report, is in [docs/install.md](docs/install.md).

## What it does

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/overview-dark.png">
  <img src="docs/img/overview.png" alt="Mirador in an invented demo workspace: the folder tree on the left, three agent terminals in the middle and the side panel on the right showing where the project left off">
</picture>

A local dashboard for your project folders, with agent terminals inside it. Each row links to the full description in `docs/`.

| Capability | In one sentence |
|------------|-----------------|
| [Where it left off](docs/attention.md#where-it-left-off) | **Where it left off** shows each folder's last worked day and the next steps of its latest session summary, read from Engram, or Claude Code's last message and yours when that is newer, kept locally for 30 days (`leftOffDays`). |
| [Tracking view](docs/attention.md#tracking-view) | **Tracking** swaps the layout for a read-only overview of agents in lanes by what they need from you. |
| [Attention inbox](docs/attention.md#attention-inbox) | **Waiting for you (N)** lists the agent terminals that need your answer or finished their turn. |
| [One systemd scope per terminal](docs/agents.md#one-systemd-scope-per-terminal) | On Linux each terminal runs in its own systemd user scope, so an out-of-memory kill takes one terminal, not all of them. |
| [Launch gate for memory](docs/agents.md#opening-many-agents-without-filling-the-memory) | Agents opened in a row start in batches and wait while free memory is under the reserve. |
| [Sleeping agents](docs/agents.md#sleeping-agents-lazy-restore) | After a restart, every agent that had finished its turn sleeps with no process until you wake it; while Mirador runs, a Pi, Claude Code, opencode or Antigravity agent finished for 4 h (set in Settings, in minutes) sleeps too, once it has recorded a session to resume; Pi saves its session summary first ([idle sleep](docs/resources.md#idle-sleep)). |
| [Reopening after a restart](docs/agents.md#reopening-agents-after-a-restart) | Open agents come back at the next start, in their folder and, with gentle-shell, pi, Claude Code, opencode or Antigravity, in their session. |
| [Opening several agents](docs/agents.md#opening-several-agents) | Mark folders in selection mode, or save them as the workspace's projects, and open one agent in each. |
| [MCP servers per project](docs/agents.md#mcp-servers-per-project) | Turn off the MCP servers a folder does not need, which saves memory in every agent opened there. |
| [Browser window](docs/configuration.md#browser) | A Chromium-family browser opens Mirador as an app window, with no GPU, Vulkan or desktop session needed; any other browser gets a tab, the `browser` key overrides the choice, and inside WSL2 it opens in the Windows browser. |
| [Changes](docs/features.md#what-it-does) | **Changes** shows a folder's or workspace's changes against its last commit, staged and unstaged together, with each file's diff coloured by line; it only reads the repository. |
| [Browser notifications](docs/attention.md#attention-inbox) | Off until you click **Turn on browser notifications** in the inbox; then an agent that starts waiting for you or stops with an error shows one browser notification, with Mirador's icon, the project and reason as its title and the question, agent and path in its body (it may arrive up to 1.5 s after the card, and 3 or more within 1.5 s share one notification; a discreet mode hides the details), and finished turns never do. |
| [Night shift](docs/extending.md#night-shift) | In the full mode, the **Autopilot** answers agents' questions while you are away, on a schedule or switched on by hand, leaves sensitive actions for you and reports each move in the tracking view. |
| [File editor](docs/features.md#file-editor) | **Files** edits a folder's text files, dotenv files first, and asks before overwriting an agent's change. |
| [Security](docs/security.md#security) | No telemetry and no account; the server listens on `127.0.0.1` only and checks a session token, the `Host` header and, on every change, the app's own `Origin` ([what stays on the machine](docs/security.md#what-stays-on-the-machine)). |

To open Mirador from another machine, forward its port with `ssh -L` after reading the risks: [Opening Mirador from another machine](docs/security.md#opening-mirador-from-another-machine).

Workspaces, the folder tree, terminals as tabs or a grid, the daily summary, the night shift's settings and resource profiles are in [docs/features.md](docs/features.md). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md); reporting a vulnerability: [SECURITY.md](SECURITY.md).

## What Mirador does with each agent

The agents Mirador knows, from [`src/agents/catalog.ts`](src/agents/catalog.ts), in its order; a plain `bash` and any `agentCommand` you configure open too ([modes](docs/install.md#modes)). An agent that reports its state gets the waiting-for-you and finished cards.

| Agent | Command | Reports its state | Resumes its session after a restart | Sleeps |
|---|---|---|---|---|
| Pi (gentle-shell) | `gentle-shell` | Yes | `--session <file>` | After 4 h idle, and after a restart |
| Claude Code | `claude` | Yes | `--resume <id>` | After 4 h idle, and after a restart |
| opencode | `opencode` | Yes | `--session <id>` | After 4 h idle, and after a restart |
| Antigravity | `agy` | Yes | `--conversation <id>` | After 4 h idle, and after a restart |
| Codex | `codex` | No | No, starts fresh | No |
| Gemini CLI | `gemini` | No | No, starts fresh | No |
| Kimi | `kimi` | No | No, starts fresh | No |

Only an agent that reports it finished its turn sleeps, so the ones that report nothing reopen at every start and never sleep. The ones that report it sleep both while Mirador runs ([idle sleep](docs/resources.md#idle-sleep)) and after a restart ([sleeping agents](docs/agents.md#sleeping-agents-lazy-restore)). Idle sleep for Claude Code, opencode and Antigravity arrives in 0.3.0; in 0.2.0 only Pi agents go to sleep while Mirador runs.

## How Mirador compares

Other tools run coding agents side by side too.

| You want… | Look at |
|---|---|
| To see which agent is waiting for you | Mirador, Herdr, Paradev, cmux, Emdash |
| Where each project left off | Mirador |
| Agents back in their session after a restart | Mirador, Herdr TUI (on by default), cmux (agents whose hooks saved a session) |
| Agents opened in a row that wait for free memory, one systemd scope per agent, and, after a restart, only the agents that had not finished reopened | Mirador |
| Idle agents put to sleep to free memory | Mirador (agents that can resume their session go to sleep after 4 h finished (configurable in [Settings](docs/resources.md#idle-sleep), in minutes), and after a restart every finished agent stays asleep), cmux (`terminal.agentHibernation`, opt-in), Herdr TUI (community plugins) |
| A night shift and MCP servers per project for gentle-shell | Mirador |
| Remote machines over SSH | Herdr TUI, Herdr app, cmux (`cmux ssh`), Emdash (SSH/SFTP), Claude Code Desktop |
| A phone app | Herdr app (iPhone, iPad, Android), Paradev (Apple, Android), Claude Code Desktop (Claude mobile app), cmux (iPhone beta) |
| Agents in git worktrees | Paradev, Emdash, Claude Code Desktop (per session, off by default) |
| A desktop app on macOS | Herdr app (Apple silicon), Paradev, Claude Code Desktop, cmux (terminal app), Emdash |
| A desktop app on Linux | Herdr app, Paradev, Claude Code Desktop (beta), Emdash |
| A desktop app on Windows | Herdr app, Claude Code Desktop, Emdash |
| A terminal UI in one Rust binary for macOS, Linux and Windows | Herdr TUI |

Herdr fits if you work across several machines, from your phone, or on macOS or Windows; Mirador fits if everything runs on one Linux or WSL2 machine and memory is the limit. Herdr closed [herdrdev/herdr#6152](https://github.com/herdrdev/herdr/issues/6152) ("Add confirmation and a cap for large agent restores") as not planned on 2026-11-23 and pointed the proposal to its Ideas discussions; in Herdr TUI, `[session] resume_agents_on_restore = false` turns off automatic agent resume and keeps the layout. Mirador has no relation to Herdr: the `herdr` names in its code are a gentle-shell compatibility layer ([`bin/herdr-shim`](CONTRIBUTING.md#gentle-names-in-the-code)), and Mirador neither ships nor runs Herdr.

<details>
<summary>What each tool's own site or repository said on 2026-11-26</summary>

The table lists what each one's own site or repository said on 2026-11-26. A dash means its official pages do not say, and "No" means they say so; each project's site is the source of truth and things change.

| | **Mirador** | [Herdr TUI](https://github.com/herdrdev/herdr) | [Herdr app](https://herdr.dev) | [Paradev](https://paradev.com) | [Claude Code Desktop](https://code.claude.com/docs/en/desktop) | [cmux](https://github.com/manaflow-ai/cmux) | [Emdash](https://github.com/generalaction/emdash) (Classic) |
|---|---|---|---|---|---|---|---|
| Form | Web dashboard¹ | Terminal app² | Desktop app³ | Desktop app⁴ | Desktop app⁵ | Terminal app⁶ | Desktop app |
| Platforms | Linux, WSL2, macOS¹ | macOS, Linux, Windows beta² | macOS³, Linux, Windows | macOS, Linux⁴ | macOS, Windows, Linux beta⁵ | macOS only⁶ | macOS, Windows, Linux |
| License | Apache-2.0 | Apache-2.0 | Apache-2.0 | MIT | — | GPL-3.0-or-later⁶ | Apache-2.0 |
| Agents in git worktrees | No | — | — | Yes | Optional⁵ | — | Yes |
| Remote machines and phone | [`ssh -L` tunnel](docs/security.md#opening-mirador-from-another-machine)¹ | SSH | SSH, phone apps³ | Phone, cloud⁴ | SSH, cloud, phone⁵ | SSH, iPhone beta⁶ | SSH/SFTP |
| Agent sessions after a restart | Resumed¹ | On by default² | No³ | — | — | With hooks⁶ | — |
| Idle agents put to sleep | Agents that resume their session¹ | Plugins² | — | — | — | Opt-in⁶ | — |

¹ Mirador: a local web dashboard in a browser window; macOS is experimental; no app, but the inbox is usable on a phone's browser through the same tunnel ([experimental](docs/attention.md#the-phone-inbox-is-experimental)); after a restart gentle-shell, pi, Claude Code, opencode and Antigravity agents resume their session and the others start fresh in their folder; Pi, Claude Code, opencode and Antigravity agents sleep after 4 h finished by default (set in Settings, in minutes), and after a restart every agent that had finished stays asleep.<br>
² Herdr TUI: one Rust binary in the terminal; Windows is in beta; "Native agent session restore is enabled by default" (`[session] resume_agents_on_restore`, [session state](https://herdr.dev/docs/session-state/)); idle agents sleep only through community plugins such as herdr-idle and herdr-hibernate ([plugins](https://herdr.dev/tui/plugins/)).<br>
³ Herdr app: a native desktop app ([herdrdev/herdr-app](https://github.com/herdrdev/herdr-app)); macOS on Apple silicon; phone apps for iPhone, iPad and Android; after a restart its panes come back as a shell, since the FAQ says it "doesn't restart an agent or resume its work in progress".<br>
⁴ Paradev: also a CLI, an SDK and an MCP server; "Windows is not yet available"; the phone app is for Apple and Android devices.<br>
⁵ Claude Code Desktop: the Code tab of the Claude desktop app; Linux beta for Ubuntu and Debian; worktrees per session, off by default; cloud sessions in claude.ai/code or the Claude mobile app, and a local session shows up on your other devices through Remote Control in the Claude apps.<br>
⁶ cmux: a native macOS terminal app, macOS only for now; server parts under BUSL-1.1; SSH through `cmux ssh`; the iPhone app is in beta on TestFlight; "Supported agent sessions can resume when hooks have saved a native session ID"; `terminal.agentHibernation` kills idle background agent processes to free RAM and CPU and resumes them later, off by default for routine hibernation, though under critical memory pressure it may hibernate even when off.

</details>

## How it works

One local server, started by `mirador`, runs every terminal with node-pty and serves the UI to a browser window on the same machine. Agents report when they wait for you, and Engram, when it runs, supplies the memory behind the summaries and **Where it left off**. The modules and the data flow are in [docs/how-it-works.md](docs/how-it-works.md).

```mermaid
flowchart LR
  W["Browser window<br/>app window or tab"] -- "HTTP and WebSocket<br/>session token, Host and Origin checks" --> S["Local server<br/>127.0.0.1:4545"]
  S --> T["node-pty terminals<br/>one systemd scope each (Linux)"]
  T --> A["Agents<br/>gentle-shell, pi or any CLI"]
  T --> B["plain bash"]
  A -- "attention reports" --> S
  A -- "save memories" --> E[("Engram<br/>127.0.0.1:7437")]
  S -- "summaries and where it left off" --> E
```

An agent's life across restarts ([details](docs/agents.md#reopening-agents-after-a-restart)):

```mermaid
flowchart LR
  L["Launched<br/>alone, or in a batch through the launch gate"] --> R["Running<br/>working or waiting for you"]
  R -- "turn ends" --> F["Finished its turn"]
  F -- "starts again" --> R
  R --> X{"Mirador stops, crashes<br/>or the machine reboots"}
  F --> X
  X -- "was working, waiting or unknown" --> O["Reopened at the next start<br/>through the launch gate"]
  X -- "had finished its turn" --> Z["Sleeping<br/>no process, record kept"]
  Z -- "Wake" --> O
  O -- "gentle-shell, pi, Claude Code,<br/>opencode, Antigravity" --> P["Back in its session"]
  O -- "other agents" --> D["Back in its folder"]
```

## Known limits

- Without systemd scopes, `mirador stop` can leave alive processes an agent started in the background ([#1](https://github.com/mata-2p/mirador/issues/1)). Scopes are off with `MIRADOR_SCOPES=0`, with `scopes: false` in the config, on macOS, and on Linux or WSL2 where `systemd-run --user --scope` does not work.
- Once you have seen an agent's finished or error card, the sidebar, its tab and its pane show it as working; Tracking still shows its real state ([#12](https://github.com/mata-2p/mirador/issues/12)).

## Configuration

`~/.config/mirador/config.json`. Workspace changes from the UI write only `workspaces`; every key is optional:

```json
{
  "workspaces": [
    { "id": "dev", "name": "Dev", "root": "/home/you/Dev", "folders": ["tools", "web"], "expanded": ["web"] }
  ],
  "port": 4545,
  "engramUrl": "http://127.0.0.1:7437",
  "agentCommand": "gentle-shell",
  "ignore": ["node_modules", "bin", "obj", "dist", "build", "target", "coverage", "__pycache__"],
  "timeZone": "America/Santiago"
}
```

What each key does, the `browser` override, the commands (`mirador link | status | stop | logs`) and a broken config: [docs/configuration.md](docs/configuration.md). The launch gate's `launches` settings: [docs/agents.md](docs/agents.md#opening-many-agents-without-filling-the-memory).

Terminals run in systemd scopes where `systemd-run --user --scope` works. `MIRADOR_SCOPES=0` in the environment, or `"scopes": false` in the config, turns them off: [One systemd scope per terminal](docs/agents.md#one-systemd-scope-per-terminal).

## Development

```sh
pnpm test                 # node --test 'test/**/*.test.ts'
```

New features plug in as one route module and one UI module each; [docs/extending.md](docs/extending.md) lists the shared helpers, events, DOM slots and the lines each feature registers on. [docs/releasing.md](docs/releasing.md) is for maintainers: cutting a release, reviewing its draft and the promotion PR that pins it in `scripts/bootstrap.sh`. The names of the Gentle tools you meet in the code, the config and `doctor` (gentle-ai, Engram, gentle-deck, `bin/herdr-shim`) are explained in [Gentle names](CONTRIBUTING.md#gentle-names-in-the-code).

## Author

Mirador is created by Matías Barría ([@mata-2p](https://github.com/mata-2p)), founder of [ZURAI](https://zurai.cl).
Need custom software or consulting? Get in touch with ZURAI at [zurai.cl](https://zurai.cl).

## License

Mirador is released under the [Apache License 2.0](LICENSE). You can use, modify and redistribute it, also commercially, as long as you keep the notice ([NOTICE](NOTICE)); contributors grant a patent licence for their contributions.

## Sponsoring

Mirador is free and funded by donations: monthly tiers are on GitHub Sponsors and one-off tips on Ko-fi, both described in [SPONSORS.md](SPONSORS.md). Nothing in the app is paid, and there is no telemetry.
