# Running and configuring Mirador

The `mirador` commands, every key of `~/.config/mirador/config.json` and how Mirador picks a browser. The Quickstart is in the [README](../README.md#quickstart), and the full install in [docs/install.md](install.md). Keys that belong to one feature are described with it: `launches` in [Opening many agents without filling the memory](agents.md#opening-many-agents-without-filling-the-memory), `scopes` in [One systemd scope per terminal](agents.md#one-systemd-scope-per-terminal), `attentionBridge` in [Attention inbox](attention.md#attention-inbox) and `gentleShellAgentDir` in [MCP servers per project](agents.md#mcp-servers-per-project).

## Use

```sh
pnpm install              # builds node-pty for the current Node
bin/mirador install       # optional: adds ~/.local/bin/mirador and, on Linux, an app menu entry
mirador                   # starts the server if needed and opens an app window (a tab without a Chromium-family browser)
mirador link | status | stop | logs
```

`mirador link` prints only a fresh one-time link to the running server, on one line, and opens no window, for a phone or another machine through the SSH tunnel in [docs/security.md](security.md#opening-mirador-from-another-machine); without a running server it says so and exits 1.

`mirador stop` stops the server and every terminal it runs, and returns once the server process is gone and its port is free, so `mirador stop && mirador` starts the new one right away. It waits up to 30 s; after that it says the server is still stopping and exits 1. The agents among them reopen at the next start.

If the server cannot start, `mirador` stops waiting as soon as it exits, prints the end of its log and opens no window. A taken port reads `mirador: port 4545 on 127.0.0.1 is already in use (is Mirador already running? see bin/mirador status)`.

Requirements: Linux, macOS (experimental) or WSL2, git, Node 24+ (runs the TypeScript sources directly), pnpm 12, bash, a Chromium-family browser (Chromium, Chrome, Brave, Edge or Vivaldi) for the app window (any other browser opens Mirador as a tab), and `engram serve` on `127.0.0.1:7437` for summaries. If Node changes major version, run `pnpm rebuild node-pty`.

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

`folders` are the folders the workspace shows, relative to its `root` (empty: all first-level folders); `expanded` are the folders whose subfolders are open. `browser` (not in the example) is a command on `PATH` or a macOS app name that opens the app window ahead of the Chromium-family list; when it is not found the list applies (see [Browser](#browser)). `ownerName` (not in the example) is the name the autopilot's and «Mejorar con IA»'s prompts use for you, along with the texts agents receive from Mirador (execution notes, delegated tasks, autopilot answers and follow-ups, and the note that asks an idle agent to save before it sleeps) and the reasons the night report shows, for example `"ownerName": "Ana"` gives "Ana is away from the keyboard". Unset, those texts say "the user" and name nobody. It must be 1 to 60 characters on one line, without `<` or `>`; any other value logs one line at startup and "the user" applies. Records written before a change keep the name they were written with. `leftOffDays` (not in the example) is how many days the local record of Claude Code's last message ([Where it left off](attention.md#where-it-left-off)) is kept: a whole number from 1 to 3650, 30 by default; any other value logs one line at startup (`leftOffDays must be a whole number of days from 1 to 3650; the default (30) applies`). Older records are removed at start and when a record is written; Mirador never reads Claude Code's own settings to choose it. `leftOff: false` (not in the example) turns that capture off: the hooks forward nothing and no record is written or shown; records already written go when they expire. A config from before workspaces, with a single `root`, loads as one workspace named `Dev`; the first workspace change saves it in the new shape and drops `root`. Saving keeps a symlinked `config.json` a symlink and keeps its mode. When `workspaces` is not a list, holds an entry without `id`, `name` or `root`, or repeats an id, Mirador shows the entries it can read, logs the others at startup and refuses workspace changes (`workspace_config`) until the file is fixed and Mirador restarted, so nothing you wrote is lost.

## Browser

Mirador opens as an app window in a Chromium-family browser (Chromium, Chrome, Brave, Edge or Vivaldi), because only that family supports `--app=URL`: a window without browser UI. Firefox removed its site-specific-browser mode in 2021, and Safari has no command-line equivalent.

The UI itself works in any modern browser. With no Chromium-family browser, `mirador` opens it as a tab in the default browser (`xdg-open` on Linux, `open` on macOS) and prints that the app window needs one. To force a browser, set `browser` in the [config](#configuration): a command on `PATH`, or an app name on macOS.

On Linux without a display (neither `DISPLAY` nor `WAYLAND_DISPLAY` is set, as in an SSH session or a container), no browser can show a window, so `mirador` starts the server and prints the one-time link instead, on stdout, and exits 0: `mirador: no display (DISPLAY and WAYLAND_DISPLAY are unset), so no window opens; open this one-time link in a browser within 60 s: <link>`. The link signs in one browser, once; run `mirador` again for a new one. WSL2 opens the Windows browser and skips this check. On such a machine no browser is required: `install.sh` prints a warning instead of stopping when none is found (`install.sh: warning: no browser found (…); this machine has no display …`) and goes on, and `pnpm run doctor` lists the browser among the optional items, saying it is not required without a display.
