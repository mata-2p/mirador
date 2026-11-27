# RAM and CPU usage

Mirador shows how much memory and CPU each agent it runs uses, how much memory the machine has left, and the gentle-shells running outside Mirador. Everything is read from `/sys` and `/proc`. Mirador never signals, limits or closes any process because of these figures; the only thing it does with them is the launch gate, which delays starting agents while memory is low. The one agent Mirador closes by itself is one left idle for the threshold set in Settings, 4 h by default (idle sleep, below), and that depends on its attention state, not on memory figures.

| Piece | File |
|---|---|
| Reader | `src/system/resources.ts` (`ResourceSampler`, `readMachineMemory`, `miradorScope`, `cpuPercent`) |
| Launch gate | `src/system/memory-gate.ts` (`LaunchGate`): batches and the memory reserve for agents opened in a row ([agents.md](agents.md#opening-many-agents-without-filling-the-memory), "Opening many agents without filling the memory") |
| Route | `src/http/routes/resources.ts` (`resourceRoutes`, `GET /api/resources`) |
| UI rules | `public/features/resources-model.js` (formatting, `LOW_MEMORY_SHARE`, heaviest first) |
| UI | `public/features/resources.js` (poller, terminal badges, Seguimiento helpers), `public/styles/resources.css`, `public/i18n/resources.js` |
| Loading bar | `public/features/launch-progress.js` and `launch-progress-model.js` (bar text, blocked actions), `public/styles/launches.css`, `public/i18n/launches.js`; it reads `GET /api/terminals/launches` and takes the free memory from the poller above ([agents.md](agents.md#while-agents-open), "While agents open") |
| Lazy restore | `src/terminals/open-agents.ts` (`lastState`, sleeping records, `wake`), `src/attention/store.ts` (`agentState`, `onAgentState`); UI `public/features/sleeping.js` and `sleeping-model.js`, `public/styles/sleeping.css`, `public/i18n/sleeping.js`. After a restart only agents that were working or waiting reopen; the ones that had finished their turn sleep without a process until woken, which is what saves memory ([agents.md](agents.md#sleeping-agents-lazy-restore), "Sleeping agents") |
| Idle sleep | `src/terminals/hibernate.ts` (`IdleSleep`, `sleepNote`), `OpenAgents.canSleep`/`resumeKey`/`sleep`, `AttentionStore.idleHold`, config `idleSleep`, `idleSleepMinutes` and `idleSleepHours` (`src/config.ts`, `idleSleepMs`), Settings route `src/http/routes/idle-sleep.ts`; wired in `src/server.ts`. See "Idle sleep" below |

## Where each figure comes from

- **A terminal in its own scope** (the default, `src/terminals/scopes.ts`) reads the cgroup `/sys/fs/cgroup/user.slice/user-<uid>.slice/user@<uid>.service/app.slice/mirador-<kind>-<id>.scope`: `memory.current`, `memory.swap.current`, `memory.peak` and `usage_usec` from `cpu.stat`. `source` is `scope`.
- **Without a scope** (`scopes: false`, `MIRADOR_SCOPES=0`, or no systemd), the terminal is the server's child process whose environment holds `HERDR_PANE_ID=<terminal id>`. Its figures are the sums of `VmRSS` and `VmSwap` (`/proc/<pid>/status`) and of CPU time (`/proc/<pid>/stat`, utime + stime) over that process and everything below it. `source` is `tree` and `peak` is null. Shared pages count once per process, so a tree reads a little higher than its cgroup would.
- **The machine**: `MemTotal`, `MemAvailable`, `SwapTotal` and `SwapFree` from `/proc/meminfo` (`readMachineMemory`, which the launch gate reads too before each agent it starts).
- **The server**: `VmRSS` and `VmSwap` of its own process.
- **Outside Mirador**: same-user processes started as `node …/gentle-shell.mjs` (or the script run directly) that are not in a Mirador cgroup (`mirador-agent|shell|server-<id>.scope`, from this or any other Mirador), not below this server, and not below another launcher. Each is reported with its folder (`/proc/<pid>/cwd`) and the memory of its process tree. A tree is used instead of the cgroup because one tmux scope can hold many gentle-shells. One sample reads at most 5000 processes and lists the 50 heaviest launchers. `count`, `memory` and `swap` cover every launcher found.

Anything unreadable is `null` (a missing scope, a process that ended mid-read, a missing `/proc/meminfo`). The answer is always 200.

## GET /api/resources

```json
{
  "at": "2026-10-29T21:00:05.000Z",
  "sampleMs": 5000,
  "cpuWindowMs": 5000,
  "machine": { "memTotal": 25097977856, "memAvailable": 8512815104, "swapTotal": 41766985728, "swapFree": 7570845696 },
  "server": { "rss": 100663296, "swap": 28311552 },
  "terminals": [
    { "id": "034ac4c7-…", "kind": "agent", "source": "scope", "memory": 2807791616, "swap": 999153664, "peak": 3730919424, "cpu": 3.2 }
  ],
  "outside": {
    "count": 14, "memory": 1932735283, "swap": 10223616000, "truncated": false,
    "processes": [{ "pid": 4242, "cwd": "/home/u/Dev/project", "memory": 402653184, "swap": 805306368 }]
  }
}
```

- All memory figures are bytes. `cpu` is the % of **one** core over `cpuWindowMs`, the time since the previous sample, as `top` counts it. An agent busy on several cores goes over 100. `cpu` and `cpuWindowMs` are null on the first sample, and `cpu` is null for a terminal new since the previous one.
- `terminals` follows the registry's order and includes exited terminals and bash terminals. An exited terminal has every figure null.
- `outside.processes` is heaviest first (RAM + swap, then pid). `truncated` is true when the list was capped or the process scan stopped at its limit.

### Sampling cadence

Requests never wait on a timer. The route takes at most one sample per `SAMPLE_MS` (5 s): a poll inside that window gets the last sample. The first poll starts a timer that samples every `SAMPLE_MS`, so the CPU figures always cover the last 5 s. The timer stops `IDLE_MS` (30 s) after the last poll and at shutdown, so nothing is read while nobody looks. Concurrent polls share one sample in flight. On the 24 GB development machine (≈900 processes, 14 launchers outside), one sample takes about 35 ms of async file reads.

## UI

- `resources.js` polls every 10 s while the window is visible and emits `resources` with each answer (null after a failure).
- **Development**: every element with a `data-terminal-id="<terminal id>"` attribute gets a badge `span.res-badge` ("1,5 GB · 3 %", RAM + swap · CPU) before its `.close` button. The badge is updated in place on each answer and on the `terminals`, `activate` and `language` events. On a `.pane` element the badge goes into its `.pane-head`; any other element (the `.tab`) takes it directly. An element without the attribute is never decorated: resources.js does not guess which tab is which.
- **Seguimiento**:
  - The strip shows "Memoria libre 7,9 GB de 23,4 GB · swap 31 GB en uso".
  - Below `LOW_MEMORY_SHARE` (15 % of RAM available) the line turns warm and reads "⚠ Poca memoria: …". The color is never the only signal.
  - Each agent card has a usage line ("RAM 1,1 GB + 0,4 GB swap · CPU 3 %").
  - The dock's **Consumo** pane lists the 8 heaviest agents (click to go to one), the server, and a closed `<details>`, "Fuera de Mirador: 14 gentle-shell, 10,9 GB", with each outside folder.
  - All of these update in place: a poll never rebuilds a focused control, and the `<details>` keeps its open state.

The low-memory threshold is a named constant in `resources-model.js`. Below about 15 % available on this machine, the system swaps hard and systemd-oomd starts killing scopes.

## Idle sleep

An open agent that can resume its session, one whose catalog entry has a `resume` argv (`src/agents/catalog.ts`: Pi, Claude Code, opencode and Antigravity), goes to sleep while Mirador runs once its turn has been finished for the threshold, the way R5a leaves finished agents asleep after a restart. An idle agent holds about 0.8-1.3 GB (the agent and its MCP servers). Codex, Gemini CLI, Kimi and any agent without a `resume` argv never sleep from idleness, and neither does an agent that has not recorded a session to resume yet (a pi session file from gentle-shell's bridge; a session id from Claude Code's or Antigravity's hooks or opencode's plugin).

**Settings → Dormir inactivos / Idle sleep** has a switch (on/off) and the threshold in minutes, 240 (4 h) by default. A change is saved in `config.json` and applies at once, with no restart: switched off, no clock runs and a save turn under way no longer closes its agent; with a new threshold, every finished agent counts it from the change. The same values are config keys:

- `idleSleep`: `false` turns idle sleep off; any value other than `true` or `false` logs one line at startup (`idleSleep must be true or false; the default (on) applies`).
- `idleSleepMinutes`: the threshold, a whole number of minutes from 1 to 10080 (one week). When set it wins over `idleSleepHours`; any other value logs one line at startup (`idleSleepMinutes must be a whole number of minutes from 1 to 10080; idleSleepHours or the default (240) applies`).
- `idleSleepHours`: still read when `idleSleepMinutes` is not set: hours from 0 to 168, `0` turns idle sleep off, a fraction such as `0.5` is allowed; any other value logs one line at startup and the default (4) applies.

API: `GET /api/settings/idle-sleep` answers `{ on, minutes }`; `PUT /api/settings/idle-sleep` with `{ on, minutes }` saves both and answers the same. Any other body is a 400 `idle_sleep_invalid` (`on must be true or false`, `minutes must be a whole number from 1 to 10080`, `only on and minutes can be saved`) and `config.json` is left as it was. The doctor report (`pnpm run doctor`) lists the same config problems.

1. **The idle clock** starts when the agent's attention state becomes `finished` (`AttentionStore.agentState`), and starts again when the user types into its terminal. The terminal's own replies, such as focus reports, do not count. Any other state stops the clock: an agent that is working, waiting for the user (a `blocked` or `prompt` token), stopped with an error or whose state is unknown never sleeps.
2. **When the clock runs out**, the agent stays open and its clock starts again if any of these holds:
   - gentle-shell reports an in-progress Todo for it;
   - the night shift is deciding about it or left it for the user (a `deciding` or `deferred` night state, `AttentionStore.idleHold`);
   - it has no recorded session to resume (`OpenAgents.canSleep`).

   A **Pi agent** then gets `sleepNote()` through the night shift's note path (`NightService.sendNote`, the method execution notes use), framed as "Note from Mirador, which puts idle agents to sleep". The note says the agent resumes when the user wakes it, naming them as config `ownerName` says ("the user" unset; `IdleSleep` option `ownerName`), and asks it to save its session summary with `mem_session_summary` and end its turn. The night log records it as Mirador's note (`note.from: "mirador"`, its own policy reason), shown in the night report as "Nota de Mirador"; unlike the user's notes it moves no live night card. Without the night service a Pi agent cannot save first, so it stays open.

   **Claude Code, opencode and Antigravity** get no note: they keep their own transcript, so step 3 happens at once.
3. **Once that save turn ends** (the state goes to working, then finished again; at once for the agents without a note), Mirador closes the agent the way × does: `TerminalRegistry.close`, which also stops its scope. Its record becomes a sleeping record of the same shape R5a persists (`lastState: "finished"`, its session file or session id), so it is listed under "💤 Dormidos" and a restart keeps it asleep. Despertar resumes its own session through the launch gate (`--session <file>` for Pi, `--resume <id>` for Claude Code, `--session <id>` for opencode, `--conversation <id>` for Antigravity), and Olvidar drops it. The server logs one line per agent: `mirador: the open agent of workspace "<ws>" folder "<rel>" sleeps: …`.
4. **A Pi agent stays open**, with its clock starting again once it is finished, in these cases:
   - the user types into it during the save turn;
   - it waits for the user during the save turn;
   - the note cannot go out (no bridge connected);
   - the save turn does not end within `SAVE_TURN_MS` (15 min).

   Nothing is closed once the server's shutdown began.
