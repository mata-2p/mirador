import { isTyping, type AgentAttentionState, type AttentionStore } from '../attention/store.ts';
import { ownerNameFrom } from '../config.ts';
import type { BackgroundWork } from './background-work.ts';
import type { OpenAgents, Schedule } from './open-agents.ts';
import type { TerminalRegistry } from './registry.ts';

/**
 * Idle sleep: an open agent that can resume its session (its catalog entry has a
 * `resume` argv: Pi, Claude Code, opencode, Antigravity) whose attention state has been `finished` for
 * `idleMs` (Settings, config `idleSleep` and `idleSleepMinutes`, else `idleSleepHours`; 4 h by default,
 * 0 = off; setIdleMs() changes it while Mirador runs) with nothing else going on goes to sleep, so the
 * agent and its MCP servers stop using memory. Agents without a resume argv (Codex, Gemini CLI, Kimi)
 * never sleep from idleness.
 *
 * 1. Its idle clock starts when its state becomes finished and restarts when the user types into it
 *    (terminal replies such as focus reports do not count). Any other state stops it: an agent that
 *    works, waits for the user (a blocked or prompt token, OSC 7501 blocked), stopped with an error
 *    (OSC 7501 error, which survives the prompt its bash draws next) or whose state is unknown never
 *    sleeps.
 * 2. When the clock runs out, an agent with an open gentle-shell Todo, or that the night shift is
 *    deciding about or left for the user (AttentionStore.idleHold), or with no recorded session to
 *    resume (OpenAgents.canSleep), stays open and its clock starts again. So does one that left work
 *    running (`background`, src/terminals/background-work.ts: an orphan in its scope, or a live process
 *    below a shell it started; its own MCP servers and helpers do not count): it stays awake with the
 *    program's name as its reason (awake(), on its card through GET /api/terminals, never in the inbox,
 *    so never in a browser notification or on the phone) and one log line with that name and its PID
 *    per reason, not per check. While it shows, the reason is read again every BACKGROUND_WATCH_MS, so
 *    it leaves once the program ends; the clock then puts the agent to sleep at its next tick.
 * 3. A Pi agent (resume key 'file') gets sleepNote() through the night shift's note path
 *    (NightService.sendNote), framed as a note from Mirador and logged as Mirador's; without that path
 *    (no `sendNote`) it stays open. Once that save turn ends (working, then finished again) it is closed
 *    the way × closes it (TerminalRegistry.close, which also stops its scope) and its record becomes a
 *    sleeping record (OpenAgents.sleep): listed under "💤 Dormidos", woken with its session through the
 *    gate. If the user types into it, it waits for them, or the turn does not end within `saveTurnMs`, it
 *    stays open and its clock starts again once it is finished.
 * 4. Any other agent (resume key 'id': its hooks report the session id it resumes) has no save note: it
 *    is closed the same way at once and leaves the same sleeping record, woken with `--resume`,
 *    `--session` or `--conversation` and its own session id.
 */

/** While an agent is kept awake by background work, how often its reason is read again. */
export const BACKGROUND_WATCH_MS = 60_000;

/** How long the save turn may take before the agent is left open. */
export const SAVE_TURN_MS = 15 * 60_000;

/** The save note for `owner` (config `ownerName`, already resolved by ownerNameFrom; unset: "the user"). */
export function sleepNote(owner: string): string {
  return (
    'This session has been idle for a long time, so Mirador will close it to free memory; ' +
    `it resumes this same session when ${owner} wakes it. Save your session summary now with ` +
    'mem_session_summary (Goal, Instructions, Discoveries, Accomplished, Next Steps, Relevant Files), ' +
    'then end your turn without starting other work.'
  );
}

/** What the agent receives for the save note: who sends it, then the note. */
export function sleepNoteText(text: string): string {
  return `Note from Mirador, which puts idle agents to sleep:\n\n${text}`;
}

export interface IdleSleepOptions {
  registry: Pick<TerminalRegistry, 'subscribe' | 'onInput' | 'get' | 'close'>;
  attention: Pick<AttentionStore, 'agentState' | 'onAgentState' | 'idleHold'>;
  /** `resumeKey` absent: every agent saves through the note first, as Pi does. */
  openAgents: Pick<OpenAgents, 'canSleep' | 'sleep'> & Partial<Pick<OpenAgents, 'resumeKey'>>;
  /**
   * NightService.sendNote: delivers `frame(text)` to the agent's bridge; `from` 'mirador' logs it as Mirador's note.
   * Absent (no night service): Pi agents cannot save first, so they do not sleep from idleness; the others still do.
   */
  sendNote?(terminalId: string, text: string, noteId: string, frame: (text: string) => string, from?: 'user' | 'mirador'): Promise<{ sent: boolean; reason?: string }>;
  /** How long an agent stays finished before it sleeps; 0 turns idle sleep off. setIdleMs() changes it. */
  idleMs: number;
  saveTurnMs?: number;
  /** Timer for the idle clock and the save turn; tests replace it. The default never keeps the process alive. */
  schedule?: Schedule;
  log?: (line: string) => void;
  /** Config `ownerName`, read before every save note; unset, not valid or unreadable = "the user". */
  ownerName?: () => unknown;
  /**
   * The work agent `id` left running, read when its clock runs out (backgroundCheck in
   * src/terminals/background-work.ts); null when there is none. Absent: not checked, as before #115.
   */
  background?: (id: string) => Promise<BackgroundWork | null>;
}

interface Agent {
  /** Cancels the idle clock while it runs. */
  cancelIdle: (() => void) | null;
  /** From the save note until the agent is closed or stays open. */
  saving: { cancelTimeout: () => void; turnStarted: boolean } | null;
  /** The background work that keeps it awake, shown as its reason; null when none does. */
  awake: BackgroundWork | null;
  /** Cancels the next read of that reason. */
  cancelWatch: (() => void) | null;
  /** While its clock's background check runs (typing then restarts the clock). */
  checking: boolean;
  /** Counts the background checks started; an answer that is not the latest one is dropped. */
  check: number;
}

const unrefSchedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

export class IdleSleep {
  private readonly options: IdleSleepOptions;
  private readonly schedule: Schedule;
  private readonly saveTurnMs: number;
  private readonly log: (line: string) => void;
  private readonly agents = new Map<string, Agent>();
  private readonly stops: Array<() => void> = [];
  private readonly checks = new Set<Promise<void>>();
  private idleMs: number;

  constructor(options: IdleSleepOptions) {
    this.options = options;
    this.idleMs = options.idleMs;
    this.schedule = options.schedule ?? unrefSchedule;
    this.saveTurnMs = options.saveTurnMs ?? SAVE_TURN_MS;
    this.log = options.log ?? ((line: string) => console.error(line));
  }

  /** Follows the agents' states and the user's typing; while idle sleep is off no clock runs. */
  start(): void {
    if (this.stops.length) return;
    const { registry, attention } = this.options;
    this.stops.push(
      registry.subscribe(({ type, info }) => {
        if (type !== 'created') this.forget(info.id);
      }),
      registry.onInput((id, data) => {
        if (isTyping(data)) this.typed(id);
      }),
      attention.onAgentState((id, state) => this.changed(id, state)),
    );
  }

  /**
   * Settings changed the threshold, or turned idle sleep off (0), while Mirador runs. Off: no clock runs and
   * a save turn under way no longer closes its agent, which stays open. On: every running agent that is
   * finished counts the new threshold from now; a save turn under way goes on.
   */
  setIdleMs(ms: number): void {
    this.idleMs = ms;
    const { registry, attention } = this.options;
    for (const [id, agent] of this.agents) {
      if (!(ms > 0)) {
        agent.saving?.cancelTimeout();
        agent.saving = null;
        this.disarm(agent);
      } else if (!agent.saving && registry.get(id)?.status === 'running' && attention.agentState(id) === 'finished') {
        this.arm(id, agent);
      }
    }
  }

  /** Why running agent `id` stays awake: the name of the program it left running (never its arguments), or null. */
  awake(id: string): { name: string } | null {
    const work = this.agents.get(id)?.awake;
    return work ? { name: work.name } : null;
  }

  /** Resolves once every background check under way has been read and acted on. */
  async checked(): Promise<void> {
    while (this.checks.size) await Promise.all([...this.checks]);
  }

  /** The server stops: no clock runs and nothing more is closed. */
  stop(): void {
    for (const stop of this.stops.splice(0)) stop();
    for (const id of [...this.agents.keys()]) this.forget(id);
  }

  private changed(id: string, state: AgentAttentionState): void {
    const agent = this.agent(id);
    if (!agent.saving) {
      if (state === 'finished') this.arm(id, agent);
      else this.disarm(agent);
      return;
    }
    if (state === 'working') agent.saving.turnStarted = true;
    else if (state === 'finished' && agent.saving.turnStarted) this.saved(id, agent);
    // Waiting for the user, or silent: it stays open.
    else this.stayOpen(id, agent);
  }

  private typed(id: string): void {
    const agent = this.agents.get(id);
    if (agent?.saving) this.stayOpen(id, agent);
    else if (agent?.cancelIdle || agent?.checking) this.arm(id, agent);
  }

  private arm(id: string, agent: Agent): void {
    agent.cancelIdle?.();
    agent.cancelIdle = null;
    if (!(this.idleMs > 0)) return;
    agent.cancelIdle = this.schedule(() => {
      agent.cancelIdle = null;
      this.due(id, agent);
    }, this.idleMs);
  }

  /** Its clock stops, and so does its reason: it shows only for a finished agent that Mirador keeps awake. */
  private disarm(agent: Agent): void {
    agent.cancelIdle?.();
    agent.cancelIdle = null;
    agent.awake = null;
    agent.cancelWatch?.();
    agent.cancelWatch = null;
    agent.checking = false;
    agent.check++;
  }

  /**
   * The idle clock ran out: a Pi agent is asked to save, any other is put to sleep at once, unless
   * something keeps it awake.
   */
  private due(id: string, agent: Agent): void {
    if (!this.stillDue(id)) return;
    if (this.keepsAwake(id)) return this.arm(id, agent);
    const background = this.options.background;
    if (!background) return this.sleepNow(id, agent);
    const token = ++agent.check;
    agent.checking = true;
    this.track(background(id).catch(() => null).then((work) => {
      if (agent.check !== token || this.agents.get(id) !== agent) return;
      agent.checking = false;
      // Typed into, closed, no longer finished or switched off meanwhile: its clock already says what follows.
      if (agent.cancelIdle || agent.saving || !this.stillDue(id)) return;
      if (work) return this.holdAwake(id, agent, work);
      agent.awake = null;
      this.sleepNow(id, agent);
    }));
  }

  private stillDue(id: string): boolean {
    const { registry, attention } = this.options;
    return this.idleMs > 0 && registry.get(id)?.status === 'running' && attention.agentState(id) === 'finished';
  }

  /** Keeps a background check under way for checked(); a check that fails counts as finding nothing (see the callers). */
  private track(run: Promise<void>): void {
    const done: Promise<void> = run.catch((error) => console.error('mirador: idle sleep after a background check failed:', error)).finally(() => this.checks.delete(done));
    this.checks.add(done);
  }

  /** Background work keeps the agent awake: its reason shows, its clock starts again and the reason is read again. */
  private holdAwake(id: string, agent: Agent, work: BackgroundWork): void {
    this.showAwake(id, agent, work);
    this.arm(id, agent);
    this.watch(id, agent);
  }

  /** One log line per reason: the program's name and its PID, only when it differs from the last one. */
  private showAwake(id: string, agent: Agent, work: BackgroundWork): void {
    const same = agent.awake?.pid === work.pid && agent.awake?.name === work.name;
    agent.awake = work;
    if (same) return;
    const info = this.options.registry.get(id);
    const where = work.kind === 'orphan' ? 'in its scope, outside its process tree' : 'below a shell it started';
    this.log(`mirador: the open agent of workspace ${JSON.stringify(info?.workspaceId)} folder ${JSON.stringify(info?.rel)} stays awake: ${work.name} (PID ${work.pid}) is still running ${where}; idle sleep checks again in ${this.span()}`);
  }

  /**
   * Reads the reason again in BACKGROUND_WATCH_MS: it changes with the program, and leaves when nothing runs.
   * While the clock's own check is under way (the two land in the same tick with a 1 min threshold) this read
   * waits for the next round: starting one would drop the clock's answer, and with it the clock, so the
   * agent would stay open once the work ended. The clock's answer shows the reason again or sleeps.
   */
  private watch(id: string, agent: Agent): void {
    agent.cancelWatch?.();
    agent.cancelWatch = this.schedule(() => {
      agent.cancelWatch = null;
      const background = this.options.background;
      if (!agent.awake || !background) return;
      if (agent.checking) return this.watch(id, agent);
      const token = ++agent.check;
      this.track(background(id).catch(() => null).then((work) => {
        if (agent.check !== token || this.agents.get(id) !== agent || !agent.awake) return;
        // The card line goes away; the clock decides when the agent sleeps.
        if (!work) return void (agent.awake = null);
        this.showAwake(id, agent, work);
        this.watch(id, agent);
      }));
    }, BACKGROUND_WATCH_MS);
  }

  /** The clock ran out and nothing keeps the agent awake. */
  private sleepNow(id: string, agent: Agent): void {
    const { openAgents } = this.options;
    // Hook agents report the session id they resume with and keep their own transcript: nothing to save first.
    if (openAgents.resumeKey?.(id) === 'id') return this.putToSleep(id, agent, '');
    const sendNote = this.options.sendNote;
    // Without the night shift's note path a Pi agent cannot save its summary: it stays open.
    if (!sendNote) return this.arm(id, agent);
    agent.saving = { cancelTimeout: this.schedule(() => this.stayOpen(id, agent), this.saveTurnMs), turnStarted: false };
    sendNote(id, sleepNote(this.owner()), '', sleepNoteText, 'mirador').then((result) => {
      if (!result.sent) this.stayOpen(id, agent);
    }, () => this.stayOpen(id, agent));
  }

  /**
   * What keeps a finished agent awake when its clock runs out: an open Todo or the night shift's hold
   * (AttentionStore.idleHold), or nothing recorded to resume (OpenAgents.canSleep). The background-work
   * check (`background`, asynchronous) comes after these, in due().
   */
  private keepsAwake(id: string): boolean {
    return this.options.attention.idleHold(id) !== null || !this.options.openAgents.canSleep(id);
  }

  /** The save turn ended: the agent goes to sleep unless something keeps it awake. */
  private saved(id: string, agent: Agent): void {
    agent.saving?.cancelTimeout();
    agent.saving = null;
    if (this.options.attention.idleHold(id) !== null) return this.arm(id, agent);
    this.putToSleep(id, agent, ' and it saved its session');
  }

  /** Closes the agent the way × does and leaves its sleeping record (OpenAgents.sleep); else its clock starts again. */
  private putToSleep(id: string, agent: Agent, saved: string): void {
    const { registry, openAgents } = this.options;
    if (!openAgents.sleep(id)) return this.arm(id, agent);
    const info = registry.get(id);
    // 'sleep': the windows showing it say it went to sleep (src/server.ts {t:'c', reason:'sleep'}).
    registry.close(id, 'sleep');
    this.log(`mirador: the open agent of workspace ${JSON.stringify(info?.workspaceId)} folder ${JSON.stringify(info?.rel)} sleeps: its turn had been finished for ${this.span()}${saved}; it reopens when woken in Mirador`);
  }

  /** The threshold as the log says it: "4 h", "30 min". */
  private span(): string {
    const minutes = Math.round((this.idleMs / 60_000) * 10) / 10;
    return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
  }

  /** Back to the idle clock: it starts again now when the agent is finished, else once it is. */
  private stayOpen(id: string, agent: Agent): void {
    if (!agent.saving || !this.agents.has(id)) return;
    agent.saving.cancelTimeout();
    agent.saving = null;
    if (this.options.attention.agentState(id) === 'finished') this.arm(id, agent);
  }

  private agent(id: string): Agent {
    let agent = this.agents.get(id);
    if (!agent) {
      agent = { cancelIdle: null, saving: null, awake: null, cancelWatch: null, checking: false, check: 0 };
      this.agents.set(id, agent);
    }
    return agent;
  }

  /** Config `ownerName` as the save note uses it; "the user" when unset, not valid or unreadable. */
  private owner(): string {
    try {
      return ownerNameFrom(this.options.ownerName?.());
    } catch {
      return ownerNameFrom(undefined);
    }
  }

  private forget(id: string): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    this.disarm(agent);
    agent.saving?.cancelTimeout();
    agent.saving = null;
    this.agents.delete(id);
  }
}

/** The server's idle sleep, kept next to its terminal registry (like the launch gate), for the Settings route. */
const instances = new WeakMap<object, IdleSleep>();

export function provideIdleSleep(registry: object, idle: IdleSleep): void {
  instances.set(registry, idle);
}

export function idleSleepOf(registry: object): IdleSleep | undefined {
  return instances.get(registry);
}
