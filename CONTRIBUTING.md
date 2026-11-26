# Contributing to Mirador

Thanks for helping. Set up, make a small change with its tests and docs, and open a pull request.

## Quick path

1. Install Node 24 or newer and pnpm.
2. Install the dependencies exactly as locked:

   ```sh
   pnpm install --frozen-lockfile
   ```

3. Check what your machine has or lacks:

   ```sh
   pnpm run doctor
   ```

4. Run the tests before and after your change:

   ```sh
   pnpm test
   ```

node-pty compiles native code during install, so you also need python3, make and a C++ compiler.

A test that runs `scripts/bootstrap.sh` or `install.sh` calls `assertInstallerSandbox` (`test/helpers/installer-sandbox.ts`)
on the child's environment right before starting it; it throws unless the run is in a container or under a temporary
`HOME`. Run those scripts by hand the same way, in a container or with a temporary `HOME`, never with your own.
The guard also throws when the child's `PATH` finds a real `mise`, `curl` or `wget`, so no installer test reaches the network: put the fakes `writeNetworkBarrier` writes (exit 97) right after the test's own stubs.

### Typecheck

`pnpm typecheck` runs `tsc --noEmit` with `tsconfig.json` over `src/`, `test/` and `scripts/`. It does not emit
anything; Node still runs the `.ts` files directly. The check is split in two:

| Command | Config | Covers | In CI |
|---|---|---|---|
| `pnpm typecheck:src` | `tsconfig.src.json` | `src/` | blocks: `src/` has no type errors, and one fails the job |
| `pnpm typecheck:test` | `tsconfig.test.json` | `test/`, `scripts/` | informational: prints the count against the baseline (250) and exits 0 |

Run both before a pull request; your change should not add errors to either.

`pnpm run export:check` rebuilds the committed `HEAD` from `git archive` as a fresh one-commit repository with a
scratch `HOME`, then installs offline and runs the tests, `typecheck:src`, the doctor, the private-data scan and the
task-name check (each feature document's file name, looked for in the export, with or without its folder) there.

Maintainers only, in the public clone: `pnpm run hooks:install` installs a pre-push hook that rejects any commit
tracking the maintainer's private folders (feature documents and design artboards).

## Pull requests

| Rule | Detail |
|---|---|
| Size | About 400 changed lines. Split bigger work into a chain of pull requests. |
| Tests | Every behavior change comes with a test in `test/<feature>.test.ts`. |
| Docs | Update the docs that describe what you changed, in the same pull request. |
| Changelog | Add a user-facing line for your change to [CHANGELOG.md](CHANGELOG.md), under the version being prepared. |
| Description | Say what changes and why, and how you checked it (the commands you ran and what they printed). That is enough: you do not need to write a feature document, see [odd/README.md](odd/README.md). |
| Commits | [Conventional Commits](https://www.conventionalcommits.org/): `feat(server): …`, `fix(ui): …`, `docs: …`. |
| Language | English for code, comments, UI copy and docs. |
| Secrets | CI scans the git history with [gitleaks](https://github.com/gitleaks/gitleaks). Example tokens belong in the files `.gitleaks.toml` allows; never commit a real one, a rewrite of the history would be needed. |

[docs/extending.md](docs/extending.md) explains how a feature plugs in. Its
[rules that stay](docs/extending.md#6-rules-that-stay) (loopback only, Host and Origin checks, session token, folder
confinement) apply to every change.

## Gentle names in the code

Mirador grew up next to the Gentle tools, so a few of their names show up in the code, the config and `doctor`. None
of them is needed for the plain mode.

| Name | What it is | What Mirador does with it |
|------|------------|---------------------------|
| gentle-ai | The Gentle setup tool for AI agents; it records the agents it configured in `~/.gentle-ai/state.json` (`GENTLE_AI_HOME` moves it). | Reads that file only: its `installed_agents` add agents to the agent picker, and the file's presence makes `mode: "auto"` pick the full mode. `pnpm run doctor` reports it. |
| Engram | A local persistent-memory server that agents save their session summaries to. | Reads it at the config's `engramUrl` (`http://127.0.0.1:7437` by default) for the daily summary and [where it left off](docs/attention.md#where-it-left-off). Without it those views are empty, except where it left off for a folder where Claude Code ran in Mirador. |
| gentle-deck | The internal name of the full mode (memory, night shift and Pi MCP), kept as the config value `mode: "gentle-deck"`. | Nothing on screen: the app is called Mirador in every mode. Where the old name stays and why: [The name gentle-deck in the code](#the-name-gentle-deck-in-the-code). |
| `bin/herdr-shim` | A gentle-shell compatibility layer: gentle-shell reports what an agent is doing with `herdr pane report-metadata`, and the shim answers that command. It has no relation to the Herdr product ([herdr.dev](https://herdr.dev)); Mirador neither ships nor runs Herdr. | Agent terminals get `HERDR_BIN_PATH` pointing at the shim, which forwards each report as one JSON line to a Unix socket under `<runtime>/mirador/herdr/`, feeding the [attention inbox](docs/attention.md#attention-inbox). It prints nothing, always exits 0 and gives up after one second. |

## The name gentle-deck in the code

The app is called Mirador in every mode. Its visible name lives in one place, `BRAND` in `public/mode-model.js`:
i18n messages write `{brand}` and `translate` fills it in. The mode with memory, the night shift and Pi MCP is
called the full mode on screen and in the docs. `test/brand-visible-name.test.ts` fails if any visible string
says gentle-deck.

These internal names still say gentle-deck, on purpose:

| What | Where | Why it stays |
|---|---|---|
| The `mode` config value `"gentle-deck"` | `src/config.ts` (`MODES`), `src/mode.ts`, `GET /api/config`'s `mode`, `modeOf()` in `public/mode-model.js` | People already have it in their `config.json`. The startup warning lists it among the valid values, and `mirador doctor` repeats the configured value as `(config: gentle-deck)`. |
| Test files | `test/gentle-deck-*.test.ts` | Renaming them would break the history of the specs they test. |
| Spec ids in code comments | `public/`, `src/`, `test/` | They cite the spec ids (`S1`, `S2`, ...) of the maintainer's feature documents, which are kept outside this repository. You do not need them. |
| Design artboards | Kept outside this repository, with the maintainer's feature documents | Drawn before the rename. They are references and the app never serves them. Tests that pin the app to them skip where they are absent (`test/helpers/design.ts`). |
| Code comments, shell comments and older CHANGELOG entries | `public/`, `src/`, `scripts/demo-workspace.sh`, `CHANGELOG.md` | They name the mode value or the files above. |

## Adding an agent adapter

Mirador opens the terminal agents listed in `src/agents/catalog.ts`.

1. Add an entry to `AGENTS`. With no way to report its state, use `launchOnly(id, label, binary)`.
2. If the agent has hooks or plugins, add a bridge that reports working, waiting and finished. Model it on an existing
   bridge in [docs/extending.md, Notes per unit](docs/extending.md#5-notes-per-unit) (Claude Code, opencode, agy),
   and document yours there.
3. Never edit the agent's own config: pass the bridge through a flag or an environment variable for that launch only.
4. Test it in `test/agents-catalog.test.ts` with fake binaries in a scratch `PATH`; tests never run a real agent.

## Issues and pull request templates

New issues start from a template in `.github/ISSUE_TEMPLATE/`: a bug report asks for the steps and the block
`pnpm run doctor --report` prints, a feature request for the problem and your proposal. A pull request starts from
`.github/pull_request_template.md`, which repeats the rules above as a checklist.

The CI workflow pins each GitHub Action to a commit SHA, with its release tag in a comment
(`uses: actions/checkout@<sha> # v4.4.0`). Keep that form when you add a step; dependabot proposes the updates.

## Code of conduct

Be kind and assume good intent. Harassment of any kind is not tolerated, in issues, pull requests or anywhere else in
the project. The full text, and where to report a problem, is in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
