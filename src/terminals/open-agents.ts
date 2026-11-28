import { randomUUID } from 'node:crypto';
import { access, chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { AGENTS, SESSION_ID, agentFor, type AgentEntry, type AgentLaunch } from '../agents/catalog.ts';
import type { AgentAttentionState } from '../attention/store.ts';
import { stateDir } from '../config.ts';
import type { LaunchGate, LaunchRun } from '../system/memory-gate.ts';
import type { TerminalInfo, TerminalRegistry } from './registry.ts';
import { scopeUnit, stopScopes } from './scopes.ts';

/**
 * Open agents: while Mirador runs, every
 * open agent terminal has a record in `<stateDir>/open-agents.json` (written whole and
 * renamed into place, mode 0600), so it survives a crash, an OOM kill or `kill -9`.
 *
 * - A record goes at once when the user closes the agent, and EXIT_GRACE_MS after the agent
 *   exits by itself with a code below 128, so a server killed in the same moment (an OOM
 *   kill takes the whole cgroup, agents possibly first) still finds it at the next start.
 *   An agent ended by a signal, or with a code of 128 or more, keeps its record until
 *   the user closes its terminal. The server's own shutdown (keep(), then closeAll())
 *   leaves every record for the next start.
 * - The gentle-shell bridge reports the agent's pi session file (src/night/channel.ts);
 *   it is kept only when it is an absolute path to an existing `.jsonl` regular file.
 * - At startup, restore() reopens each record in its folder, one after another, passing
 *   `--session <file>` when that file still exists and no earlier record of this restore
 *   continues it (two agents never share one session); a record whose workspace or folder
 *   no longer resolves is dropped and logged. The new terminals replace the old records;
 *   records not reopened yet stay on disk until they are, or until an agent opens in their
 *   folder another way (by hand, a batch), which replaces one of them. Before reopening
 *   anything it ends what still runs of the previous run's agents (endPrevious: their systemd
 *   scopes), and an agent that still runs after that is not reopened, so a session never runs
 *   twice.
 * - Lazy restore: each record keeps its agent's last
 *   attention state (`lastState`, from the attention store; written at once when it would reopen
 *   the agent and STATE_SAVE_MS after a change to finished, so a crash knows it too; absent while
 *   unknown and in older files). At the next start only the agents that were working, waiting, stopped
 *   with an error (`error`, OSC 7501: it waits for the user like a blocked one) or unknown reopen; the ones
 *   that had finished their turn sleep: no process, no scope, their record
 *   and session file kept, across further restarts, until the user wakes them (wake(): the same
 *   reopening, through the gate) or forgets them. An agent opened another way in a sleeping
 *   agent's folder replaces that sleeping record too.
 * - Idle sleep (src/terminals/hibernate.ts): an open agent idle for hours is put to sleep
 *   while Mirador runs (sleep()): its live record becomes a sleeping record of the same shape, so a
 *   restart keeps it asleep and a wake resumes its session. Only an agent whose catalog entry has a
 *   resume argv and whose record holds what that argv needs (a session file for pi, a session id for
 *   claude-code, opencode and antigravity) can sleep (canSleep, resumeKey).
 * - Chosen agents: an agent opened with a catalog id keeps it in its
 *   record (`agent`) and reopens with that agent; only one with a verified resume continues its
 *   session, the others start fresh. A record without an id (older files, the configured agent opened
 *   without one) reopens the configured agentCommand exactly as before; one whose id Mirador no longer
 *   knows is dropped and logged.
 * - Hook sessions: an agent whose hooks report its session id (claude-code, opencode, antigravity)
 *   keeps it in its record (`session`, a SESSION_ID), and a restore or wake continues it with that id instead
 *   of a session file; an agent with neither starts fresh.
 * - The file names the config that wrote it: a Mirador started with another config (a
 *   second instance, a test server) neither restores nor rewrites it; records of a config
 *   that no longer exists are discarded.
 */

export interface OpenAgentRecord {
  /** The terminal id in the run that recorded it. */
  id: string;
  workspaceId: string;
  rel: string;
  cwd: string;
  cols: number;
  rows: number;
  /** The agent's pi session file, once its bridge reported a valid one. */
  sessionFile: string | null;
  createdAt: string;
  /** Its last attention state (lazy restore); absent while unknown. */
  lastState?: Exclude<AgentAttentionState, 'unknown'>;
  /** The catalog id of the agent chosen for it; absent for the configured agentCommand. */
  agent?: string;
  /** The session id its hooks reported (claude-code), once valid; absent for agents that report a file. */
  session?: string;
}

/** A sleeping agent as GET /api/terminals/sleeping lists it. */
export interface SleepingAgent {
  /** Its record id: the terminal id of the run that last recorded it. */
  id: string;
  workspaceId: string;
  rel: string;
  createdAt: string;
  /** Whether its agent can continue what was recorded (a session file or id), so waking it continues that session. */
  resumable: boolean;
  /** The catalog id of the agent chosen for it; absent for the configured agentCommand. */
  agent?: string;
}

/** What restore() needs from a resolved folder (WorkspaceStore.resolve). */
export interface RestoreFolder {
  workspace: { id: string };
  rel: string;
  path: string;
}

export interface RestoreOptions {
  registry: Pick<TerminalRegistry, 'create'>;
  resolveFolder(workspaceId: string, rel: string): Promise<RestoreFolder>;
  /**
   * The agent args that continue `sessionFile` in the record's agent (`agent`, its catalog id;
   * absent: the configured agentCommand); [] when that agent cannot take them.
   */
  sessionArgs(sessionFile: string, agent?: string): string[];
  /** How a record's chosen agent starts (agentLaunch in src/agents/catalog.ts); null for an id Mirador no longer knows. */
  agentLaunch?(agent: string): AgentLaunch | null;
  /**
   * Ends whatever still runs of these records' agents from the previous run (a server that
   * crashed leaves them hung up, not always gone) and resolves with the ids of those that
   * still run, which are not reopened.
   */
  endPrevious?(records: OpenAgentRecord[]): Promise<string[]>;
  /** Pause between two reopened agents, so they do not all start at once. */
  delayMs?: number;
  sleep?(ms: number): Promise<void>;
  /** The server's launch gate (src/system/memory-gate.ts): batches that settle, and enough memory. */
  gate?: LaunchGate;
  /**
   * What a record of agent `agent` (its catalog id; absent: the configured agentCommand) waits for before it
   * starts, null when it may start now: the server's opencode version and bridge (#124), for opencode records only
   * (asking begins the read). The restore and a wake wait for it before they take their launch run, never inside one.
   */
  ready?(agent?: string): Promise<unknown> | null;
}

/** Pause between two agents Mirador opens in a row: at restore and in a batch (src/terminals/open-many.ts). */
export const RESTORE_DELAY_MS = 2000;
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** How long a cleanly exited agent keeps its record, in case the server dies right after. */
export const EXIT_GRACE_MS = 5000;
/** How long after an agent's state changes its record is written: one write for a burst of changes. */
export const STATE_SAVE_MS = 1000;
/** The states a record keeps; any other (unknown, or a state an older Mirador does not know) reopens. */
const STATES = new Set<string>(['working', 'waiting', 'finished', 'error']);

/** Runs `run` after `ms`; returns a function that cancels it. */
export type Schedule = (run: () => void, ms: number) => () => void;

export interface OpenAgentsOptions {
  /** The absolute config path of this Mirador: the records belong to it. */
  owner: string;
  log?: (line: string) => void;
  exitGraceMs?: number;
  stateSaveMs?: number;
  /** Timer for the exit grace and the state write; tests replace it. The default never keeps the process alive. */
  schedule?: Schedule;
  /** Config `agentCommand`: the agent a record without a catalog id runs (idle sleep: canSleep); unset = the config default, gentle-shell. */
  agentCommand?: string;
}

const unrefSchedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
};
const MAX_SESSION_PATH = 4096;
const MIN_SIZE = 2;
const MAX_SIZE = 1000;

export function openAgentsPath(env = process.env): string {
  return join(stateDir(env), 'open-agents.json');
}

/**
 * `value` when it is an absolute path (so never an option) ending in `.jsonl`, without
 * control characters, naming an existing regular file (not a symlink); otherwise null.
 */
export async function validSessionFile(value: unknown): Promise<string | null> {
  if (typeof value !== 'string' || value.length > MAX_SESSION_PATH || !isAbsolute(value) || !value.endsWith('.jsonl')) return null;
  if (/\p{Cc}/u.test(value)) return null;
  try {
    return (await lstat(value)).isFile() ? value : null;
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const size = (value: unknown, fallback: number): number => (Number.isInteger(value) && (value as number) >= MIN_SIZE && (value as number) <= MAX_SIZE ? (value as number) : fallback);

/** A record as stored, or null when its identifying fields are missing. */
function readRecord(value: unknown): OpenAgentRecord | null {
  if (!isRecord(value)) return null;
  const { id, workspaceId, rel, cwd, sessionFile, createdAt } = value;
  if (typeof id !== 'string' || typeof workspaceId !== 'string' || typeof rel !== 'string' || typeof cwd !== 'string') return null;
  return {
    id,
    workspaceId,
    rel,
    cwd,
    cols: size(value.cols, 100),
    rows: size(value.rows, 30),
    sessionFile: typeof sessionFile === 'string' ? sessionFile : null,
    createdAt: typeof createdAt === 'string' ? createdAt : '',
    // An older file has no state, and an unreadable one counts as unknown: both reopen.
    ...(typeof value.lastState === 'string' && STATES.has(value.lastState) ? { lastState: value.lastState as OpenAgentRecord['lastState'] } : {}),
    // Older files have no agent: the configured agentCommand.
    ...(typeof value.agent === 'string' ? { agent: value.agent } : {}),
    ...(validSessionId(value.session) ? { session: value.session as string } : {}),
  };
}

/** `value` when it is a session id an agent's hooks may report (SESSION_ID), else null. */
export function validSessionId(value: unknown): string | null {
  return typeof value === 'string' && SESSION_ID.test(value) ? value : null;
}

const exists = (path: string) => access(path).then(() => true, () => false);

export class OpenAgents {
  private readonly file: string;
  private readonly owner: string;
  private readonly log: (line: string) => void;
  /** False when the file belongs to another config: then nothing is restored or written. */
  private readonly active: boolean;
  /** Records of the previous run not reopened yet. */
  private pending: OpenAgentRecord[];
  /** Records left asleep (lazy restore): no process until woken or forgotten. */
  private sleepers: OpenAgentRecord[] = [];
  /** Sleepers a wake is reopening now: not listed, not woken twice. */
  private readonly waking = new Set<OpenAgentRecord>();
  /** How restore() reopens agents: a wake reopens the same way. */
  private reopenWith: RestoreOptions | null = null;
  private readonly stateSaveMs: number;
  /** Cancels the state write waiting for STATE_SAVE_MS, while one waits. */
  private cancelStateSave: (() => void) | null = null;
  private readonly live = new Map<string, OpenAgentRecord>();
  private kept = false;
  /** True while restore() creates an agent: that agent replaces its own record, not another one. */
  private reopening = false;
  /** Ids of pending records whose agent still ran at restore(): kept so the next start stops it, never replaced. */
  private stillRunning = new Set<string>();
  private writes: Promise<void> = Promise.resolve();
  private readonly exitGraceMs: number;
  private readonly schedule: Schedule;
  /** Removals of cleanly exited agents waiting for their grace delay, by terminal id. */
  private readonly leaving = new Map<string, () => void>();
  private readonly agentCommand: string;

  private constructor(file: string, options: OpenAgentsOptions, log: (line: string) => void, active: boolean, pending: OpenAgentRecord[]) {
    this.file = file;
    this.owner = options.owner;
    this.log = log;
    this.active = active;
    this.pending = pending;
    this.exitGraceMs = options.exitGraceMs ?? EXIT_GRACE_MS;
    this.stateSaveMs = options.stateSaveMs ?? STATE_SAVE_MS;
    this.schedule = options.schedule ?? unrefSchedule;
    this.agentCommand = options.agentCommand ?? 'gentle-shell';
  }

  /** Reads the records `owner` (the absolute config path) left; never throws for a bad file. */
  static async load(file: string, options: OpenAgentsOptions): Promise<OpenAgents> {
    const log = options.log ?? ((line: string) => console.error(line));
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log(`mirador: cannot read ${file}: ${(error as Error).message}; no agents are restored`);
      return new OpenAgents(file, options, log, true, []);
    }
    let saved: unknown;
    try {
      saved = JSON.parse(text);
    } catch {
      saved = null;
    }
    if (!isRecord(saved) || typeof saved.owner !== 'string' || !Array.isArray(saved.agents)) {
      log(`mirador: cannot read ${file}: not an open-agents file; no agents are restored`);
      return new OpenAgents(file, options, log, true, []);
    }
    const records = saved.agents.map(readRecord).filter((record) => record !== null);
    if (saved.owner !== options.owner) {
      if (await exists(saved.owner)) {
        log(`mirador: ${file} belongs to ${saved.owner}, not ${options.owner}; its agents are not restored and it is left as is`);
        return new OpenAgents(file, options, log, false, []);
      }
      log(`mirador: discarded ${records.length} record(s) of ${file}: their config ${saved.owner} no longer exists`);
      return new OpenAgents(file, options, log, true, []);
    }
    return new OpenAgents(file, options, log, true, records);
  }

  /** Records agent terminals of `registry` as they open, and forgets them as they close or exit. */
  track(registry: Pick<TerminalRegistry, 'subscribe'>): () => void {
    return registry.subscribe(({ type, info }) => {
      if (info.kind !== 'agent' || this.kept) return;
      if (type === 'created') {
        this.live.set(info.id, recordOf(info));
        // An agent opened in a folder whose record the restore left (Pausar, low memory) replaces it,
        // so the next start does not reopen that folder a second time next to it; else it replaces a
        // sleeping agent of that folder (its own session file stays where pi keeps it).
        if (!this.reopening) {
          const here = (record: OpenAgentRecord) => record.workspaceId === info.workspaceId && record.rel === info.rel;
          const replaced = this.pending.find((record) => here(record) && !this.stillRunning.has(record.id)) ?? this.sleepers.find(here);
          if (replaced) this.drop(replaced);
        }
        this.save();
      } else if (type === 'closed') {
        this.remove(info.id);
      } else if (this.live.has(info.id) && !info.exitSignal && (info.exitCode ?? 0) < 128) {
        // A clean exit: removed after the grace delay. Killed by a signal: kept until closed.
        this.leaving.set(info.id, this.schedule(() => this.remove(info.id), this.exitGraceMs));
      }
    });
  }

  private remove(terminalId: string): void {
    this.leaving.get(terminalId)?.();
    this.leaving.delete(terminalId);
    if (this.kept || !this.live.delete(terminalId)) return;
    this.save();
  }

  /** Keeps `sessionFile` for agent `terminalId` when it is valid (validSessionFile). True when kept. */
  async recordSession(terminalId: string, sessionFile: unknown): Promise<boolean> {
    if (!this.live.has(terminalId)) return false;
    const valid = await validSessionFile(sessionFile);
    const record = this.live.get(terminalId);
    if (!valid || !record) return false;
    if (record.sessionFile !== valid) {
      record.sessionFile = valid;
      this.save();
    }
    return true;
  }

  /** Keeps `session` as agent `terminalId`'s session id when it is valid (validSessionId). True when kept. */
  recordSessionId(terminalId: string, session: unknown): boolean {
    const record = this.live.get(terminalId);
    const valid = validSessionId(session);
    if (this.kept || !record || !valid) return false;
    if (record.session !== valid) {
      record.session = valid;
      this.save();
    }
    return true;
  }

  /**
   * Keeps `state` as agent `terminalId`'s last attention state. A state that reopens the agent at the
   * next start (working, waiting, error, unknown) is written at once, so a crash right after it never leaves
   * the agent asleep; `finished` is written STATE_SAVE_MS later. False for
   * a terminal it does not record, or once the server stops: an agent saying goodbye then (pi clears
   * its tokens when it shuts down) must not erase what it was doing.
   */
  recordState(terminalId: string, state: AgentAttentionState): boolean {
    const record = this.live.get(terminalId);
    if (this.kept || !record) return false;
    if ((record.lastState ?? 'unknown') === state) return true;
    if (STATES.has(state)) record.lastState = state as OpenAgentRecord['lastState'];
    else delete record.lastState;
    if (state !== 'finished') {
      // Written now; it carries any finished state still waiting for its write.
      this.cancelStateSave?.();
      this.cancelStateSave = null;
      this.save();
      return true;
    }
    this.cancelStateSave ??= this.schedule(() => {
      this.cancelStateSave = null;
      this.save();
    }, this.stateSaveMs);
    return true;
  }

  /**
   * Whether open agent `terminalId` can be put to sleep (sleep()): the server runs, its catalog agent has a
   * resume argv, and its record holds what that argv continues (resumeKey 'file': a session file its bridge
   * reported; 'id': a session id its hooks reported). An agent with nothing recorded to resume never sleeps.
   */
  canSleep(terminalId: string): boolean {
    const record = this.live.get(terminalId);
    const key = this.resumeKey(terminalId);
    if (this.kept || !record) return false;
    if (key === 'id') return validSessionId(record.session) !== null;
    // 'file', or an agent Mirador does not know (a custom agentCommand) whose bridge reported a session file:
    // it sleeps through the note, as every agent with a session file did before #115.
    return !!record.sessionFile;
  }

  /**
   * What open agent `terminalId`'s resume argv continues: 'file', a session file (pi, which saves through
   * Mirador's note before it sleeps), or 'id', a session id (claude-code, opencode, antigravity); null when
   * its agent has no resume argv or Mirador does not know it.
   */
  resumeKey(terminalId: string): AgentEntry['resumeKey'] | null {
    const record = this.live.get(terminalId);
    if (!record) return null;
    const entry = record.agent !== undefined ? AGENTS.find((agent) => agent.id === record.agent) : agentFor(this.agentCommand);
    return entry?.resume ? entry.resumeKey : null;
  }

  /**
   * Idle sleep: open agent `terminalId`'s record becomes a sleeping record, as finished, and is
   * written at once; the caller then closes its terminal, which leaves that record alone. False
   * when it cannot sleep (canSleep).
   */
  sleep(terminalId: string): boolean {
    const record = this.live.get(terminalId);
    if (!record || !this.canSleep(terminalId)) return false;
    this.live.delete(terminalId);
    this.leaving.get(terminalId)?.();
    this.leaving.delete(terminalId);
    record.lastState = 'finished';
    this.sleepers.push(record);
    this.save();
    return true;
  }

  /** The server is shutting down: the records stay as they are for the next start. */
  keep(): void {
    this.kept = true;
    for (const cancel of this.leaving.values()) cancel();
    this.leaving.clear();
    // A state change still waiting for its write is written now.
    if (this.cancelStateSave) {
      this.cancelStateSave();
      this.cancelStateSave = null;
      this.save();
    }
  }

  /**
   * The sleeping agents, in record order, without the ones being woken now. One is resumable when its
   * agent takes what was recorded (the restore's sessionArgs; any record before a restore).
   */
  sleeping(): SleepingAgent[] {
    const reopenWith = this.reopenWith;
    return this.sleepers
      .filter((record) => !this.waking.has(record))
      .map((record) => {
        const { id, workspaceId, rel, createdAt, agent } = record;
        const keys = resumeKeys(record);
        const resumable = reopenWith ? keys.some((key) => reopenWith.sessionArgs(key, agent).length > 0) : keys.length > 0;
        return { id, workspaceId, rel, createdAt, resumable, ...(agent ? { agent } : {}) };
      });
  }

  /** Olvidar: drops sleeping agent `id`'s record for good. False when no such agent sleeps. */
  forgetSleeping(id: string): boolean {
    const record = this.sleepers.find((sleeper) => sleeper.id === id && !this.waking.has(sleeper));
    if (!record) return false;
    this.drop(record);
    return true;
  }

  /**
   * Despertar: reopens the sleeping agents `select` names (one id, one workspace's, or all) the way
   * restore() reopens, in one launch run of kind 'wake' that queues behind any other run. Null when
   * none matches, before restore() or once the server stops. `done` settles when the run ends; what
   * it did not open (low memory, Pausar, shutdown) sleeps on. When one of the records must wait
   * (`options.ready`: an opencode record before its version is read), the wake takes its run, under the
   * `runId` it answered, only once that is done: a run in the gate refuses agents opened by hand (409),
   * and the wait must not. A shutdown meanwhile leaves them all asleep.
   */
  wake(select: { id?: string; workspaceId?: string } = {}): { runId: string | null; count: number; done: Promise<{ restored: number; dropped: number }> } | null {
    const options = this.reopenWith;
    const records = this.sleepers.filter(
      (record) => !this.waking.has(record) && (select.id === undefined || record.id === select.id) && (select.workspaceId === undefined || record.workspaceId === select.workspaceId),
    );
    if (!options || this.kept || !records.length) return null;
    for (const record of records) this.waking.add(record);
    const reopen = (run: LaunchRun | undefined) => {
      // A session an open agent already continues starts fresh: two agents never share one.
      const continued = new Set([...this.live.values()].flatMap((record) => [record.sessionFile, record.session ?? null]).filter((key) => key !== null));
      return this.reopen(records, options, run, (record) => this.sleepers.includes(record), continued);
    };
    const waits = records.map((record) => options.ready?.(record.agent)).filter((wait) => wait);
    let run: LaunchRun | undefined;
    let runId: string | undefined;
    let reopening: ReturnType<typeof reopen>;
    if (waits.length) {
      runId = options.gate ? randomUUID() : undefined;
      reopening = Promise.allSettled(waits).then(() =>
        this.kept ? { restored: 0, dropped: 0, lowMemory: 0, stopped: true } : reopen(options.gate?.run({ id: runId, kind: 'wake', total: records.length })),
      );
    } else {
      run = options.gate?.run({ kind: 'wake', total: records.length });
      reopening = reopen(run);
    }
    const done = reopening
      .then(({ restored, dropped, lowMemory }) => {
        if (lowMemory) this.log(`mirador: ${lowMemory} sleeping agent(s) not woken: available memory stayed under the reserve; they sleep on`);
        return { restored, dropped };
      })
      .finally(() => {
        for (const record of records) this.waking.delete(record);
      });
    return { runId: run?.id ?? runId ?? null, count: records.length, done };
  }

  /** Waits for the writes started so far. */
  flush(): Promise<void> {
    return this.writes;
  }

  /**
   * Reopens the previous run's agents one after another (delayMs between two of them),
   * continuing each one's session when its file is still valid. Stops at keep(). With a gate,
   * each agent also waits for its turn; when the gate gives up on memory the rest keep their
   * records for the next start (one log line), and a closed gate stops the restore. The agents
   * that had finished their turn are not reopened: they sleep (lazy restore). Records whose agent must wait
   * (`options.ready`) reopen after the others, in a second launch run once it is done. Once the shutdown began
   * (keep()) it does nothing at all: no previous agent is ended, no record changes.
   */
  async restore(options: RestoreOptions): Promise<{ restored: number; dropped: number }> {
    if (this.kept) return { restored: 0, dropped: 0 };
    this.reopenWith = options;
    const stillRunning = new Set(this.pending.length > 0 && options.endPrevious ? await options.endPrevious([...this.pending]) : []);
    this.stillRunning = stillRunning;
    for (const record of this.pending) {
      if (stillRunning.has(record.id)) this.log(`mirador: the open agent of workspace ${JSON.stringify(record.workspaceId)} folder ${JSON.stringify(record.rel)} from the previous run is still running; it is not reopened and its record stays`);
    }
    const asleep = this.pending.filter((record) => record.lastState === 'finished' && !stillRunning.has(record.id));
    if (asleep.length) {
      this.pending = this.pending.filter((record) => !asleep.includes(record));
      this.sleepers.push(...asleep);
      this.log(`mirador: ${asleep.length} open agent(s) sleep: they had finished their turn before the stop; each reopens when woken in Mirador`);
      this.save();
    }
    const queue = this.pending.filter((record) => !stillRunning.has(record.id));
    // The records that may start now reopen first; those that wait, in their own run once they may.
    const waits = new Map(queue.map((record) => [record, options.ready?.(record.agent) ?? null]));
    const now = queue.filter((record) => !waits.get(record));
    const later = queue.filter((record) => waits.get(record));
    const queued = (record: OpenAgentRecord) => this.pending.includes(record);
    const continued = new Set<string>();
    const total = { restored: 0, dropped: 0, lowMemory: 0 };
    const add = (part: { restored: number; dropped: number; lowMemory: number }) => {
      total.restored += part.restored;
      total.dropped += part.dropped;
      total.lowMemory += part.lowMemory;
    };
    // Pausar, low memory or the shutdown in the first run stop the restore, as they did before.
    const first = now.length ? await this.reopen(now, options, options.gate?.run({ kind: 'restore', total: now.length, sleeping: asleep.length }), queued, continued) : null;
    if (first) add(first);
    if (later.length && !first?.stopped) {
      await Promise.allSettled(later.map((record) => waits.get(record)));
      if (!this.kept) add(await this.reopen(later, options, options.gate?.run({ kind: 'restore', total: later.length, sleeping: first ? 0 : asleep.length }), queued, continued));
    } else if (later.length && first?.lowMemory) {
      total.lowMemory += later.filter(queued).length;
    }
    if (total.lowMemory) this.log(`mirador: ${total.lowMemory} open agent(s) not reopened: available memory stayed under the reserve; their records stay for the next start`);
    return { restored: total.restored, dropped: total.dropped };
  }

  /**
   * Opens an agent for each record of `queue`, one after another, as restore() and wake() do. A
   * record no longer `queued` (replaced meanwhile by an agent opened in its folder) is skipped; a
   * session file one opened before continues (`continued`) starts fresh. Its records may all start now (the
   * caller waited for `options.ready` before it took `run`). Stops at keep(), a
   * cancelled run, or low memory (`lowMemory`: how many records it left then). Ends `run` with the
   * folders it left, for the loading bar.
   */
  private async reopen(
    queue: OpenAgentRecord[],
    options: RestoreOptions,
    run: LaunchRun | undefined,
    queued: (record: OpenAgentRecord) => boolean,
    continued: Set<string>,
  ): Promise<{ restored: number; dropped: number; lowMemory: number; stopped: boolean }> {
    const delayMs = options.delayMs ?? RESTORE_DELAY_MS;
    const pause = options.sleep ?? sleep;
    let restored = 0;
    let dropped = 0;
    let lowMemory = 0;
    try {
      for (const record of queue) {
        if (this.kept) break;
        if (!queued(record)) {
          run?.skip();
          continue;
        }
        let launch: AgentLaunch | null = null;
        if (record.agent !== undefined) {
          launch = options.agentLaunch?.(record.agent) ?? null;
          if (!launch) {
            this.log(`mirador: dropped the open agent of workspace ${JSON.stringify(record.workspaceId)} folder ${JSON.stringify(record.rel)}: Mirador no longer knows its agent ${JSON.stringify(record.agent)}`);
            this.drop(record);
            dropped++;
            run?.skip();
            continue;
          }
        }
        let folder: RestoreFolder;
        try {
          folder = await options.resolveFolder(record.workspaceId, record.rel);
        } catch (error) {
          this.log(`mirador: dropped the open agent of workspace ${JSON.stringify(record.workspaceId)} folder ${JSON.stringify(record.rel)}: ${(error as Error).message}`);
          this.drop(record);
          dropped++;
          run?.skip();
          continue;
        }
        if (restored > 0) await pause(delayMs);
        if (this.kept) break;
        const outcome = run ? await run.next() : 'go';
        if (outcome === 'cancelled' || this.kept) break;
        if (outcome === 'low_memory') {
          lowMemory = queue.filter(queued).length;
          break;
        }
        // What it continues: the session id its hooks reported when its agent resumes by id, else its session file.
        const recordedId = validSessionId(record.session);
        const sessionId = recordedId && options.sessionArgs(recordedId, record.agent).length > 0 ? recordedId : null;
        let sessionFile = sessionId ?? (await validSessionFile(record.sessionFile));
        if (sessionFile && continued.has(sessionFile)) {
          this.log(`mirador: the open agent of workspace ${JSON.stringify(record.workspaceId)} folder ${JSON.stringify(record.rel)} shares its ${sessionId ? 'session' : 'session file'} ${sessionFile} with one reopened before; it starts a fresh session`);
          sessionFile = null;
        }
        const agentArgs = sessionFile ? options.sessionArgs(sessionFile, record.agent) : [];
        // A chosen agent without a verified resume starts a fresh session and keeps no session file.
        if (launch && !agentArgs.length) sessionFile = null;
        let info: TerminalInfo;
        this.reopening = true;
        try {
          info = options.registry.create({
            cwd: folder.path,
            kind: 'agent',
            cols: record.cols,
            rows: record.rows,
            workspaceId: folder.workspace.id,
            rel: folder.rel,
            agentArgs,
            ...launch,
          });
        } catch (error) {
          this.log(`mirador: dropped the open agent of workspace ${JSON.stringify(record.workspaceId)} folder ${JSON.stringify(record.rel)}: ${(error as Error).message}`);
          this.drop(record);
          dropped++;
          run?.fail();
          continue;
        } finally {
          this.reopening = false;
        }
        if (sessionFile) continued.add(sessionFile);
        const reopened = this.live.get(info.id);
        if (reopened && sessionFile !== null && sessionFile === sessionId) reopened.session = sessionId;
        else if (reopened) reopened.sessionFile = sessionFile;
        this.drop(record);
        restored++;
      }
    } finally {
      // The records it left (low memory, Pausar, shutdown) name the folders the loading bar lists.
      const left = new Map(queue.filter(queued).map(({ workspaceId, rel }) => [JSON.stringify([workspaceId, rel]), { workspaceId, rel }]));
      run?.end([...left.values()]);
    }
    // Stopped before the end (keep(), a cancelled run, low memory): every record it went through is dropped.
    return { restored, dropped, lowMemory, stopped: queue.some(queued) };
  }

  /** Drops a record not reopened (pending or sleeping) and writes the rest. */
  private drop(record: OpenAgentRecord): void {
    this.pending = this.pending.filter((pending) => pending !== record);
    this.sleepers = this.sleepers.filter((sleeper) => sleeper !== record);
    this.save();
  }

  /** Writes the current records (temp file and rename, 0600), one write at a time. */
  private save(): void {
    if (!this.active) return;
    this.writes = this.writes.then(async () => {
      const body = `${JSON.stringify({ owner: this.owner, agents: [...this.pending, ...this.sleepers, ...this.live.values()] }, null, 2)}\n`;
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        await writeFile(temp, body, { mode: 0o600 });
        await chmod(temp, 0o600);
        await rename(temp, this.file);
      } catch (error) {
        await unlink(temp).catch(() => undefined);
        throw error;
      }
    }).catch((error) => this.log(`mirador: cannot write ${this.file}: ${(error as Error).message}`));
  }
}

/**
 * endPrevious for agents that ran in systemd scopes: stops each record's scope from the run
 * that recorded it (`mirador-agent-<record id>.scope`) and reports the ones still running.
 */
export function stopPreviousScopes(stop: (units: string[]) => Promise<string[]> = stopScopes): (records: OpenAgentRecord[]) => Promise<string[]> {
  return async (records) => {
    const ids = new Map(records.filter((record) => /^[\w-]+$/.test(record.id)).map((record) => [scopeUnit('agent', record.id), record.id]));
    return (await stop([...ids.keys()])).map((unit) => ids.get(unit)).filter((id) => id !== undefined);
  };
}

/** The server's open agents, kept next to its terminal registry (like the launch gate), for the sleeping routes. */
const instances = new WeakMap<object, OpenAgents>();

export function provideOpenAgents(registry: object, openAgents: OpenAgents): void {
  instances.set(registry, openAgents);
}

export function openAgentsOf(registry: object): OpenAgents | undefined {
  return instances.get(registry);
}

/** What a record could continue, as recorded (not checked on disk): its session id, then its session file. */
function resumeKeys(record: OpenAgentRecord): string[] {
  return [validSessionId(record.session), record.sessionFile].filter((key) => key !== null);
}

function recordOf(info: TerminalInfo): OpenAgentRecord {
  return {
    id: info.id,
    workspaceId: info.workspaceId,
    rel: info.rel,
    cwd: info.cwd,
    cols: info.cols ?? 100,
    rows: info.rows ?? 30,
    sessionFile: null,
    createdAt: info.createdAt,
    ...(info.agent ? { agent: info.agent } : {}),
  };
}
