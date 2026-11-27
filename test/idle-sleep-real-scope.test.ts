// Integration (#115, part B): a real systemd user scope (`systemd-run --user --scope`, as Mirador starts
// each terminal). The agent starts `sh -c 'sleep 1000 &'`; its sh exits, so the sleep leaves the agent's
// tree and stays only in the scope's cgroup.procs. When its idle clock runs out the agent is not put to
// sleep, its card names `sleep`, and the sleep keeps running. Skipped where a user scope cannot be made
// (no systemd, no user manager or bus, macOS, most CI runners). The scope is stopped afterwards.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';
import { AttentionStore } from '../src/attention/store.ts';
import { IdleSleep } from '../src/terminals/hibernate.ts';
import { backgroundCheck } from '../src/terminals/background-work.ts';
import { probeScopes, scopeUnit, stopScopes } from '../src/terminals/scopes.ts';
import { agentLaunch } from '../src/agents/catalog.ts';

const IDLE_MS = 30 * 60_000;
const problem = process.platform === 'linux' ? await probeScopes() : 'not Linux';
const SKIP = problem === null ? false : `no systemd user scope here (${problem})`;

const units: string[] = [];
const children: ChildProcess[] = [];
let scratch: string | null = null;
after(async () => {
  if (units.length) await stopScopes(units);
  for (const child of children) child.kill('SIGKILL');
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

async function waitFor<T>(check: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out');
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a real scope: an agent with a background `sleep 1000 &` is not put to sleep and the sleep keeps running', { skip: SKIP }, async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-real-scope-')));
  const pidFile = join(scratch, 'sleep.pid');
  // The agent: starts the orphan through sh, then stays idle like a finished agent.
  const agent = [
    "const { execFileSync } = require('node:child_process');",
    "execFileSync('sh', ['-c', 'sleep 1000 >/dev/null 2>&1 </dev/null & echo $! > \"$PIDFILE\"']);",
    'setInterval(() => {}, 60_000);',
  ].join('\n');
  // The registry asks for `systemd-run <flags> --unit=… -- bash …`: the same scope, with the stand-in agent in place of bash.
  const spawnInScope: SpawnFn = (file, args) => {
    const child = spawn(file, [...args.slice(0, args.indexOf('--') + 1), process.execPath, '-e', agent], { env: { ...process.env, PIDFILE: pidFile }, stdio: 'ignore' });
    children.push(child);
    const pty: PtyProcess & { pid?: number } = { pid: child.pid, onData() {}, onExit() {}, write() {}, resize() {}, kill: () => void child.kill() };
    return pty;
  };
  const registry = new TerminalRegistry(spawnInScope, {
    shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/run/mirador/agent.bashrc', env: {}, scrollbackLimit: 1000,
    scopes: true, stopScopes: (list) => stopScopes(list),
  });
  const attention = new AttentionStore();
  registry.subscribe((event) => attention.track(event));
  const timers: Array<() => void> = [];
  const slept: string[] = [];
  const logs: string[] = [];
  const idle = new IdleSleep({
    registry,
    attention,
    openAgents: { canSleep: () => true, sleep: (id) => (slept.push(id), true), resumeKey: () => 'id' },
    idleMs: IDLE_MS,
    schedule: (run, ms) => (ms === IDLE_MS && timers.push(run), () => undefined),
    log: (line) => void logs.push(line),
    background: backgroundCheck({ registry, agentCommand: 'gentle-shell', agentDir: () => join(scratch!, 'no-agent-dir') }),
  });
  idle.start();
  const info = registry.create({ cwd: scratch, kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel: 'real', ...agentLaunch('claude-code', 'gentle-shell') });
  units.push(scopeUnit('agent', info.id));
  const sleepPid = await waitFor(async () => Number((await readFile(pidFile, 'utf8')).trim()) || undefined);
  assert.equal(alive(sleepPid), true);

  attention.receive(JSON.stringify({ v: 1, cmd: 'report-metadata', pane: info.id, source: 'mirador:attention', seq: 1, ttlMs: null, tokens: { session: 's-1', finished: 't-1' }, clear: [] }));
  assert.equal(attention.agentState(info.id), 'finished');
  assert.equal(timers.length, 1, 'its idle clock runs');
  timers.shift()!();
  await idle.checked();

  assert.deepEqual(slept, [], 'not put to sleep');
  assert.equal(registry.get(info.id)?.status, 'running');
  assert.deepEqual(idle.awake(info.id), { name: 'sleep' });
  assert.ok(logs.some((line) => /stays awake/.test(line) && line.includes(String(sleepPid))), logs.join('\n'));
  assert.equal(alive(sleepPid), true, 'the sleep keeps running');
  idle.stop();
});
