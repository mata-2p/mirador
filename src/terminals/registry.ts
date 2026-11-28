import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { Osc7501Parser, type ProgramStatusEvent } from '../attention/osc7501.ts';
import { scopeCommand, scopeUnit } from './scopes.ts';

/** The subset of node-pty's IPty that the registry needs (a port, so tests can fake it). */
export interface PtyProcess {
  /** The pty child's pid (node-pty has it; with scopes the scope root, as systemd-run execs in place). */
  readonly pid?: number;
  onData(listener: (data: string) => void): void;
  /** node-pty gives the signal that ended the process; 0 or absent when none did. */
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type SpawnFn = (
  file: string,
  args: string[],
  opts: { cwd: string; cols: number; rows: number; env: Record<string, string> },
) => PtyProcess;

/** 'git' runs lazygit in the folder (the tree's git mark), with no command from the client. */
export type TerminalKind = 'agent' | 'shell' | 'git';

export interface TerminalInfo {
  id: string;
  /** Workspace the terminal was opened from, and its folder relative to that workspace root ('' = root). */
  workspaceId: string;
  rel: string;
  cwd: string;
  title: string;
  kind: TerminalKind;
  status: 'running' | 'exited';
  exitCode?: number;
  /** The signal that ended the process (e.g. 9 for an OOM kill), when one did. */
  exitSignal?: number;
  /** True when its scope's unit result shows the system stopped it for lack of memory (scopeOomKilled). */
  oomKilled?: boolean;
  createdAt: string;
  /** Agent terminals opened with a chosen agent: its catalog id. */
  agent?: string;
  /** Size of the pty, which the output was drawn for; a window writes the replay at this size. */
  cols?: number;
  rows?: number;
}

export interface TerminalRequest {
  cwd: string;
  kind: TerminalKind;
  cols: number;
  rows: number;
  workspaceId: string;
  rel: string;
  /** Agent terminals only: words appended after the global agent args, each quoted as one shell word. */
  agentArgs?: string[];
  /** Agent terminals only: the catalog id of the agent chosen for it, kept on its info. */
  agent?: string;
  /**
   * Agent terminals only: the command line of a chosen agent other than the configured one. It runs
   * instead of `agentCommand`, without the global agent args (the configured agent's bridge), with
   * the args addChosenAgentArgs gives its `agent` (its own bridge).
   */
  agentCommand?: string;
}

/** Extra environment variables for a new terminal, e.g. to let the agent report to Mirador. */
export type EnvProvider = (info: TerminalInfo) => Record<string, string>;

export interface TerminalEvent {
  type: 'created' | 'exited' | 'closed';
  info: TerminalInfo;
  /** Only on 'closed', and only when the close had one: 'sleep' is idle sleep (src/terminals/hibernate.ts). */
  reason?: 'sleep';
}

export interface TerminalListener {
  onData(data: string): void;
  /** `info` is the ended terminal's info, with its exit signal and whether memory ran out. */
  onExit(exitCode: number, info?: TerminalInfo): void;
}

export interface RegistryOptions {
  shell: string;
  agentCommand: string;
  /** bash rcfile that sources ~/.bashrc and then runs $MIRADOR_AGENT_COMMAND. */
  agentRcFile: string;
  env: Record<string, string | undefined>;
  /** Max characters of output kept per terminal for re-attaching. */
  scrollbackLimit: number;
  /** Run each terminal in its own systemd user scope `mirador-<kind>-<id>.scope` (src/terminals/scopes.ts). */
  scopes?: boolean;
  /** With scopes: stops scope units and what runs in them (stopScopes in src/terminals/scopes.ts). */
  stopScopes?: (units: string[]) => Promise<unknown>;
  /** With scopes: whether a scope unit was stopped for lack of memory (scopeOomKilled in src/terminals/scopes.ts). */
  oomKilled?: (unit: string) => Promise<boolean>;
}

interface Terminal {
  info: TerminalInfo;
  pty: PtyProcess;
  scrollback: string[];
  scrollbackSize: number;
  /** Escape parser state where the kept scrollback begins; GROUND unless everything was trimmed mid-sequence. */
  scrollbackStart: number;
  /** Characters trimmed past the limit only to leave the sequence the kept scrollback begins in. */
  scrollbackSkipped: number;
  /** Terminal modes in force where the kept scrollback begins, set by the trimmed output. */
  scrollbackModes: ModeTracker;
  listeners: Set<TerminalListener>;
  /** Takes OSC 7501 out of the output before the scrollback and the listeners see it. */
  status: Osc7501Parser;
}

// Just enough of the VT500 parser to know where escape sequences end.
const GROUND = 0;
const ESCAPE = 1;
const ESCAPE_INTERMEDIATE = 2;
const CSI = 3;
const CONTROL_STRING = 4; // OSC, DCS, SOS, PM, APC: ended by BEL or ST
const CONTROL_STRING_ESCAPE = 5;

/** How much output the trim drops to leave an unterminated sequence before it replays from inside it. */
const SEQUENCE_SKIP_LIMIT = 4096;

function nextState(state: number, code: number): number {
  if (code === 0x18 || code === 0x1a) return GROUND; // CAN and SUB cancel any sequence
  switch (state) {
    case GROUND:
      if (code === 0x1b) return ESCAPE;
      if (code === 0x9b) return CSI;
      if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) return CONTROL_STRING;
      return GROUND;
    case ESCAPE:
    case ESCAPE_INTERMEDIATE:
      if (code === 0x1b) return ESCAPE;
      if (code < 0x20) return state; // C0 controls run inside a sequence without ending it
      if (code <= 0x2f) return ESCAPE_INTERMEDIATE;
      if (state === ESCAPE && code === 0x5b) return CSI; // ESC [
      if (state === ESCAPE && (code === 0x5d || code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f)) return CONTROL_STRING; // ESC ] P X ^ _
      return GROUND; // final byte
    case CSI:
      if (code === 0x1b) return ESCAPE;
      return code >= 0x40 && code <= 0x7e ? GROUND : CSI;
    case CONTROL_STRING:
      if (code === 0x07 || code === 0x9c) return GROUND;
      return code === 0x1b ? CONTROL_STRING_ESCAPE : CONTROL_STRING;
    default: // CONTROL_STRING_ESCAPE
      return code === 0x5c ? GROUND : nextState(ESCAPE, code); // ESC \ is ST; any other ESC starts a new sequence
  }
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

// DEC private modes that change how later output is drawn or what input the program gets,
// with their value in a freshly reset terminal. 47, 1047 and 1049 all mean the alternate screen.
const ALT_SCREEN_MODES = [47, 1047, 1049];
const REPLAYED_MODES = new Map([
  [1, false], // application cursor keys
  [7, true], // autowrap
  [25, true], // cursor visible
  [1000, false], // mouse tracking: clicks
  [1002, false], // mouse tracking: drags
  [1003, false], // mouse tracking: any motion
  [1004, false], // focus events
  [1005, false], // mouse encoding: UTF-8
  [1006, false], // mouse encoding: SGR
  [1015, false], // mouse encoding: urxvt
  [2004, false], // bracketed paste
]);

/**
 * Follows the DEC private modes (CSI ? n h / l) that a stream of output sets, so a
 * replay that starts after them can set them again first.
 */
class ModeTracker {
  private state = GROUND;
  private sequence = '';
  private altScreen = false;
  private readonly modes = new Map<number, boolean>();

  feed(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      const previous = this.state;
      this.state = nextState(previous, code);
      if (this.state === CSI && previous !== CSI) this.sequence = '';
      else if (this.state === CSI) this.sequence += text[i];
      else if (previous === CSI && this.state === GROUND) this.apply(this.sequence, text[i]);
      else if (previous === ESCAPE && this.state === GROUND && text[i] === 'c') this.reset(); // RIS
    }
  }

  /** Sequences that put a reset terminal in the tracked modes; '' when they are all at their defaults. */
  preamble(): string {
    let out = this.altScreen ? '\x1b[?1049h' : '';
    for (const [mode, initial] of REPLAYED_MODES) {
      const value = this.modes.get(mode) ?? initial;
      if (value !== initial) out += `\x1b[?${mode}${value ? 'h' : 'l'}`;
    }
    return out;
  }

  private apply(sequence: string, final: string): void {
    if ((final !== 'h' && final !== 'l') || !sequence.startsWith('?')) return;
    const on = final === 'h';
    for (const param of sequence.slice(1).split(';')) {
      const mode = Number(param);
      if (ALT_SCREEN_MODES.includes(mode)) this.altScreen = on;
      else if (REPLAYED_MODES.has(mode)) this.modes.set(mode, on);
    }
  }

  private reset(): void {
    this.altScreen = false;
    this.modes.clear();
  }
}

const LEAKED_VARS = ['PI_CODING_AGENT_DIR', 'ENGRAM_BIN', 'CLAUDECODE', 'TMUX', 'TMUX_PANE'];
const LEAKED_PREFIXES = ['CLAUDE_CODE_', 'MIRADOR_'];

/** POSIX single-quoting: `value` stays one literal word through `eval` or `sh -c`. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The terminal type every terminal gets on top of its environment (also what the agent shell's PATH is read with, src/agents/opencode-version.ts). */
export const TERMINAL_VARS = { TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'mirador' } as const;

/**
 * Removes variables that a parent gentle-shell, Claude Code or tmux session exports,
 * so each terminal starts like a fresh login terminal.
 */
export function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || LEAKED_VARS.includes(key) || LEAKED_PREFIXES.some((p) => key.startsWith(p))) continue;
    clean[key] = value;
  }
  return clean;
}

export class TerminalRegistry {
  private readonly terminals = new Map<string, Terminal>();
  private readonly spawn: SpawnFn;
  private readonly options: RegistryOptions;
  private readonly envProviders: EnvProvider[] = [];
  private readonly agentArgs: string[] = [];
  /** Words for a chosen agent run by its own command line (request.agentCommand), by catalog id. */
  private readonly chosenAgentArgs = new Map<string, string[]>();
  private readonly subscribers = new Set<(event: TerminalEvent) => void>();
  private readonly inputListeners = new Set<(id: string, data: string) => void>();
  private readonly statusListeners = new Set<(id: string, event: ProgramStatusEvent) => void>();
  /** Scope stops started by close() and not finished yet; closeAll() waits for them too. */
  private readonly stopping = new Set<Promise<unknown>>();
  /** True once closeAll() began: the server is shutting down and nothing new starts. */
  private closing = false;

  constructor(spawn: SpawnFn, options: RegistryOptions) {
    this.spawn = spawn;
    this.options = options;
  }

  /** Adds variables to every terminal created from now on. Mirador's own TERM and agent variables win. */
  addEnvProvider(provider: EnvProvider): void {
    this.envProviders.push(provider);
  }

  /**
   * Appends `args` to the agent command of agent terminals created from now on,
   * each quoted as one shell word (the agent rcfile runs the command with `eval`).
   */
  addAgentArgs(args: string[]): void {
    this.agentArgs.push(...args);
  }

  /**
   * Appends `args` to the command line of chosen agent `agent` (a catalog id) when it runs instead
   * of the configured agent (request.agentCommand), before the request's own agentArgs, each quoted
   * as one shell word: that agent's own bridge, as addAgentArgs gives the configured one.
   */
  addChosenAgentArgs(agent: string, args: string[]): void {
    this.chosenAgentArgs.set(agent, [...(this.chosenAgentArgs.get(agent) ?? []), ...args]);
  }

  /** Calls `listener` when a terminal is created, exits or is closed. Returns an unsubscribe function. */
  subscribe(listener: (event: TerminalEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /**
   * Calls `listener` with what is written into a running terminal (keys, pastes,
   * and the terminal's own replies). Returns an unsubscribe function.
   */
  onInput(listener: (id: string, data: string) => void): () => void {
    this.inputListeners.add(listener);
    return () => this.inputListeners.delete(listener);
  }

  /**
   * Calls `listener` with each valid OSC 7501 report (Program Status Protocol, src/attention/osc7501.ts)
   * a terminal's program prints, and each new shell prompt (OSC 133 A), in output order. The OSC 7501
   * sequences themselves never reach scrollback or listeners. Returns an unsubscribe function.
   */
  onStatus(listener: (id: string, event: ProgramStatusEvent) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  create(request: TerminalRequest): TerminalInfo {
    if (this.closing) throw new Error('Mirador is shutting down');
    const { shell, agentCommand, agentRcFile } = this.options;
    const info: TerminalInfo = {
      id: randomUUID(),
      workspaceId: request.workspaceId,
      rel: request.rel,
      cwd: request.cwd,
      title: basename(request.cwd) || request.cwd,
      kind: request.kind,
      status: 'running',
      createdAt: new Date().toISOString(),
      cols: request.cols,
      rows: request.rows,
      ...(request.kind === 'agent' && request.agent ? { agent: request.agent } : {}),
    };
    const env: Record<string, string> = {
      ...cleanEnv(this.options.env),
      ...Object.assign({}, ...this.envProviders.map((provider) => provider({ ...info }))),
      ...TERMINAL_VARS,
    };
    let args = ['-i'];
    if (request.kind === 'agent') {
      args = ['--rcfile', agentRcFile, '-i'];
      env.MIRADOR_AGENT_COMMAND = request.agentCommand
        ? [request.agentCommand, ...[...((request.agent && this.chosenAgentArgs.get(request.agent)) || []), ...(request.agentArgs ?? [])].map(shellQuote)].join(' ')
        : [agentCommand, ...[...this.agentArgs, ...(request.agentArgs ?? [])].map(shellQuote)].join(' ');
    } else if (request.kind === 'git') {
      args = ['-ic', 'lazygit'];
    }
    const command = this.options.scopes ? scopeCommand(scopeUnit(request.kind, info.id), shell, args) : { file: shell, args };
    const pty = this.spawn(command.file, command.args, { cwd: request.cwd, cols: request.cols, rows: request.rows, env });

    const terminal: Terminal = {
      info,
      pty,
      scrollback: [],
      scrollbackSize: 0,
      scrollbackStart: GROUND,
      scrollbackSkipped: 0,
      scrollbackModes: new ModeTracker(),
      listeners: new Set(),
      status: new Osc7501Parser(),
    };
    this.terminals.set(info.id, terminal);

    const deliver = (data: string) => {
      if (!data) return;
      this.remember(terminal, data);
      terminal.listeners.forEach((l) => l.onData(data));
    };
    pty.onData((chunk) => {
      const { output, events } = terminal.status.feed(chunk);
      deliver(output);
      for (const event of events) {
        if (event.type === 'probe') {
          // The terminal's own answer: written straight into the pty, not reported as input.
          if (info.status === 'running') terminal.pty.write(event.reply);
          continue;
        }
        for (const listener of this.statusListeners) {
          try {
            listener(info.id, event);
          } catch (error) {
            console.error('terminal status listener failed:', error);
          }
        }
      }
    });
    pty.onExit(({ exitCode, signal }) => {
      if (this.terminals.get(info.id) !== terminal) return; // closed already: its subscribers heard 'closed'
      deliver(terminal.status.flush()); // the start of a sequence that never ended, unchanged
      info.status = 'exited';
      info.exitCode = exitCode;
      if (signal) info.exitSignal = signal;
      const tell = () => terminal.listeners.forEach((l) => l.onExit(exitCode, { ...info }));
      const lookup = signal && this.options.scopes ? this.options.oomKilled : undefined;
      if (!lookup) {
        tell();
        this.notify('exited', info);
        return;
      }
      // Killed by a signal: the windows hear of it once the journal said whether memory ran out.
      this.notify('exited', info);
      lookup(scopeUnit(info.kind, info.id))
        .then((oom) => {
          if (oom) info.oomKilled = true;
        }, () => undefined)
        .finally(tell);
    });
    this.notify('created', info);
    return info;
  }

  list(): TerminalInfo[] {
    return [...this.terminals.values()].map((t) => t.info);
  }

  get(id: string): TerminalInfo | undefined {
    return this.terminals.get(id)?.info;
  }

  /**
   * Where running terminal `id` runs: the pid of its pty child (its bash, which then runs the agent) and,
   * with scopes, its scope unit (`mirador-<kind>-<id>.scope`). Undefined when it is unknown, has exited
   * or its pid is not known. Only read by idle sleep's background-work check (src/terminals/background-work.ts).
   */
  processOf(id: string): { pid: number; scope: string | null } | undefined {
    const terminal = this.terminals.get(id);
    const pid = terminal?.pty.pid;
    if (!terminal || terminal.info.status !== 'running' || typeof pid !== 'number' || !(pid > 0)) return undefined;
    return { pid, scope: this.options.scopes ? `${scopeUnit(terminal.info.kind, terminal.info.id)}.scope` : null };
  }

  /**
   * The newest output of terminal `id` as plain text, for reading rather than replay:
   * escape sequences, control and format characters removed (line feeds and tabs
   * kept), at most `maxBytes` UTF-8 bytes, never starting on half a character.
   * Undefined for an unknown terminal. Changes nothing.
   */
  tail(id: string, maxBytes: number): string | undefined {
    const terminal = this.terminals.get(id);
    if (!terminal) return undefined;
    let state = terminal.scrollbackStart;
    const kept: string[] = [];
    for (const chunk of terminal.scrollback) {
      let run = -1;
      for (let i = 0; i < chunk.length; i++) {
        const code = chunk.charCodeAt(i);
        const next = nextState(state, code);
        const visible = state === GROUND && next === GROUND && (code === 0x0a || code === 0x09 || (code >= 0x20 && code !== 0x7f && (code < 0x80 || code > 0x9f)));
        if (visible && run < 0) run = i;
        if (!visible && run >= 0) {
          kept.push(chunk.slice(run, i));
          run = -1;
        }
        state = next;
      }
      if (run >= 0) kept.push(chunk.slice(run));
    }
    const text = kept.join('').replace(/\p{Cf}/gu, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
    const bytes = Buffer.from(text);
    if (bytes.length <= maxBytes) return text;
    // Cutting mid-character leaves U+FFFD at the start: drop it.
    return bytes.subarray(bytes.length - maxBytes).toString('utf8').replace(/^\uFFFD+/, '');
  }

  /**
   * Starts streaming a terminal's output to `listener`. `scrollback` is the recent output
   * to replay first, led by the modes (alternate screen, mouse tracking…) that the
   * trimmed older output had set.
   */
  attach(id: string, listener: TerminalListener): { scrollback: string; info: TerminalInfo; detach(): void } {
    const terminal = this.require(id);
    terminal.listeners.add(listener);
    return {
      scrollback: terminal.scrollbackModes.preamble() + terminal.scrollback.join(''),
      info: terminal.info,
      detach: () => terminal.listeners.delete(listener),
    };
  }

  write(id: string, data: string): void {
    const terminal = this.require(id);
    if (terminal.info.status !== 'running') return;
    terminal.pty.write(data);
    for (const listener of this.inputListeners) {
      try {
        listener(id, data);
      } catch (error) {
        console.error('terminal input listener failed:', error);
      }
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const terminal = this.require(id);
    if (terminal.info.status !== 'running') return;
    terminal.pty.resize(cols, rows);
    terminal.info.cols = cols;
    terminal.info.rows = rows;
  }

  /**
   * Closes terminal `id` (× in a tab): hangs up its process and forgets it. With scopes, also
   * stops its scope, running or exited, without waiting for the stop: a hung-up agent that
   * outlives the hangup (pi shuts down gracefully on SIGHUP) or a child it left behind would
   * otherwise keep running, untracked. `reason` ('sleep': idle sleep) goes with the 'closed' event.
   */
  close(id: string, reason?: 'sleep'): void {
    const terminal = this.forget(id, reason);
    const { stopScopes } = this.options;
    if (!this.options.scopes || !stopScopes) return;
    const stop = stopScopes([scopeUnit(terminal.info.kind, terminal.info.id)]).catch(() => undefined);
    this.stopping.add(stop);
    void stop.finally(() => this.stopping.delete(stop));
  }

  /**
   * Closes every terminal; from now on create() refuses. With scopes, also stops the scope of
   * each one, running or exited, and resolves once they and the stops close() started are done.
   */
  async closeAll(): Promise<void> {
    this.closing = true;
    const units = [...this.terminals.values()].map(({ info }) => scopeUnit(info.kind, info.id));
    for (const id of [...this.terminals.keys()]) this.forget(id);
    const pending = [...this.stopping];
    if (this.options.scopes && this.options.stopScopes && units.length > 0) pending.push(this.options.stopScopes(units));
    await Promise.all(pending);
  }

  private forget(id: string, reason?: 'sleep'): Terminal {
    const terminal = this.require(id);
    this.terminals.delete(id);
    if (terminal.info.status === 'running') terminal.pty.kill();
    this.notify('closed', terminal.info, reason);
    return terminal;
  }

  private notify(type: TerminalEvent['type'], info: TerminalInfo, reason?: 'sleep'): void {
    for (const listener of this.subscribers) {
      try {
        listener({ type, info: { ...info }, ...(reason ? { reason } : {}) });
      } catch (error) {
        console.error(`terminal ${type} listener failed:`, error);
      }
    }
  }

  private require(id: string): Terminal {
    const terminal = this.terminals.get(id);
    if (!terminal) throw new Error(`unknown terminal: ${id}`);
    return terminal;
  }

  /**
   * Keeps the newest output within the limit. The dropped text is run through
   * the escape parser so the replay starts outside any escape sequence and
   * never on the second half of a surrogate pair, and through the mode tracker
   * so the replay can restore the modes it set. A sequence that never ends (an
   * OSC title without its terminator) stops being skipped after
   * SEQUENCE_SKIP_LIMIT characters, so it cannot empty the replay.
   */
  private remember(terminal: Terminal, data: string): void {
    terminal.scrollback.push(data);
    terminal.scrollbackSize += data.length;
    let excess = terminal.scrollbackSize - this.options.scrollbackLimit;
    let state = terminal.scrollbackStart;
    if (excess <= 0 && state === GROUND) return;
    let skipped = terminal.scrollbackSkipped;
    while (terminal.scrollback.length > 0) {
      const first = terminal.scrollback[0];
      let cut = 0;
      while (cut < first.length) {
        const code = first.charCodeAt(cut);
        if (excess <= 0 && !isLowSurrogate(code)) {
          if (state === GROUND) break;
          if (skipped >= SEQUENCE_SKIP_LIMIT) {
            state = GROUND;
            break;
          }
          skipped++;
        }
        state = nextState(state, code);
        cut++;
        excess--;
      }
      terminal.scrollbackSize -= cut;
      terminal.scrollbackModes.feed(first.slice(0, cut));
      if (cut < first.length) {
        terminal.scrollback[0] = first.slice(cut);
        break;
      }
      terminal.scrollback.shift();
    }
    terminal.scrollbackStart = state;
    terminal.scrollbackSkipped = state === GROUND ? 0 : skipped;
  }
}
