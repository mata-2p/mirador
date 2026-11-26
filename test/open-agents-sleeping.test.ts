// Lazy restore: each open agent's record keeps
// its last attention state; at the next start only agents that were working or waiting (or whose
// state is unknown) reopen, the ones that had finished their turn stay asleep until the user wakes
// or forgets them. Real OpenAgents, registry and attention store, fake pty, real files.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAgents, type OpenAgentRecord } from '../src/terminals/open-agents.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';
import { LaunchGate } from '../src/system/memory-gate.ts';
import { AttentionStore } from '../src/attention/store.ts';

let scratch: string;
before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-sleeping-')));
});
after(() => rm(scratch, { recursive: true, force: true }));

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

function setup() {
  const spawned: FakePty[] = [];
  const spawn: SpawnFn = (_file, _args, opts) => {
    const pty = new FakePty(opts.env);
    spawned.push(pty);
    return pty;
  };
  const registry = new TerminalRegistry(spawn, { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/run/mirador/agent.bashrc', env: {}, scrollbackLimit: 1000 });
  return { registry, spawned };
}

let counter = 0;
async function place() {
  const dir = join(scratch, `case-${++counter}`);
  await mkdir(join(dir, 'state'), { recursive: true });
  const owner = join(dir, 'config.json');
  await writeFile(owner, '{}');
  const logs: string[] = [];
  return { dir, file: join(dir, 'state', 'open-agents.json'), owner, logs, log: (line: string) => void logs.push(line) };
}

const read = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as { owner: string; agents: Array<OpenAgentRecord & { lastState?: string }> };
const agent = (rel: string) => ({ cwd: `/w/${rel}`, kind: 'agent' as const, cols: 100, rows: 30, workspaceId: 'dev', rel });
const resolveFolder = async (workspaceId: string, rel: string) => ({ workspace: { id: workspaceId }, rel, path: `/w/${rel}` });
const sessionArgs = (file: string) => ['--session', file];
const roomy = () => new LaunchGate({ readMemory: async () => ({ memTotal: 24 * 1024 ** 3, memAvailable: 10 * 1024 ** 3 }), sleep: async () => undefined });
const running = (registry: TerminalRegistry) => registry.list().filter((t) => t.kind === 'agent' && t.status === 'running').map((t) => t.rel).sort();

/** Records as a previous run left them; `lastState` as given (absent in an older file). */
async function previousRun(file: string, owner: string, agents: Array<Partial<OpenAgentRecord> & { lastState?: unknown }>) {
  const full = agents.map((record, i) => ({ id: `old-${i}`, workspaceId: 'dev', rel: '', cwd: '/old', cols: 100, rows: 30, sessionFile: null, createdAt: '2026-10-29T00:00:00.000Z', ...record }));
  await writeFile(file, JSON.stringify({ owner, agents: full }), { mode: 0o600 });
}

function fakeTimers() {
  const timers: Array<{ ms: number; run: () => void; cancelled: boolean }> = [];
  const schedule = (run: () => void, ms: number) => {
    const timer = { ms, run, cancelled: false };
    timers.push(timer);
    return () => void (timer.cancelled = true);
  };
  const fire = () => timers.filter((t) => !t.cancelled).forEach((t) => { t.cancelled = true; t.run(); });
  return { timers, schedule, fire };
}

const report = (pane: string, seq: number, source: string, tokens: Record<string, string>, clear: string[] = []) =>
  JSON.stringify({ v: 1, cmd: 'report-metadata', pane, source, seq, tokens, clear });

test('the attention store names each agent\'s state: waiting, finished, working or unknown, and says when it changes', () => {
  const { registry } = setup();
  const store = new AttentionStore({ now: () => 1_000_000 });
  registry.subscribe((event) => store.track(event));
  const changes: Array<[string, string]> = [];
  store.onAgentState((id, state) => changes.push([id, state]));
  const a = registry.create(agent('a'));
  assert.equal(store.agentState(a.id), 'unknown', 'nothing reported yet');
  // session_start: the bridge reports with every token cleared.
  store.receive(report(a.id, 1_000_001, 'mirador:attention', {}, ['blocked', 'prompt', 'finished']));
  assert.equal(store.agentState(a.id), 'working');
  store.receive(report(a.id, 1_000_002, 'mirador:attention', { prompt: 'Allow?' }));
  assert.equal(store.agentState(a.id), 'waiting');
  store.receive(report(a.id, 1_000_003, 'mirador:attention', { blocked: 'guarded command' }, ['prompt']));
  assert.equal(store.agentState(a.id), 'waiting');
  store.receive(report(a.id, 1_000_004, 'mirador:attention', { finished: 't-1' }, ['blocked']));
  assert.equal(store.agentState(a.id), 'finished');
  // Seen by the user: still finished (its turn is over), though it left the inbox.
  store.dismiss(a.id);
  assert.equal(store.agentState(a.id), 'finished');
  store.receive(report(a.id, 1_000_005, 'mirador:attention', {}, ['finished']));
  assert.equal(store.agentState(a.id), 'working');
  // gentle-shell alone (no bridge): its in-progress Todo means working.
  const b = registry.create(agent('b'));
  store.receive(report(b.id, 1_000_001, 'gentle:activity', { summary: 'Fix the bug' }));
  assert.equal(store.agentState(b.id), 'working');
  assert.deepEqual(changes, [[a.id, 'working'], [a.id, 'waiting'], [a.id, 'finished'], [a.id, 'working'], [b.id, 'working']]);
  assert.equal(store.agentState('nope'), 'unknown');
});

test('a change to finished is written with the record after the debounce, and read back after a restart', async () => {
  const { file, owner, log } = await place();
  const { registry } = setup();
  const timers = fakeTimers();
  const store = await OpenAgents.load(file, { owner, log, schedule: timers.schedule });
  store.track(registry);
  const a = registry.create(agent('a'));
  const b = registry.create(agent('b'));
  await store.flush();
  assert.equal(store.recordState(a.id, 'finished'), true);
  assert.equal(store.recordState(b.id, 'finished'), true);
  assert.equal(store.recordState('unknown-id', 'finished'), false);
  await store.flush();
  assert.deepEqual((await read(file)).agents.map((r) => r.lastState), [undefined, undefined], 'not written before the debounce ends');
  assert.deepEqual(timers.timers.filter((t) => !t.cancelled).map((t) => t.ms), [1000], 'one pending write for every change');
  timers.fire();
  await store.flush();
  assert.deepEqual((await read(file)).agents.map((r) => [r.rel, r.lastState]), [['a', 'finished'], ['b', 'finished']]);

  // The server's own stop: a pending change is written at once, and later reports (pi says goodbye) are ignored.
  assert.equal(store.recordState(b.id, 'finished'), true);
  store.keep();
  assert.equal(store.recordState(a.id, 'working'), false);
  registry.closeAll();
  await store.flush();
  assert.deepEqual((await read(file)).agents.map((r) => [r.rel, r.lastState]), [['a', 'finished'], ['b', 'finished']]);

  const next = await OpenAgents.load(file, { owner, log });
  const second = setup();
  next.track(second.registry);
  await next.restore({ registry: second.registry, resolveFolder, sessionArgs, gate: roomy(), sleep: async () => undefined });
  assert.deepEqual(next.sleeping().map((s) => s.rel), ['a', 'b']);
  await next.flush();
});

test('a change that would reopen the agent (working, waiting) is written at once, so a crash right after it never leaves the agent asleep', async () => {
  const { file, owner, log } = await place();
  const { registry } = setup();
  const timers = fakeTimers();
  const store = await OpenAgents.load(file, { owner, log, schedule: timers.schedule });
  store.track(registry);
  const a = registry.create(agent('a'));
  await store.flush();
  assert.equal(store.recordState(a.id, 'finished'), true);
  await store.flush();
  assert.deepEqual((await read(file)).agents.map((r) => r.lastState), [undefined], 'finished waits for the debounce');
  // The agent asks the user something 0.45 s later and the server is killed before the debounce ends.
  assert.equal(store.recordState(a.id, 'waiting'), true);
  await store.flush();
  assert.deepEqual((await read(file)).agents.map((r) => r.lastState), ['waiting'], 'written without firing any timer');
  assert.deepEqual(timers.timers.filter((t) => !t.cancelled).map((t) => t.ms), [], 'the pending finished write is dropped');
});

// An agent whose program stopped with an error (OSC 7501
// state=error) waits for the user like a blocked one: its record says so at once and it reopens.
test('an agent stopped with an error is recorded as error at once, and reopens at the next start instead of sleeping', async () => {
  const { file, owner, log } = await place();
  const { registry } = setup();
  const timers = fakeTimers();
  const store = await OpenAgents.load(file, { owner, log, schedule: timers.schedule });
  store.track(registry);
  const attention = new AttentionStore({ now: () => 1_000_000 });
  registry.subscribe((event) => attention.track(event));
  attention.onAgentState((id, state) => void store.recordState(id, state));
  const a = registry.create(agent('broken'));
  const b = registry.create(agent('done'));
  attention.programStatus(a.id, { id: '', state: 'error', msg: 'Build failed' });
  // The agent leaves after its error; the prompt bash draws next drops only working and blocked.
  attention.programPrompt(a.id);
  assert.equal(attention.agentState(a.id), 'error');
  await store.flush();
  assert.deepEqual((await read(file)).agents.map((r) => [r.rel, r.lastState]), [['broken', 'error'], ['done', undefined]], 'written without firing any timer');
  assert.deepEqual(timers.timers.filter((t) => !t.cancelled), []);
  attention.programStatus(b.id, { id: '', state: 'done' });
  timers.fire();
  store.keep();
  registry.closeAll();
  await store.flush();
  assert.deepEqual((await read(file)).agents.map((r) => [r.rel, r.lastState]), [['broken', 'error'], ['done', 'finished']]);

  const next = await OpenAgents.load(file, { owner, log });
  const second = setup();
  next.track(second.registry);
  assert.deepEqual(await next.restore({ registry: second.registry, resolveFolder, sessionArgs, gate: roomy(), sleep: async () => undefined }), { restored: 1, dropped: 0 });
  assert.deepEqual(running(second.registry), ['broken'], 'the agent in error reopens');
  assert.deepEqual(next.sleeping().map((s) => s.rel), ['done'], 'only the finished one sleeps');
  await next.flush();
});

test('at the start only agents that were working or waiting reopen; finished ones sleep; unknown (an older file) reopens', async () => {
  const { file, owner, logs, log } = await place();
  await previousRun(file, owner, [
    { rel: 'working', lastState: 'working' },
    { rel: 'done', lastState: 'finished', sessionFile: '/s/done.jsonl' },
    { rel: 'waiting', lastState: 'waiting' },
    { rel: 'old' },
    { rel: 'odd', lastState: 'bogus' },
  ]);
  const { registry } = setup();
  const store = await OpenAgents.load(file, { owner, log });
  store.track(registry);
  const gate = roomy();
  const ended: string[][] = [];
  assert.deepEqual(await store.restore({ registry, resolveFolder, sessionArgs, gate, sleep: async () => undefined, endPrevious: async (records) => (ended.push(records.map((r) => r.rel)), []) }), { restored: 4, dropped: 0 });
  assert.deepEqual(ended, [['working', 'done', 'waiting', 'old', 'odd']], 'every previous scope is ended first (R1), sleepers included');
  assert.deepEqual(running(registry), ['odd', 'old', 'waiting', 'working']);
  assert.deepEqual(store.sleeping(), [{ id: 'old-1', workspaceId: 'dev', rel: 'done', createdAt: '2026-10-29T00:00:00.000Z', resumable: true }]);
  const [run] = gate.status().runs;
  assert.deepEqual([run.kind, run.total, run.opened, run.sleeping], ['restore', 4, 4, 1], 'the bar counts only the agents reopened, and names the sleepers');
  await store.flush();
  const saved = (await read(file)).agents;
  assert.deepEqual(saved.map((r) => r.rel), ['done', 'working', 'waiting', 'old', 'odd'], 'the sleeper keeps its record; the reopened replace theirs');
  assert.equal(saved[0].lastState, 'finished');
  assert.equal(saved[0].sessionFile, '/s/done.jsonl');
  assert.match(logs.join('\n'), /1 open agent\(s\) sleep/);
});

test('a sleeping agent survives further restarts until woken or forgotten', async () => {
  const { file, owner, log } = await place();
  await previousRun(file, owner, [{ rel: 'a', lastState: 'finished' }, { rel: 'b', lastState: 'working' }]);
  for (let start = 0; start < 2; start++) {
    const { registry } = setup();
    const store = await OpenAgents.load(file, { owner, log });
    store.track(registry);
    await store.restore({ registry, resolveFolder, sessionArgs, gate: roomy(), sleep: async () => undefined });
    assert.deepEqual(running(registry), ['b'], `start ${start + 1}`);
    assert.deepEqual(store.sleeping().map((s) => s.rel), ['a'], `start ${start + 1}`);
    store.keep();
    registry.closeAll();
    await store.flush();
  }
  assert.deepEqual((await read(file)).agents.map((r) => r.rel).sort(), ['a', 'b']);
});

test('Despertar reopens a sleeping agent through the gate, continuing its session, and its terminal replaces the record', async () => {
  const { dir, file, owner, log } = await place();
  const session = join(dir, 'a.jsonl');
  await writeFile(session, '{}\n');
  await previousRun(file, owner, [{ rel: 'a', lastState: 'finished', sessionFile: session }, { rel: 'b', lastState: 'finished' }]);
  const { registry, spawned } = setup();
  const store = await OpenAgents.load(file, { owner, log });
  store.track(registry);
  const gate = roomy();
  await store.restore({ registry, resolveFolder, sessionArgs, gate, sleep: async () => undefined });
  assert.equal(registry.list().length, 0);
  assert.equal(store.wake({ id: 'nope' }), null, 'an unknown id wakes nothing');
  const woken = store.wake({ id: 'old-0' });
  assert.ok(woken);
  assert.equal(woken.count, 1);
  assert.deepEqual(store.sleeping().map((s) => s.rel), ['b'], 'it leaves the sleeping list at once');
  assert.equal(store.wake({ id: 'old-0' }), null, 'a second wake of the same agent wakes nothing');
  assert.deepEqual(await woken.done, { restored: 1, dropped: 0 });
  assert.deepEqual(running(registry), ['a']);
  assert.equal(spawned[0].env.MIRADOR_AGENT_COMMAND, `gentle-shell '--session' '${session}'`);
  const run = gate.status().runs.find((r) => r.id === woken.runId);
  assert.deepEqual([run?.kind, run?.total, run?.opened, run?.state], ['wake', 1, 1, 'done']);
  await store.flush();
  const saved = (await read(file)).agents;
  assert.deepEqual(saved.map((r) => [r.rel, r.sessionFile]), [['b', null], ['a', session]]);
  assert.equal(saved[1].id, registry.list()[0].id);
});

test('a wake while another launch run is active waits its turn in the gate instead of failing', async () => {
  const { file, owner, log } = await place();
  await previousRun(file, owner, [{ rel: 'w1', lastState: 'working' }, { rel: 'w2', lastState: 'working' }, { rel: 's', lastState: 'finished' }]);
  const { registry } = setup();
  const store = await OpenAgents.load(file, { owner, log });
  store.track(registry);
  let settle!: () => void;
  const gate = new LaunchGate({
    limits: { batchSize: 1, settleMs: 60_000, reserveBytes: 0 },
    readMemory: async () => ({ memTotal: 1, memAvailable: 1 }),
    sleep: (_ms, signal) => new Promise((resolve) => {
      settle = () => resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    }),
  });
  const restoring = store.restore({ registry, resolveFolder, sessionArgs, gate, sleep: async () => undefined });
  while (running(registry).length < 1 || !gate.status().runs[0]?.wait) await new Promise((resolve) => setTimeout(resolve, 5));
  const woken = store.wake({ id: 'old-2' });
  assert.ok(woken, 'queued, not refused');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const wake = gate.status().runs.find((r) => r.id === woken.runId);
  assert.deepEqual([wake?.state, wake?.wait?.reason], ['running', 'turn'], 'it waits behind the restore');
  assert.deepEqual(running(registry), ['w1']);
  settle();
  await restoring;
  while (running(registry).length < 3) {
    settle();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(await woken.done, { restored: 1, dropped: 0 });
  assert.deepEqual(running(registry), ['s', 'w1', 'w2']);
  await store.flush();
});

test('Olvidar drops a sleeping record for good; an unknown or awake id forgets nothing', async () => {
  const { file, owner, log } = await place();
  await previousRun(file, owner, [{ rel: 'a', lastState: 'finished' }, { rel: 'b', lastState: 'working' }]);
  const { registry } = setup();
  const store = await OpenAgents.load(file, { owner, log });
  store.track(registry);
  await store.restore({ registry, resolveFolder, sessionArgs, gate: roomy(), sleep: async () => undefined });
  assert.equal(store.forgetSleeping('nope'), false);
  assert.equal(store.forgetSleeping(registry.list()[0].id), false, 'a running agent is not a sleeping one');
  assert.equal(store.forgetSleeping('old-0'), true);
  assert.deepEqual(store.sleeping(), []);
  await store.flush();
  assert.deepEqual((await read(file)).agents.map((r) => r.rel), ['b']);
  assert.equal(store.forgetSleeping('old-0'), false);
});

// The inbox stream reports this number so a window that watches only the stream learns about a
// forget in another one (#91). Without the forget, the route would keep reporting the stale count.
test('the number the stream reports follows the sleeping list after a forget', async () => {
  const { file, owner, log } = await place();
  await previousRun(file, owner, [
    { rel: 'a', lastState: 'finished' },
    { rel: 'b', lastState: 'finished' },
  ]);
  const { registry } = setup();
  const store = await OpenAgents.load(file, { owner, log });
  store.track(registry);
  await store.restore({ registry, resolveFolder, sessionArgs, gate: roomy(), sleep: async () => undefined });
  const before = store.sleeping().length;
  assert.equal(before, 2);
  assert.equal(store.forgetSleeping(store.sleeping()[0].id), true);
  assert.equal(store.sleeping().length, before - 1);
  await store.flush();
});

test('Despertar todos wakes every sleeping agent (or one workspace\'s) in batches through the gate', async () => {
  const { file, owner, log } = await place();
  await previousRun(file, owner, [
    ...['a', 'b', 'c', 'd'].map((rel) => ({ rel, lastState: 'finished' })),
    { workspaceId: 'ops', rel: 'e', lastState: 'finished' },
  ]);
  const { registry } = setup();
  const store = await OpenAgents.load(file, { owner, log });
  store.track(registry);
  const timeline: string[] = [];
  let clock = 0;
  registry.subscribe(({ type, info }) => type === 'created' && timeline.push(`open ${info.rel}`));
  const gate = new LaunchGate({
    limits: { batchSize: 2, settleMs: 30_000, reserveBytes: 0 },
    now: () => clock,
    readMemory: async () => ({ memTotal: 1, memAvailable: 1 }),
    sleep: async (ms) => { timeline.push(`wait ${ms}`); clock += ms; },
  });
  const pause = async (ms: number) => { timeline.push(`sleep ${ms}`); clock += ms; };
  await store.restore({ registry, resolveFolder, sessionArgs, gate, delayMs: 2000, sleep: pause });
  const woken = store.wake({ workspaceId: 'dev' });
  assert.equal(woken?.count, 4);
  assert.deepEqual(store.sleeping().map((s) => s.rel), ['e'], 'only that workspace');
  await woken?.done;
  assert.deepEqual(timeline, ['open a', 'sleep 2000', 'open b', 'sleep 2000', 'wait 28000', 'open c', 'sleep 2000', 'open d']);
  const all = store.wake();
  assert.equal(all?.count, 1);
  await all?.done;
  assert.deepEqual(running(registry), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(store.wake(), null, 'nothing left to wake');
  await store.flush();
});

test('a wake cut short by low memory leaves the rest asleep', async () => {
  const { file, owner, log } = await place();
  await previousRun(file, owner, [{ rel: 'a', lastState: 'finished' }, { rel: 'b', lastState: 'finished' }]);
  const { registry } = setup();
  const store = await OpenAgents.load(file, { owner, log });
  store.track(registry);
  let reads = 0;
  const gate = new LaunchGate({ limits: { maxWaitMs: 0 }, readMemory: async () => ({ memTotal: 24 * 1024 ** 3, memAvailable: ++reads <= 1 ? 10 * 1024 ** 3 : 1024 ** 3 }), sleep: async () => undefined });
  await store.restore({ registry, resolveFolder, sessionArgs, gate, sleep: async () => undefined });
  const woken = store.wake();
  assert.deepEqual(await woken?.done, { restored: 1, dropped: 0 });
  assert.deepEqual(running(registry), ['a']);
  assert.deepEqual(store.sleeping().map((s) => s.rel), ['b']);
  const run = gate.status().runs.find((r) => r.id === woken?.runId);
  assert.deepEqual([run?.lowMemory, run?.notOpened], [1, [{ workspaceId: 'dev', rel: 'b' }]]);
  await store.flush();
});

test('an agent opened by hand in a sleeping agent\'s folder replaces that sleeping record', async () => {
  const { file, owner, log } = await place();
  await previousRun(file, owner, [{ rel: 'p', lastState: 'finished' }, { rel: 'q', lastState: 'finished' }]);
  const { registry } = setup();
  const store = await OpenAgents.load(file, { owner, log });
  store.track(registry);
  await store.restore({ registry, resolveFolder, sessionArgs, gate: roomy(), sleep: async () => undefined });
  registry.create(agent('p'));
  assert.deepEqual(store.sleeping().map((s) => s.rel), ['q']);
  await store.flush();
  assert.deepEqual((await read(file)).agents.map((r) => r.rel).sort(), ['p', 'q']);
  store.keep();
  await store.flush();
  // Next start: p reopens once (its live record, state unknown), q still sleeps.
  const next = await OpenAgents.load(file, { owner, log });
  const second = setup();
  next.track(second.registry);
  await next.restore({ registry: second.registry, resolveFolder, sessionArgs, gate: roomy(), sleep: async () => undefined });
  assert.deepEqual(running(second.registry), ['p']);
  assert.deepEqual(next.sleeping().map((s) => s.rel), ['q']);
  await next.flush();
});

test('an agent still running from the previous run is neither reopened nor listed as sleeping, as before (R1)', async () => {
  const { file, owner, log } = await place();
  await previousRun(file, owner, [{ rel: 'a', lastState: 'finished' }, { rel: 'b', lastState: 'working' }]);
  const { registry } = setup();
  const store = await OpenAgents.load(file, { owner, log });
  store.track(registry);
  await store.restore({ registry, resolveFolder, sessionArgs, gate: roomy(), sleep: async () => undefined, endPrevious: async () => ['old-0', 'old-1'] });
  assert.deepEqual(running(registry), []);
  assert.deepEqual(store.sleeping(), []);
  await store.flush();
  assert.deepEqual((await read(file)).agents.map((r) => r.rel), ['a', 'b'], 'both records stay so the next start stops them');
});
