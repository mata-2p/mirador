// Idle sleep for every agent that can resume its session (#115): Pi
// (gentle-shell) saves through Mirador's note first, and Claude Code, opencode and Antigravity are closed
// at once the way × closes them, each leaving a sleeping record that the launch gate wakes with its own
// resume argv. Agents without a resume argv, or with no recorded session, never sleep from idleness.
// Real registry, attention store and OpenAgents, fake pty, fake timers, real files.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAgents } from '../src/terminals/open-agents.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';
import { AttentionStore } from '../src/attention/store.ts';
import { LaunchGate } from '../src/system/memory-gate.ts';
import { IdleSleep } from '../src/terminals/hibernate.ts';
import { agentLaunch } from '../src/agents/catalog.ts';
import { resumeArgs } from '../src/attention/agent-args.ts';

const MINUTE = 60_000;
/** The threshold of these tests: 30 minutes, set in Settings. */
const IDLE_MS = 30 * MINUTE;
const SAVE_MS = 15 * MINUTE;
/** The configured agentCommand of these Miradors (the config default). */
const CONFIGURED = 'gentle-shell';

let scratch: string;
before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-idle-agents-')));
});
const started: Array<{ openAgents: OpenAgents; idle: IdleSleep }> = [];
after(async () => {
  for (const { idle } of started) idle.stop();
  await Promise.all(started.map(({ openAgents }) => openAgents.flush()));
  await rm(scratch, { recursive: true, force: true });
});

class FakePty implements PtyProcess {
  readonly env: Record<string, string>;
  constructor(env: Record<string, string>) {
    this.env = env;
  }
  onData() {}
  onExit() {}
  write() {}
  resize() {}
  kill() {}
}

function fakeTimers() {
  let clock = 0;
  const timers: Array<{ ms: number; due: number; run: () => void; cancelled: boolean }> = [];
  const schedule = (run: () => void, ms: number) => {
    const timer = { ms, due: clock + ms, run, cancelled: false };
    timers.push(timer);
    return () => void (timer.cancelled = true);
  };
  const pass = (ms: number) => {
    const until = clock + ms;
    for (;;) {
      const next = timers.filter((t) => !t.cancelled && t.due <= until).sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      clock = next.due;
      next.cancelled = true;
      next.run();
    }
    clock = until;
  };
  const armed = (ms: number) => timers.filter((t) => !t.cancelled && t.ms === ms).length;
  return { schedule, pass, armed };
}

let counter = 0;
let seq = 1_000_000;

/** A Mirador wired as src/server.ts wires it, its restore already run (so a wake can reopen agents). */
async function mirador(idleMs = IDLE_MS, configured = CONFIGURED) {
  const place = join(scratch, `case-${++counter}`);
  await mkdir(join(place, 'state'), { recursive: true });
  const owner = join(place, 'config.json');
  await writeFile(owner, '{}');
  const file = join(place, 'state', 'open-agents.json');
  const spawned: FakePty[] = [];
  const spawn: SpawnFn = (_file, _args, opts) => {
    const pty = new FakePty(opts.env);
    spawned.push(pty);
    return pty;
  };
  const stopped: string[][] = [];
  const registry = new TerminalRegistry(spawn, {
    shell: '/bin/bash', agentCommand: configured, agentRcFile: '/run/mirador/agent.bashrc', env: {}, scrollbackLimit: 1000,
    scopes: true, stopScopes: async (units) => void stopped.push(units),
  });
  const attention = new AttentionStore({ now: () => 1_000_000 });
  registry.subscribe((event) => attention.track(event));
  const logs: string[] = [];
  const log = (line: string) => void logs.push(line);
  const openAgents = await OpenAgents.load(file, { owner, log, schedule: () => () => undefined, agentCommand: configured });
  openAgents.track(registry);
  attention.onAgentState((id, state) => void openAgents.recordState(id, state));
  attention.onSession((id, session) => void openAgents.recordSessionId(id, session));
  const gate = new LaunchGate({ readMemory: async () => ({ memTotal: 24 * 1024 ** 3, memAvailable: 10 * 1024 ** 3 }), sleep: async () => undefined });
  await openAgents.restore({
    registry,
    resolveFolder: async (workspaceId, rel) => ({ workspace: { id: workspaceId }, rel, path: `/w/${rel}` }),
    sessionArgs: (key, agent) => resumeArgs((agent && agentLaunch(agent, configured)?.agentCommand) || configured, key),
    agentLaunch: (agent) => agentLaunch(agent, configured),
    gate,
    sleep: async () => undefined,
  });
  const notes: string[] = [];
  const timers = fakeTimers();
  const idle = new IdleSleep({
    registry,
    attention,
    openAgents,
    sendNote: async (terminalId) => {
      notes.push(terminalId);
      return { sent: true };
    },
    idleMs,
    saveTurnMs: SAVE_MS,
    schedule: timers.schedule,
    log,
  });
  idle.start();
  started.push({ openAgents, idle });
  return { place, registry, attention, openAgents, idle, notes, timers, logs, spawned, stopped, gate };
}

type Mirador = Awaited<ReturnType<typeof mirador>>;

const report = (pane: string, tokens: Record<string, string>, clear: string[] = []) =>
  JSON.stringify({ v: 1, cmd: 'report-metadata', pane, source: 'mirador:attention', seq: ++seq, ttlMs: null, tokens, clear });
const working = (m: Mirador, id: string) => m.attention.receive(report(id, {}, ['blocked', 'prompt', 'finished']));
const finished = (m: Mirador, id: string, turn: string) => m.attention.receive(report(id, { finished: turn }, ['blocked', 'prompt']));
const prompt = (m: Mirador, id: string) => m.attention.receive(report(id, { prompt: 'Allow?' }, ['finished']));
const blocked = (m: Mirador, id: string) => m.attention.receive(report(id, { blocked: 'Which file?' }, ['finished']));
const isOpen = (m: Mirador, id: string) => m.registry.get(id)?.status === 'running';

/** An agent of catalog `agent` (absent: the configured gentle-shell) in folder `rel`; its first turn under way. */
async function agentIn(m: Mirador, rel: string, agent?: string, session?: string) {
  const launch = agent ? agentLaunch(agent, CONFIGURED) : null;
  if (agent) assert.ok(launch, agent);
  const info = m.registry.create({ cwd: `/w/${rel}`, kind: 'agent', cols: 100, rows: 30, workspaceId: 'dev', rel, ...launch });
  if (session !== undefined && (!agent || agent === 'pi')) {
    // Pi's bridge reports its session file.
    const sessionFile = join(m.place, `${rel}.jsonl`);
    await writeFile(sessionFile, '{}\n');
    assert.equal(await m.openAgents.recordSession(info.id, sessionFile), true);
    working(m, info.id);
    return { id: info.id, session: sessionFile };
  }
  // A hook agent names its session in its reports (claude session_id, opencode sessionID, agy conversationId).
  m.attention.receive(report(info.id, session === undefined ? {} : { session }, ['blocked', 'prompt', 'finished']));
  return { id: info.id, session: session ?? null };
}

/** Wakes sleeping agent `id` through the gate; resolves with the command line its new terminal runs. */
async function wake(m: Mirador, id: string): Promise<string> {
  const woken = m.openAgents.wake({ id });
  assert.ok(woken, 'it can be woken');
  assert.deepEqual(await woken.done, { restored: 1, dropped: 0 });
  assert.equal(m.gate.status().runs.at(-1)?.kind, 'wake', 'through the launch gate');
  return m.spawned.at(-1)!.env.MIRADOR_AGENT_COMMAND;
}

for (const [agent, command, session] of [
  ['claude-code', `claude '--resume' 'claude-sess-1'`, 'claude-sess-1'],
  ['opencode', `opencode '--session' 'ses_opencode1'`, 'ses_opencode1'],
  ['antigravity', `agy '--conversation' 'agy-conv-1'`, 'agy-conv-1'],
] as const) {
  test(`${agent}: finished for the threshold it is closed at once, with no save note, and woken it resumes its own session`, async () => {
    const m = await mirador();
    const a = await agentIn(m, agent, agent, session);
    finished(m, a.id, 't-1');
    m.timers.pass(IDLE_MS - MINUTE);
    assert.equal(isOpen(m, a.id), true, 'not before the threshold');
    m.timers.pass(MINUTE);
    assert.deepEqual(m.notes, [], 'no save note: only Pi saves through Mirador’s note');
    assert.equal(m.registry.get(a.id), undefined, 'closed the way × closes it');
    assert.deepEqual(m.stopped, [[`mirador-agent-${a.id}`]], 'its scope is stopped');
    assert.deepEqual(m.openAgents.sleeping().map((s) => [s.id, s.rel, s.resumable, s.agent]), [[a.id, agent, true, agent]]);
    assert.equal(m.logs.filter((line) => /^mirador: .* sleeps: /.test(line)).length, 1, 'one log line for the agent put to sleep');
    assert.equal(await wake(m, a.id), command);
    assert.deepEqual(m.openAgents.sleeping(), []);
  });
}

test('pi: finished for the threshold it saves through Mirador’s note, then sleeps, and woken it resumes its session file', async () => {
  const m = await mirador();
  const a = await agentIn(m, 'pi', 'pi', 'file');
  finished(m, a.id, 't-1');
  m.timers.pass(IDLE_MS);
  assert.deepEqual(m.notes, [a.id], 'asked to save first');
  assert.equal(isOpen(m, a.id), true, 'open while it saves');
  working(m, a.id);
  finished(m, a.id, 't-2');
  assert.equal(m.registry.get(a.id), undefined);
  assert.deepEqual(m.openAgents.sleeping().map((s) => [s.id, s.resumable, s.agent]), [[a.id, true, 'pi']]);
  assert.equal(await wake(m, a.id), `gentle-shell '--session' '${a.session}'`);
});

test('a record without a catalog id that holds a session file still sleeps through the note, whatever agentCommand runs it (pre-#115 behaviour)', async () => {
  const m = await mirador(IDLE_MS, '/opt/pi/my-wrapper');
  const info = m.registry.create({ cwd: '/w/wrapped', kind: 'agent', cols: 100, rows: 30, workspaceId: 'dev', rel: 'wrapped' });
  const sessionFile = join(m.place, 'wrapped.jsonl');
  await writeFile(sessionFile, '{}\n');
  assert.equal(await m.openAgents.recordSession(info.id, sessionFile), true);
  working(m, info.id);
  finished(m, info.id, 't-1');
  m.timers.pass(IDLE_MS);
  assert.deepEqual(m.notes, [info.id], 'asked to save first, as before');
});

test('Codex, Gemini CLI and Kimi have no resume argv: they never sleep from idleness', async () => {
  const m = await mirador();
  const agents = [];
  for (const agent of ['codex', 'gemini-cli', 'kimi']) {
    const a = await agentIn(m, agent, agent, `${agent}-session`);
    finished(m, a.id, 't-1');
    agents.push(a);
  }
  for (let round = 0; round < 3; round++) m.timers.pass(IDLE_MS);
  for (const a of agents) assert.equal(isOpen(m, a.id), true);
  assert.deepEqual(m.notes, []);
  assert.deepEqual(m.openAgents.sleeping(), []);
  assert.deepEqual(m.stopped, []);
});

test('an agent with a resume argv but no recorded session never sleeps from idleness', async () => {
  const m = await mirador();
  const claude = await agentIn(m, 'claude', 'claude-code');
  const pi = await agentIn(m, 'pi', 'pi');
  finished(m, claude.id, 't-1');
  finished(m, pi.id, 't-1');
  for (let round = 0; round < 3; round++) m.timers.pass(IDLE_MS);
  assert.equal(isOpen(m, claude.id), true);
  assert.equal(isOpen(m, pi.id), true);
  assert.deepEqual(m.notes, []);
  assert.deepEqual(m.openAgents.sleeping(), []);
  assert.equal(m.timers.armed(IDLE_MS), 2, 'their clocks start again, so one that reports its session later can sleep');
});

const osc = (m: Mirador, id: string, state: string) => m.attention.programStatus(id, { id: '', state } as never);
for (const [state, enter] of [
  ['working', (m: Mirador, id: string) => working(m, id)],
  ['waiting (blocked)', (m: Mirador, id: string) => blocked(m, id)],
  ['waiting (prompt)', (m: Mirador, id: string) => prompt(m, id)],
  ['error', (m: Mirador, id: string) => osc(m, id, 'error')],
  // A turn cut without a last report: its bash drew a prompt, so the hooks' report no longer stands.
  ['unknown', (m: Mirador, id: string) => (working(m, id), m.attention.programPrompt(id))],
] as const) {
  test(`an agent that is ${state} never sleeps, even after it had finished`, async () => {
    const m = await mirador();
    const a = await agentIn(m, 'claude', 'claude-code', 'claude-sess-1');
    finished(m, a.id, 't-1');
    m.timers.pass(IDLE_MS / 2);
    enter(m, a.id);
    assert.equal(m.attention.agentState(a.id), state.split(' ')[0]);
    assert.equal(m.timers.armed(IDLE_MS), 0, 'its clock stopped');
    for (let round = 0; round < 3; round++) m.timers.pass(IDLE_MS);
    assert.equal(isOpen(m, a.id), true);
    assert.deepEqual(m.openAgents.sleeping(), []);
    assert.deepEqual(m.stopped, []);
  });
}

test('typing into a finished agent restarts its clock, for agents that do not save first too', async () => {
  const m = await mirador();
  const a = await agentIn(m, 'claude', 'claude-code', 'claude-sess-1');
  finished(m, a.id, 't-1');
  m.timers.pass(IDLE_MS - MINUTE);
  m.registry.write(a.id, 'ls\r');
  m.timers.pass(MINUTE);
  assert.equal(isOpen(m, a.id), true, 'the threshold after the turn ended, but a minute after the keystroke');
  // A focus report is the terminal's own reply, not the user.
  m.registry.write(a.id, '\x1b[I');
  m.timers.pass(IDLE_MS - 2 * MINUTE);
  assert.equal(isOpen(m, a.id), true);
  m.timers.pass(MINUTE);
  assert.equal(m.registry.get(a.id), undefined, 'asleep a full threshold after the keystroke');
});

test('the night shift’s idle hold keeps a hook agent open too, with its clock started again', async () => {
  const m = await mirador();
  const a = await agentIn(m, 'claude', 'claude-code', 'claude-sess-1');
  const held = new IdleSleep({
    registry: m.registry,
    attention: { agentState: (id) => m.attention.agentState(id), onAgentState: (listener) => m.attention.onAgentState(listener), idleHold: () => 'night' },
    openAgents: m.openAgents,
    idleMs: IDLE_MS, schedule: m.timers.schedule, log: () => undefined,
  });
  m.idle.stop();
  held.start();
  finished(m, a.id, 't-1');
  m.timers.pass(3 * IDLE_MS);
  assert.equal(m.timers.armed(IDLE_MS), 1, 'its clock started again');
  held.stop();
  assert.equal(isOpen(m, a.id), true);
  assert.deepEqual(m.openAgents.sleeping(), []);
});

test('without the night shift’s note path, Pi agents stay open and the other agents still sleep', async () => {
  const m = await mirador();
  const pi = await agentIn(m, 'pi', 'pi', 'file');
  const claude = await agentIn(m, 'claude', 'claude-code', 'claude-sess-1');
  const noNotes = new IdleSleep({ registry: m.registry, attention: m.attention, openAgents: m.openAgents, idleMs: IDLE_MS, schedule: m.timers.schedule, log: () => undefined });
  m.idle.stop();
  noNotes.start();
  finished(m, pi.id, 't-1');
  finished(m, claude.id, 't-1');
  m.timers.pass(IDLE_MS);
  noNotes.stop();
  assert.equal(isOpen(m, pi.id), true, 'Pi cannot save, so it stays open');
  assert.deepEqual(m.openAgents.sleeping().map((s) => s.id), [claude.id]);
});

test('the switch off stops all idle sleep at once, and back on with a new threshold the finished agents count it from then', async () => {
  const m = await mirador();
  const claude = await agentIn(m, 'claude', 'claude-code', 'claude-sess-1');
  const pi = await agentIn(m, 'pi', 'pi', 'file');
  finished(m, claude.id, 't-1');
  finished(m, pi.id, 't-1');
  m.timers.pass(IDLE_MS - MINUTE);
  m.idle.setIdleMs(0);
  assert.equal(m.timers.armed(IDLE_MS), 0, 'no clock runs while it is off');
  m.timers.pass(10 * IDLE_MS);
  assert.equal(isOpen(m, claude.id), true);
  assert.equal(isOpen(m, pi.id), true);
  assert.deepEqual(m.notes, []);

  m.idle.setIdleMs(5 * MINUTE);
  m.timers.pass(5 * MINUTE - 1);
  assert.equal(isOpen(m, claude.id), true, 'the new threshold counts from the change');
  m.timers.pass(1);
  assert.equal(m.registry.get(claude.id), undefined, 'asleep after the new threshold');
  assert.deepEqual(m.notes, [pi.id], 'Pi is asked to save');
});

test('the switch off during Pi’s save turn leaves it open, and nothing closes it when that turn ends', async () => {
  const m = await mirador();
  const pi = await agentIn(m, 'pi', 'pi', 'file');
  finished(m, pi.id, 't-1');
  m.timers.pass(IDLE_MS);
  assert.deepEqual(m.notes, [pi.id]);
  working(m, pi.id);
  m.idle.setIdleMs(0);
  finished(m, pi.id, 't-2');
  assert.equal(isOpen(m, pi.id), true);
  assert.equal(m.timers.armed(SAVE_MS), 0);
  m.timers.pass(10 * IDLE_MS);
  assert.equal(isOpen(m, pi.id), true);
  assert.deepEqual(m.openAgents.sleeping(), []);
});
