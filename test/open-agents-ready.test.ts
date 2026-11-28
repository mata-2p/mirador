// The restore and a wake wait only for the records that need it (#124): RestoreOptions.ready names, per record's
// agent, what must be done before it starts (the server: opencode's version and bridge), null when it may start now.
// Records that may start now reopen at once, the others once that is done; nothing starts once the shutdown began
// (keep()), and a restore asked for after it does nothing. Real registry with a fake pty, real files in a scratch dir.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAgents, type OpenAgentRecord, type RestoreOptions } from '../src/terminals/open-agents.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';

const scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-open-agents-ready-')));
after(() => rm(scratch, { recursive: true, force: true }));

class FakePty implements PtyProcess {
  private exitListeners: Array<(e: { exitCode: number }) => void> = [];
  onData() {}
  onExit(listener: (e: { exitCode: number }) => void) { this.exitListeners.push(listener); }
  write() {}
  resize() {}
  kill() { this.exitListeners.forEach((l) => l({ exitCode: 0 })); }
}

function setup() {
  const spawn: SpawnFn = () => new FakePty();
  return new TerminalRegistry(spawn, { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/run/mirador/agent.bashrc', env: { HOME: '/home/u' }, scrollbackLimit: 1000 });
}

let counter = 0;
/** A state file holding `agents` as a previous run left them, owned by an existing config. */
async function place(agents: Array<Partial<OpenAgentRecord>>) {
  const dir = join(scratch, `case-${++counter}`);
  await mkdir(dir, { recursive: true });
  const owner = join(dir, 'config.json');
  await writeFile(owner, '{}');
  const file = join(dir, 'open-agents.json');
  const full = agents.map((record, i) => ({ id: `old-${i}`, workspaceId: 'dev', rel: '', cwd: '/old', cols: 100, rows: 30, sessionFile: null, createdAt: '2026-11-20T00:00:00.000Z', ...record }));
  await writeFile(file, JSON.stringify({ owner, agents: full }), { mode: 0o600 });
  const logs: string[] = [];
  return { file, owner, logs, log: (line: string) => void logs.push(line) };
}

const resolveFolder = async (_workspaceId: string, rel: string) => ({ workspace: { id: 'dev' }, rel, path: `/w/${rel}` });
const agentLaunch = (agent: string) => (agent === 'opencode' ? { agent, agentCommand: 'opencode' } : null);
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A gate that opens when `open()` is called: what the server's opencode version and bridge are. */
function opencodeGate() {
  let open!: () => void;
  const done = new Promise<void>((resolve) => (open = resolve));
  let known = false;
  void done.then(() => (known = true));
  const ready: RestoreOptions['ready'] = (agent) => (agent === 'opencode' && !known ? done : null);
  return { ready, open };
}

test('the restore reopens the records that may start now at once and the opencode ones once ready, keeping their record order otherwise', async () => {
  const { file, owner, log } = await place([{ rel: 'oc', agent: 'opencode', lastState: 'working' }, { rel: 'a', lastState: 'working' }, { rel: 'b' }]);
  const registry = setup();
  const store = await OpenAgents.load(file, { owner, log });
  store.track(registry);
  const { ready, open } = opencodeGate();
  const restoring = store.restore({ registry, resolveFolder, sessionArgs: () => [], agentLaunch, ready, sleep: async () => undefined });
  for (let i = 0; i < 20 && registry.list().length < 2; i++) await tick();
  assert.deepEqual(registry.list().map((t) => t.rel), ['a', 'b'], 'the others at once');
  await tick();
  assert.deepEqual(registry.list().map((t) => t.rel), ['a', 'b'], 'the opencode record waits');
  open();
  assert.deepEqual(await restoring, { restored: 3, dropped: 0 });
  assert.deepEqual(registry.list().map((t) => [t.rel, t.agent]), [['a', undefined], ['b', undefined], ['oc', 'opencode']]);
});

test('a wake of an opencode record waits until ready; a shutdown meanwhile leaves it asleep with its record', async () => {
  const { file, owner, log } = await place([{ rel: 'oc', agent: 'opencode', lastState: 'finished' }, { rel: 'a', lastState: 'finished' }]);
  const registry = setup();
  const store = await OpenAgents.load(file, { owner, log });
  store.track(registry);
  const { ready, open } = opencodeGate();
  await store.restore({ registry, resolveFolder, sessionArgs: () => [], agentLaunch, ready, sleep: async () => undefined });
  const gentle = store.wake({ id: 'old-1' });
  assert.deepEqual(await gentle?.done, { restored: 1, dropped: 0 }, 'a record that may start now wakes at once');
  const woken = store.wake({ id: 'old-0' });
  await tick();
  assert.deepEqual(registry.list().map((t) => t.rel), ['a'], 'the opencode one waits');
  store.keep();
  open();
  assert.deepEqual(await woken?.done, { restored: 0, dropped: 0 });
  await store.flush();
  assert.deepEqual(registry.list().map((t) => t.rel), ['a'], 'nothing starts once the shutdown began');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).agents.map((r: OpenAgentRecord) => r.id).includes('old-0'), true, 'its record stays');
});

test('a shutdown while the restore waits for an opencode record starts nothing more and keeps its record', async () => {
  const { file, owner, log } = await place([{ rel: 'oc', agent: 'opencode', lastState: 'working' }]);
  const registry = setup();
  const store = await OpenAgents.load(file, { owner, log });
  store.track(registry);
  const { ready, open } = opencodeGate();
  const restoring = store.restore({ registry, resolveFolder, sessionArgs: () => [], agentLaunch, ready, sleep: async () => undefined });
  await tick();
  store.keep();
  open();
  assert.deepEqual(await restoring, { restored: 0, dropped: 0 });
  await store.flush();
  assert.equal(registry.list().length, 0);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).agents.map((r: OpenAgentRecord) => r.id), ['old-0']);
});

test('a restore asked for once the shutdown began does nothing: no previous agent is ended, nothing opens, nothing is logged or written', async () => {
  const { file, owner, logs, log } = await place([{ rel: 'a', lastState: 'working' }, { rel: 'b', lastState: 'finished' }]);
  const before = await readFile(file, 'utf8');
  const registry = setup();
  const store = await OpenAgents.load(file, { owner, log });
  store.track(registry);
  store.keep();
  const ended: string[][] = [];
  const result = await store.restore({
    registry,
    resolveFolder,
    sessionArgs: () => [],
    endPrevious: async (records) => {
      ended.push(records.map((record) => record.id));
      return [];
    },
    sleep: async () => undefined,
  });
  await store.flush();
  assert.deepEqual(result, { restored: 0, dropped: 0 });
  assert.deepEqual(ended, [], 'endPrevious is not called');
  assert.equal(registry.list().length, 0);
  assert.deepEqual(logs, []);
  assert.equal(await readFile(file, 'utf8'), before, 'the records file is left as it was');
  assert.deepEqual(store.sleeping(), [], 'no record became a sleeping one');
});
