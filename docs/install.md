# Installing Mirador

The short version is the [Quickstart](../README.md#quickstart) in the README. This page has the rest: the requirements, both ways to install, the prebuilt release, the workspace folder, starting it on Linux, macOS and WSL2, the manual steps, the modes and the doctor report.

## Requirements

| Need | Why |
|------|-----|
| Linux, macOS (experimental) or WSL2 | the launcher and the terminals; systemd scopes only where `systemd-run` works |
| curl and git | the one-line install downloads its script with curl; the install from source also clones Mirador with git, and a manual install needs git. The prebuilt release (Linux x64 and arm64, below) needs no git. Minimal images such as Debian's ship neither: `sudo apt install curl git` |
| Node 24 or newer | Mirador runs its TypeScript sources directly. Where the distribution packages an older Node (Debian 13, for example), install it with [mise](https://mise.jdx.dev), as `install.sh` suggests: `curl https://mise.run \| sh`, add `eval "$(~/.local/bin/mise activate bash)"` to `~/.bashrc`, open a new terminal, then `mise use -g node@24` |
| pnpm 12 | installs the dependencies, among them `node-pty`, which compiles (next row). pnpm 12 is the major CI installs the lockfile with: `mise use -g pnpm@12`, or with the corepack that ships with Node 24, `corepack enable pnpm && corepack install -g pnpm@12` |
| python3, make and a C++ compiler; on macOS the Xcode Command Line Tools | `node-pty` compiles with them. Debian and Ubuntu: `sudo apt install python3 make g++`; Fedora: `sudo dnf install python3 make gcc-c++`; Arch: `sudo pacman -S python make gcc`; macOS: `xcode-select --install` |
| a Chromium-family browser (Chromium, Chrome, Brave, Edge or Vivaldi) for the app window; any other browser opens Mirador as a tab | the window (see [Browser](configuration.md#browser)). On Debian: `sudo apt install chromium`. Without a display, `bin/mirador` prints the link to open by hand |

## Install

Clone this repository, go into it and run the installer there:

```sh
git clone https://github.com/mata-2p/mirador.git
cd mirador
./install.sh                 # or ./install.sh --root ~/code to set the workspace folder
```

The installer works on the clone it belongs to wherever you run it from (`mirador/install.sh` works too); run from another folder, its messages name the clone's files by their full path.

On Linux x64 and arm64 with glibc 2.28 or newer, one line installs the prebuilt release, with nothing to compile ([Prebuilt release (Linux)](#prebuilt-release-linux) below). On other Linux systems it clones Mirador into `~/.local/share/mirador` (`$XDG_DATA_HOME/mirador` when that is set), or updates that clone, and runs the clone's installer from the folder you are in; read [the script](../scripts/bootstrap.sh) before running it:

```sh
curl -fsSL https://raw.githubusercontent.com/mata-2p/mirador/main/scripts/bootstrap.sh | sh
```

For the install from source, installer options go after `sh -s --`, as in `curl -fsSL … | sh -s -- --root ~/code`. Run it as your own user: as root, or with `sudo`, it refuses and changes nothing, because Mirador installs into your home folder. You stay in your folder, so the installer names the clone's files in full: it ends with `start Mirador with: /home/you/.local/share/mirador/bin/mirador`, and when something is missing it says to run `/home/you/.local/share/mirador/install.sh` again (running the same line again works too). When git cannot clone, it says `bootstrap.sh: could not download Mirador from …` and exits 1.

Keep the `-f` of `-fsSL`: with it, a failed download (a 404, no network) makes curl print the error, for example `curl: (22) The requested URL returned error: 404`, and pass nothing to `sh`, instead of an error page that `sh` would try to run. `sh` then runs nothing, but with a pipe the line still exits 0, so look for that curl line. A download cut short runs nothing either: the script prints `bootstrap.sh: this copy of the script is incomplete (the download was cut short), so nothing ran; download it again` and exits 1. To make any failed download stop with a non-zero exit, save the script, read it, then run it:

```sh
curl -fsSLO https://raw.githubusercontent.com/mata-2p/mirador/main/scripts/bootstrap.sh && sh bootstrap.sh
```

It checks Node, pnpm, the build tools and, on Linux, a browser first (the browser with the same check as `pnpm run doctor`, or, before Node 24 is there, a shell check of the same browsers); for each missing one it prints why Mirador needs it and the command that installs it (pacman, apt, dnf, zypper, brew or, for Chromium on Ubuntu, snap), and exits 1 without changing anything. On Linux without a display (no `DISPLAY` or `WAYLAND_DISPLAY`, not WSL) a missing browser is only a warning, since `bin/mirador` prints a link to open elsewhere there, and the install goes on. With apt and several items missing it also prints one `sudo apt install` command for all of them, and on Linux without pacman it gives the steps to install Node 24 with [mise](https://mise.jdx.dev). Under WSL it warns when the clone is on a Windows drive (`/mnt/c/...`), which makes installing and loading much slower; clone it in your Linux home instead. It never runs `sudo` and never installs system packages or Node. Then it runs `pnpm install --frozen-lockfile`, creates `~/.config/mirador/config.json` from `config.example.json` when there is none yet (an existing config is never touched; without `--root` it says which line to edit), runs `pnpm run doctor`, on Linux runs `bin/mirador install`, and ends with the command that starts Mirador. When `gentle-shell` or `pi` is not on `PATH`, or Engram does not answer at the config's `engramUrl` (the same check as `pnpm run doctor`), it ends with one note each on what Mirador does without it (plain mode, no pi agent, empty memory views) and how to get it; they never fail the install. `./install.sh --help` lists its options.

## Prebuilt release (Linux)

On Linux x64 and arm64 with glibc 2.28 or newer, the line installs the release pinned in the script, Mirador 0.2.0, which bundles Node and a built `node-pty`, so it needs no git, Node, pnpm or compiler, and the Node, pnpm and compiler rows of the requirements do not apply. It downloads `mirador-<version>-linux-<arch>.tar.gz` from GitHub Releases, checks it against the sha256 written in the script before unpacking it into `~/.local/share/mirador/<version>`, points `~/.local/share/mirador/current` at it, runs its doctor and adds the launcher; it takes no installer options. When `~/.local/share/mirador` is already a git clone, it leaves it as it is, stops and says how to keep the clone or move it away; any other folder there it also leaves alone and asks you to move away, except one that holds only the `.download.XXXXXX` folders of a first install cut off abruptly (a power cut, a killed terminal): it removes those, saying `bootstrap.sh: removed …, a download an earlier run left half done` for each, and installs. It never checks for updates: running the line again is how you update. When a Mirador server is running during an update, it says, after pointing `current` at the new version, `bootstrap.sh: a Mirador server is running, and it keeps running Mirador <previous version> until you restart it with: mirador stop && mirador`. With an older glibc it says `bootstrap.sh: the prebuilt release needs glibc 2.28 or newer (found: …), so Mirador installs from source` and installs from source; macOS and other systems keep the install from source too. [docs/releasing.md](releasing.md) says how a release is built and pinned.

## The workspace folder

Mirador shows the folders inside the `root` of each workspace. The prebuilt release writes no config: with none, Mirador shows one workspace, Dev, on `~/Dev`, or on your home folder when `~/Dev` does not exist, and writes `~/.config/mirador/config.json` the first time you change a workspace from the app, for example when you add one with **Add** next to **Workspaces** in the sidebar. The install from source writes a new config from `config.example.json`, and `--root <dir>` writes the root into it: the folder must exist (otherwise `install.sh` exits 2 and changes nothing), and your shell expands `~` in `--root ~/code` before `install.sh` sees it. Without `--root`, the new config keeps the example's `/home/you/code` and the installer says which line to edit. In the config file, `root` must be the full path of an existing folder, and `~` is not expanded there. Left at `/home/you/code`, or naming a folder that does not exist, Mirador still starts without a warning, and the folder tree shows *The folder of this workspace no longer exists* instead of folders; fix `root`, then restart Mirador (`bin/mirador stop && bin/mirador`). Workspaces added from the app accept `~/`.

## Starting it

After the one-line install of the prebuilt release, `bin/mirador` is `~/.local/share/mirador/current/bin/mirador`. In an install from source it is in the clone: from the clone's folder it is `bin/mirador`, from anywhere else its full path, such as `~/.local/share/mirador/bin/mirador` after the one-line install from source. On Linux the installer also links `~/.local/bin/mirador`, so `mirador` works from any folder once `~/.local/bin` is on `PATH` (the installer warns when it is not). On Linux without a display (no `DISPLAY` or `WAYLAND_DISPLAY`: an SSH session, a container), `bin/mirador` still starts the server and prints the one-time link instead of opening a window: `mirador: no display (DISPLAY and WAYLAND_DISPLAY are unset), so no window opens; open this one-time link in a browser within 60 s: http://127.0.0.1:4545/#launch=…`. Run `bin/mirador` again for a new link.

- **macOS (experimental).** The app window opens with `open -na` in Google Chrome, Brave Browser, Microsoft Edge, Vivaldi or Chromium; with none of them, `open` shows Mirador as a tab in the default browser. There are no systemd scopes, so terminals run without memory limits: the server turns them off without probing, `doctor` says so and the **Usage** pane says *Limits are not available on macOS*, and free memory is read with `sysctl` and `vm_stat`. node-pty 1.1.0 ships its macOS `spawn-helper` without the execute bit; the server adds it at startup. The installer does not run `bin/mirador install`; run it yourself to add only the `~/.local/bin/mirador` link (macOS gets no app menu entry).
- **WSL2.** Mirador runs as on Linux. With no Linux Chromium browser, `bin/mirador` opens the window's URL with `wslview` when it is present, else in a Microsoft Edge app window through `powershell.exe` (recent Ubuntu releases ship no `wslu`), else as a tab through `xdg-open` when it is present, and otherwise prints the URL to open in a Windows browser. The one-time link lasts 60 seconds from the launcher's request, because starting `powershell.exe` and Edge in a VM can take over 10 seconds, and the page redeems it as soon as it opens.
- **Windows.** Windows native is not supported: Mirador relies on POSIX signals, process groups, systemd scopes and `/proc`. WSL2 with `systemd=true` in `/etc/wsl.conf` is the supported path, and the app window opens in Edge on the Windows side.

## Manual steps

The same steps by hand, instead of `./install.sh`:

1. Clone this repository, then install from its folder with pnpm 12 (Node 24 and pnpm as in the requirements above):

   ```sh
   git clone https://github.com/mata-2p/mirador.git
   cd mirador
   pnpm install
   ```

2. Copy the example config, then set `root` to the full path of an existing folder of yours (`~` is not expanded there; see [The workspace folder](#the-workspace-folder) above):

   ```sh
   mkdir -p ~/.config/mirador
   cp config.example.json ~/.config/mirador/config.json
   ```

   It holds one workspace, `"agentCommand": "bash"` (a plain shell per folder; put `claude`, `opencode` or another agent there later) and `"mode": "auto"`. Every key is in [Configuration](../README.md#configuration).

3. Check the machine:

   ```sh
   pnpm run doctor
   ```

   It lists Node, node-pty and a browser (required: it exits 1 when one is missing; on Linux without a display the browser is optional), then systemd, gentle-ai, each agent it knows and Engram (optional: they only inform). When gentle-shell, pi or Engram is missing, a **Not found** part gives one line each: what Mirador does without it (plain mode with one bash per folder, no pi agent or session restore, empty memory views such as "where it left off") and how to get it ([gentle-shell](https://github.com/Gentleman-Programming/gentle-shell), which also starts pi; `engram serve` for Engram, see [Use](configuration.md#use)). The exit code stays 0 when only these are missing.

4. Start it:

   ```sh
   bin/mirador
   ```

   The server starts and an app window opens; without a display it prints the link to open instead. `bin/mirador stop` stops it. To have `mirador` on `PATH`, run `bin/mirador install` (Linux and macOS: it links `~/.local/bin/mirador`). Where `systemd-run --user --scope` works, each terminal runs in its own systemd scope; elsewhere Mirador starts without them.

## Modes

`mode` is `auto`, `gentle-deck` or `plain`. `gentle-deck` is the full mode: memory, night shift and Pi MCP. `auto` picks the full mode when gentle-ai's `~/.gentle-ai/state.json` exists or `gentle-shell` is on `PATH`, and plain mode otherwise. The app is called Mirador in both.

## Checking the install

To report a bug, run `pnpm run doctor --report` and paste the fenced block it prints: OS and version, kernel, architecture, Node, pnpm, node-pty, the browser found, systemd scopes, the mode and which agents are on `PATH`. After the one-line install of the prebuilt release, which bundles Node and has no pnpm, run `~/.local/share/mirador/current/node/bin/node ~/.local/share/mirador/current/src/doctor.ts --report` instead, from any folder; it prints the same block, with `pnpm: not found`. It holds no path under your home folder, no user or host name, and nothing from the config besides the mode.
