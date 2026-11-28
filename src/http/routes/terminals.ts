import { agentLaunch, offeredAgents, type AgentLaunch } from '../../agents/catalog.ts';
import { bridgeArgs, terminalAgent } from '../../attention/agent-args.ts';
import { stateDir } from '../../config.ts';
import { LEFT_OFF_AGENT, deleteLeftOff, leftOffDir } from '../../memory/left-off.ts';
import { nightAttention, nightService, taskText, type NightService } from '../../night/service.ts';
import { randomUUID } from 'node:crypto';
import { launchGate, type LaunchRunStatus } from '../../system/memory-gate.ts';
import { MAX_INSTRUCTION_CHARS, openAgentBatch, type BatchDelegation, type BatchResult } from '../../terminals/open-many.ts';
import { idleSleepOf } from '../../terminals/hibernate.ts';
import { openAgentsOf } from '../../terminals/open-agents.ts';
import type { TerminalKind } from '../../terminals/registry.ts';
import { MAX_PROJECTS } from '../../workspaces/store.ts';
import type { RouteModule } from '../context.ts';
import { HttpError, readJson, sendJson, sendNoContent } from '../respond.ts';

/** Terminal sizes from the client: whole numbers from 2 to 1000, else the fallback. */
export function clampSize(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 2 && n <= 1000 ? n : fallback;
}

const invalidBatch = () =>
  new HttpError(400, `a batch takes { ws, rels } with 1-${MAX_PROJECTS} folder paths, or { ws, saved: true }; reopen must be true or false`, 'batch_invalid');

/** The folders a batch asks for: `rels` as given, or the workspace's saved project set. */
function batchRels(body: Record<string, unknown>): string[] | 'saved' {
  if ('reopen' in body && typeof body.reopen !== 'boolean') throw invalidBatch();
  if (body.saved === true && !('rels' in body)) return 'saved';
  const { rels } = body;
  if ('saved' in body || !Array.isArray(rels) || !rels.length || rels.length > MAX_PROJECTS) throw invalidBatch();
  if (!rels.every((rel) => typeof rel === 'string' && rel.length <= 1024)) throw invalidBatch();
  return rels as string[];
}

const invalidDelegation = () =>
  new HttpError(
    400,
    `an instruction is 1-${MAX_INSTRUCTION_CHARS} characters without control characters (line breaks and tabs allowed); autopilot (true or false) comes only with an instruction, and reopen does not`,
    'delegate_invalid',
  );
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

/** What a batch delegates: the trimmed instruction and whether to switch the autopilot on; null when it delegates nothing. */
function batchDelegation(body: Record<string, unknown>): { text: string; autopilot: boolean } | null {
  if (!('instruction' in body)) {
    if ('autopilot' in body) throw invalidDelegation();
    return null;
  }
  const text = typeof body.instruction === 'string' ? body.instruction.replace(/\r\n?/g, '\n').trim() : '';
  if (!text || text.length > MAX_INSTRUCTION_CHARS || CONTROL.test(text)) throw invalidDelegation();
  if (body.reopen === true || ('autopilot' in body && typeof body.autopilot !== 'boolean')) throw invalidDelegation();
  return { text, autopilot: body.autopilot === true };
}

type AutopilotOutcome = 'turned_on' | 'already_on' | 'unavailable';

/** Switches the autopilot on by hand with no until when it is off; an on is left as it is. */
function switchOn(night: NightService | null): AutopilotOutcome {
  if (!night?.status().available) return 'unavailable';
  if (night.active) return 'already_on';
  // A manual on like the user's own; the activation log says it came from a delegation.
  night.setActive(true, { source: 'manual', until: null, cause: 'delegation' });
  return 'turned_on';
}

/** How long a finished batch stays readable through GET /api/terminals/batch/:id, and how many are kept. */
const BATCH_KEEP_MS = 10 * 60_000;
const MAX_BATCHES = 20;

interface TrackedBatch {
  workspaceId: string;
  results: BatchResult[];
  done: boolean;
  finishedAt: number;
}

/** An ended batch run with the folders it did not open (low memory or cancelled), from its tracked results. */
function withNotOpened(run: LaunchRunStatus, batch: TrackedBatch | undefined): LaunchRunStatus {
  if (run.state !== 'done' || run.notOpened || run.kind !== 'batch') return run;
  const left = (batch?.results ?? []).filter((result) => result.status === 'low_memory' || result.status === 'cancelled');
  return { ...run, notOpened: left.map(({ rel }) => ({ workspaceId: batch!.workspaceId, rel })) };
}

const notOffered = () => new HttpError(400, 'agent is the id of an agent GET /api/agents offers, for an agent terminal only', 'agent_not_offered');

/**
 * The agent chosen for a new terminal: only its id comes from the
 * client, checked against the offered agents, like the 'git' kind carries no command. Null without
 * one (absent or null): the configured agentCommand, as before.
 */
async function chosenAgent(body: Record<string, unknown>, kind: TerminalKind, agentCommand: string): Promise<AgentLaunch | null> {
  if (body.agent === undefined || body.agent === null) return null;
  const id = body.agent;
  if (kind !== 'agent' || typeof id !== 'string') throw notOffered();
  if (!(await offeredAgents({ agentCommand })).some((agent) => agent.id === id)) throw notOffered();
  const launch = agentLaunch(id, agentCommand);
  if (!launch) throw notOffered();
  return launch;
}

/** A sleeping agent's id from the path: a terminal id of an earlier run. */
function sleepingId(value: string): string {
  if (!/^[\w-]{1,64}$/.test(value)) throw new HttpError(400, 'a sleeping agent id is 1-64 letters, digits, - or _', 'sleeping_invalid');
  return value;
}

const unknownSleeping = () => new HttpError(404, 'no such sleeping agent', 'sleeping_unknown');

export const terminalRoutes: RouteModule = (ctx) => {
  /** Despertar: the wake's launch run goes on in the server (it may wait in the gate behind another run); 202 at once. */
  const wake = (select: { id?: string; workspaceId?: string }) => {
    const woken = openAgentsOf(ctx.terminals)?.wake(select) ?? null;
    woken?.done.catch((error) => console.error('mirador: waking sleeping agents failed:', error));
    return woken;
  };
  // Batches answered while their agents still wait for the launch gate (src/system/memory-gate.ts).
  const batches = new Map<string, TrackedBatch>();
  // While agents open in batches, one more by hand is refused rather than queued behind
  // them (the window disables the button and says why); bash never waits.
  const refuseWhileLaunching = () => {
    if (launchGate(ctx.terminals)?.status().active) {
      throw new HttpError(409, 'Mirador is opening agents; open this one once they are open, or after Pausar', 'launches_running');
    }
  };
  // An open that waited for opencode's version while the server began to stop starts nothing.
  const refuseWhileStopping = () => {
    if (ctx.stopping?.()) throw new HttpError(503, 'Mirador is stopping; open this agent once it has started again', 'server_stopping');
  };
  const prune = () => {
    for (const [id, batch] of batches) if (batch.done && Date.now() - batch.finishedAt > BATCH_KEEP_MS) batches.delete(id);
    for (const [id, batch] of batches) if (batches.size >= MAX_BATCHES && batch.done) batches.delete(id);
  };
  return [
    {
      method: 'GET',
      path: '/api/terminals',
      // Agent terminals carry their attention state (AttentionStore.agentState: working, waiting,
      // finished, error or unknown), from their hooks or their OSC 7501 reports. One that idle sleep keeps
      // awake because of work it left running also carries `awake: { name }`, the program's name only
      // (IdleSleep.awake), for its card; the inbox (notifications, the phone) never carries it.
      handler: ({ res }) => {
        const attention = nightAttention(ctx.terminals);
        const idle = idleSleepOf(ctx.terminals);
        sendJson(res, 200, ctx.terminals.list().map((info) => {
          if (info.kind !== 'agent') return info;
          const awake = idle?.awake(info.id);
          return { ...info, agentState: attention?.agentState?.(info.id) ?? 'unknown', ...(awake ? { awake } : {}) };
        }));
      },
    },
    {
      method: 'POST',
      path: '/api/terminals',
      handler: async ({ req, res }) => {
        const body = await readJson(req);
        const kind: TerminalKind = body.kind === 'shell' || body.kind === 'git' ? body.kind : 'agent';
        const agent = await chosenAgent(body, kind, ctx.config.agentCommand);
        if (kind === 'agent') refuseWhileLaunching();
        const folder = await ctx.resolveFolder(body.ws, body.rel);
        // An opencode agent (chosen, or the configured agentCommand) waits for its version and bridge; any other
        // terminal starts at once (ctx.opencodeReady). After that wait it asks again: the restore's run for opencode
        // records may have begun meanwhile, or the server's stop.
        const ready = kind === 'agent' ? ctx.opencodeReady?.(agent?.agent) : null;
        if (ready) {
          await ready;
          refuseWhileStopping();
          refuseWhileLaunching();
        }
        const info = ctx.terminals.create({
          cwd: folder.path,
          kind,
          cols: clampSize(body.cols, 100),
          rows: clampSize(body.rows, 30),
          workspaceId: folder.workspace.id,
          rel: folder.rel,
          ...agent,
        });
        sendJson(res, 201, info);
      },
    },
    {
      // One agent per folder, one after another (src/terminals/open-many.ts), through the launch gate.
      // It answers once all are done, or as soon as the gate makes the batch wait: then the folders
      // still to do are `queued`, the answer carries a `batchId` and the batch goes on in the server.
      method: 'POST',
      path: '/api/terminals/batch',
      handler: async ({ req, res }) => {
        const body = await readJson(req);
        const asked = batchRels(body);
        const delegated = batchDelegation(body);
        const { workspace } = await ctx.resolveFolder(body.ws, '');
        const rels = asked === 'saved' ? (workspace.projects ?? []) : asked;
        if (!rels.length) throw new HttpError(400, 'this workspace has no saved projects', 'workspace_projects_empty');
        // A batch opens the configured agentCommand: when that is opencode, it waits for its version and bridge, and
        // opens nothing once the server's stop began meanwhile.
        const ready = ctx.opencodeReady?.();
        if (ready) {
          await ready;
          refuseWhileStopping();
        }
        const night = delegated ? nightService(ctx.terminals) : null;
        let autopilot: AutopilotOutcome | undefined;
        // The instruction becomes the agent's first message on pi's command line, like --session at a restore (server.ts).
        const delegation: BatchDelegation | undefined = delegated ? {
          firstMessageArgs: bridgeArgs(ctx.config.agentCommand, 'bridge').length ? [taskText(delegated.text, ctx.config.ownerName)] : null,
          sendToOpen: async (terminalId) => {
            if (!night) return 'the autopilot is not available';
            const sent = await night.sendNote(terminalId, delegated.text, '', taskText);
            if (sent.delivered) night.assignTask(terminalId, delegated.text);
            return sent.delivered ? null : (sent.reason ?? 'the agent did not confirm it received the instruction');
          },
          opened: (terminalId) => night?.assignTask(terminalId, delegated.text),
          // Before the first agent opens, so its first questions already meet the autopilot.
          ready: () => {
            if (delegated.autopilot) autopilot = switchOn(night);
          },
        } : undefined;
        const tracked: TrackedBatch = { workspaceId: workspace.id, results: [], done: false, finishedAt: 0 };
        // The batch's launch run in the gate has the same id: R4b reads and cancels it by batchId.
        const runId = randomUUID();
        const cancel = new AbortController();
        // The user's window went away before the answer: the folders not started yet stay closed.
        res.once('close', () => res.writableFinished || cancel.abort());
        let waits!: (snapshot: BatchResult[]) => void;
        const waiting = new Promise<BatchResult[]>((resolve) => (waits = resolve));
        const running = openAgentBatch({
          workspaceId: workspace.id,
          rels,
          missing: asked === 'saved' ? 'skip' : 'reject',
          reopen: body.reopen === true,
          cols: clampSize(body.cols, 100),
          rows: clampSize(body.rows, 30),
          registry: ctx.terminals,
          resolveFolder: (id, rel) => ctx.resolveFolder(id, rel),
          delegation,
          gate: launchGate(ctx.terminals),
          runId,
          signal: cancel.signal,
          onWait: (snapshot) => {
            tracked.results = snapshot;
            waits(snapshot);
          },
          onProgress: (snapshot) => void (tracked.results = snapshot),
        });
        const first = await Promise.race([running.then((results) => ({ results, queued: false })), waiting.then((results) => ({ results, queued: true }))]);
        let batchId: string | undefined;
        if (first.queued) {
          prune();
          batchId = runId;
          batches.set(batchId, tracked);
          running
            .then((results) => void (tracked.results = results), (error) => {
              console.error('mirador: a batch failed after its answer:', error);
              tracked.results = tracked.results.map((r) => (r.status === 'queued' ? { rel: r.rel, status: 'failed', error: 'internal error' } : r));
            })
            .finally(() => {
              tracked.done = true;
              tracked.finishedAt = Date.now();
            });
        }
        // The answer comes once the manual on is on disk, like PUT /api/night, so a restart right after keeps it.
        if (autopilot === 'turned_on') await night!.manualSaved;
        sendJson(res, 200, { results: first.results, ...(batchId ? { batchId } : {}), ...(autopilot ? { autopilot } : {}) });
      },
    },
    {
      // The launch runs of the gate (batches and the restore): progress, current wait, `active` while any runs;
      // an ended run lists the folders it did not open (`notOpened`), a batch's from its results here.
      method: 'GET',
      path: '/api/terminals/launches',
      handler: ({ res }) => {
        const status = launchGate(ctx.terminals)?.status() ?? { active: false, runs: [] };
        sendJson(res, 200, { ...status, runs: status.runs.map((run) => withNotOpened(run, batches.get(run.id))) });
      },
    },
    {
      // Pausar: the run starts nothing more; the agents it opened stay. 404 for an unknown or ended run.
      method: 'POST',
      path: '/api/terminals/launches/:id/cancel',
      handler: ({ res, params }) => {
        if (!launchGate(ctx.terminals)?.cancel(params.id)) throw new HttpError(404, 'no such launch run in progress', 'launch_unknown');
        sendJson(res, 200, { id: params.id, cancelled: true });
      },
    },
    {
      // Lazy restore: the agents left asleep at the start (they had finished their turn), with no process.
      method: 'GET',
      path: '/api/terminals/sleeping',
      // `agent`: the catalog id it was opened with, null for the configured agentCommand.
      handler: ({ res }) => sendJson(res, 200, { agents: (openAgentsOf(ctx.terminals)?.sleeping() ?? []).map((agent) => ({ ...agent, agent: agent.agent ?? null })) }),
    },
    {
      // Despertar todos: every sleeping agent, or one workspace's ({ ws }), in batches through the launch gate.
      method: 'POST',
      path: '/api/terminals/sleeping/wake',
      handler: async ({ req, res }) => {
        const body = await readJson(req);
        if ('ws' in body && typeof body.ws !== 'string') throw new HttpError(400, 'ws is a workspace id', 'sleeping_invalid');
        const woken = wake(typeof body.ws === 'string' ? { workspaceId: body.ws } : {});
        sendJson(res, woken ? 202 : 200, { runId: woken?.runId ?? null, count: woken?.count ?? 0 });
      },
    },
    {
      // Despertar: reopens one sleeping agent as the restore would, continuing its session; queued behind a running launch, never 409.
      method: 'POST',
      path: '/api/terminals/sleeping/:id/wake',
      handler: ({ res, params }) => {
        const woken = wake({ id: sleepingId(params.id) });
        if (!woken) throw unknownSleeping();
        sendJson(res, 202, { runId: woken.runId, count: woken.count });
      },
    },
    {
      // Olvidar: drops a sleeping agent's record for good (its pi session file stays where pi keeps it).
      // A Claude Code agent's folder also loses its "where it left off" record (src/memory/left-off.ts):
      // chosen as claude-code or started as the configured agentCommand (agent null), by the rule that
      // gives it the hooks (terminalAgent). Any other sleeper leaves the record.
      method: 'DELETE',
      path: '/api/terminals/sleeping/:id',
      handler: async ({ res, params }) => {
        const agents = openAgentsOf(ctx.terminals);
        const id = sleepingId(params.id);
        const sleeper = agents?.sleeping().find((agent) => agent.id === id);
        if (!agents?.forgetSleeping(id)) throw unknownSleeping();
        if (sleeper && terminalAgent(sleeper.agent, ctx.config.agentCommand)?.id === LEFT_OFF_AGENT) {
          await deleteLeftOff(leftOffDir(stateDir()), sleeper.workspaceId, sleeper.rel).catch((error) =>
            console.error(`mirador: a left-off record could not be removed: ${(error as NodeJS.ErrnoException)?.code ?? 'error'}`),
          );
        }
        sendNoContent(res);
      },
    },
    {
      // What a batch answered with a batchId has done since: its results so far and whether it ended.
      method: 'GET',
      path: '/api/terminals/batch/:id',
      handler: ({ res, params }) => {
        const batch = batches.get(params.id);
        if (!batch) throw new HttpError(404, 'unknown batch', 'batch_unknown');
        sendJson(res, 200, { results: batch.results, done: batch.done });
      },
    },
    {
      method: 'DELETE',
      path: '/api/terminals/:id',
      handler: ({ res, params }) => {
        if (!ctx.terminals.get(params.id)) throw new HttpError(404, 'unknown terminal');
        ctx.terminals.close(params.id);
        sendNoContent(res);
      },
    },
  ];
};
