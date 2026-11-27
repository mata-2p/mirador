// Idle sleep and the work an agent left running (#115, part B). Before a finished agent sleeps, Mirador
// reads its processes: the agent's own (the agent, a helper or MCP server it started with no shell in
// between, a process whose command line is an MCP server configured for it, even through `sh -c`) do not
// count; an orphan in its scope (kind a) or a live process below a shell it started (kind b) keeps it
// awake, with the program's name on its card and the name plus PID in Mirador's log, never the command
// line, never in browser notifications or the phone's inbox. Without scopes only kind (b) can be seen.
// Real registry, attention store, OpenAgents and routes; fake pty, fake timers, simulated /proc and
// cgroup.procs trees in a scratch dir.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAgents } from '../src/terminals/open-agents.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';
import { AttentionStore } from '../src/attention/store.ts';
import { IdleSleep, provideIdleSleep } from '../src/terminals/hibernate.ts';
import { backgroundCheck } from '../src/terminals/background-work.ts';
import { agentLaunch } from '../src/agents/catalog.ts';
import { resumeArgs } from '../src/attention/agent-args.ts';
import { LaunchGate } from '../src/system/memory-gate.ts';
import { scopeDir, type ResourceRoots } from '../src/system/resources.ts';
import { provideNightAttention } from '../src/night/service.ts';
import { terminalRoutes } from '../src/http/routes/terminals.ts';
import { cardNotification } from '../public/features/inbox-notify-model.js';

// Untyped browser modules, loaded as the other wiring tests load them.
const { buildTracking } = await import(new URL('../public/features/tracking-model.js', import.meta.url).href);
const { translate } = await import(new URL('../public/i18n.js', import.meta.url).href);

const MINUTE = 60_000;
const IDLE_MS = 30 * MINUTE;
const UID = 4242;
const CONFIGURED = 'gentle-shell';
/** The fake secret every simulated command line carries: it must show nowhere. */
const SECRET = '--password=hunter2';

let scratch: string;
before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-idle-background-')));
});
const started: Array<{ openAgents: OpenAgents; idle: IdleSleep }> = [];
after(async () => {
  for (const { idle } of started) idle.stop();
  await Promise.all(started.map(({ openAgents }) => openAgents.flush()));
  await rm(scratch, { recursive: true, force: true });
});

class FakePty implements PtyProcess {
  readonly pid: number;
  constructor(pid: number) {
    this.pid = pid;
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
/** Report sequence numbers, as the bridges send them (the store's clock is 1_000_000). */
let seq = 1_000_000;

/** A Mirador wired as src/server.ts wires it, reading a simulated /proc and /sys. */
async function mirador({ scopes = true } = {}) {
  const place = join(scratch, `case-${++counter}`);
  await mkdir(join(place, 'state'), { recursive: true });
  const roots: ResourceRoots = { proc: join(place, 'proc'), sys: join(place, 'sys') };
  await mkdir(roots.proc, { recursive: true });
  const agentDir = join(place, 'gentle-shell-agent');
  await mkdir(agentDir, { recursive: true });
  const owner = join(place, 'config.json');
  await writeFile(owner, '{}');
  let nextPid = 0;
  const spawn: SpawnFn = () => new FakePty(nextPid);
  const stopped: string[][] = [];
  const registry = new TerminalRegistry(spawn, {
    shell: '/bin/bash', agentCommand: CONFIGURED, agentRcFile: '/run/mirador/agent.bashrc', env: {}, scrollbackLimit: 1000,
    scopes, stopScopes: async (units) => void stopped.push(units),
  });
  const attention = new AttentionStore({ now: () => 1_000_000 });
  registry.subscribe((event) => attention.track(event));
  provideNightAttention(registry, attention);
  const logs: string[] = [];
  const log = (line: string) => void logs.push(line);
  const openAgents = await OpenAgents.load(join(place, 'state', 'open-agents.json'), { owner, log, schedule: () => () => undefined, agentCommand: CONFIGURED });
  openAgents.track(registry);
  attention.onAgentState((id, state) => void openAgents.recordState(id, state));
  attention.onSession((id, session) => void openAgents.recordSessionId(id, session));
  // Its restore already ran, as in src/server.ts, so records are kept and can sleep.
  await openAgents.restore({
    registry,
    resolveFolder: async (workspaceId, rel) => ({ workspace: { id: workspaceId }, rel, path: `/w/${rel}` }),
    sessionArgs: (key, agent) => resumeArgs((agent && agentLaunch(agent, CONFIGURED)?.agentCommand) || CONFIGURED, key),
    agentLaunch: (agent) => agentLaunch(agent, CONFIGURED),
    gate: new LaunchGate({ readMemory: async () => ({ memTotal: 24 * 1024 ** 3, memAvailable: 10 * 1024 ** 3 }), sleep: async () => undefined }),
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
    idleMs: IDLE_MS,
    schedule: timers.schedule,
    log,
    background: backgroundCheck({ registry, roots, uid: UID, agentCommand: CONFIGURED, agentDir: () => agentDir }),
  });
  idle.start();
  provideIdleSleep(registry, idle);
  started.push({ openAgents, idle });
  const withPid = (pid: number) => void (nextPid = pid);
  return { place, roots, agentDir, registry, attention, openAgents, idle, notes, timers, logs, stopped, withPid };
}

type Mirador = Awaited<ReturnType<typeof mirador>>;

/** One simulated process: /proc/<pid>/status (its name, parent and owner) and /proc/<pid>/cmdline. */
async function proc(m: Mirador, pid: number, name: string, ppid: number, argv: string[] = [name]) {
  const dir = join(m.roots.proc, String(pid));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'status'), `Name:\t${name}\nUmask:\t0022\nState:\tS (sleeping)\nPid:\t${pid}\nPPid:\t${ppid}\nUid:\t${UID}\t${UID}\t${UID}\t${UID}\nVmRSS:\t    1024 kB\n`);
  await writeFile(join(dir, 'cmdline'), `${argv.join('\0')}\0`);
}
const ended = (m: Mirador, pid: number) => rm(join(m.roots.proc, String(pid)), { recursive: true, force: true });

/** /proc/<pid>/fd/0 and /1 as the kernel shows them: `socket:[n]`, `pipe:[n]`, `/dev/null`, a file. */
async function stdio(m: Mirador, pid: number, stdin: string, stdout: string) {
  const dir = join(m.roots.proc, String(pid), 'fd');
  await mkdir(dir, { recursive: true });
  await symlink(stdin, join(dir, '0'));
  await symlink(stdout, join(dir, '1'));
}

/** The scope's cgroup.procs: every process in the agent's scope. */
async function scope(m: Mirador, id: string, pids: number[]) {
  const dir = scopeDir(m.roots, UID, `mirador-agent-${id}.scope`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'cgroup.procs'), pids.map((pid) => `${pid}\n`).join(''));
}

const report = (pane: string, tokens: Record<string, string>, clear: string[] = []) =>
  JSON.stringify({ v: 1, cmd: 'report-metadata', pane, source: 'mirador:attention', seq: ++seq, ttlMs: null, tokens, clear });
const working = (m: Mirador, id: string) => m.attention.receive(report(id, {}, ['blocked', 'prompt', 'finished']));
const finished = (m: Mirador, id: string, turn: string) => m.attention.receive(report(id, { finished: turn }, ['blocked', 'prompt']));
const isOpen = (m: Mirador, id: string) => m.registry.get(id)?.status === 'running';

/** A Claude Code agent whose pty child (its bash) has pid `pid`; its first turn under way. */
function claudeIn(m: Mirador, rel: string, pid: number) {
  m.withPid(pid);
  const info = m.registry.create({ cwd: `/w/${rel}`, kind: 'agent', cols: 100, rows: 30, workspaceId: 'dev', rel, ...agentLaunch('claude-code', CONFIGURED) });
  m.attention.receive(report(info.id, { session: `sess-${rel}` }, ['blocked', 'prompt', 'finished']));
  return info.id;
}

/** The idle clock runs out `rounds` times and every background check it started is read. */
async function idleFor(m: Mirador, rounds = 1) {
  for (let round = 0; round < rounds; round++) {
    m.timers.pass(IDLE_MS);
    await m.idle.checked();
  }
}

/** GET /api/terminals as the window reads it. */
async function terminalsApi(m: Mirador): Promise<{ text: string; list: Array<Record<string, any>> }> {
  const routes = await terminalRoutes({ terminals: m.registry, config: { agentCommand: CONFIGURED } } as never);
  const route = routes.find((r) => r.method === 'GET' && r.path === '/api/terminals')!;
  let text = '';
  await route.handler({ res: { writeHead() { return this; }, end(body: string) { text = body; } } } as never);
  return { text, list: JSON.parse(text) };
}

/** What the inbox (GET /api/inbox and its stream) sends: what browser notifications and the phone's inbox read. */
function inboxPayload(m: Mirador): string {
  return JSON.stringify({ items: m.attention.items(), nightNotes: m.attention.nightNotes() });
}

const SLEEPS = /^mirador: .* sleeps: /;
const AWAKE = /stays awake/;

test('an MCP server the agent started with no shell between them (node) is its own: the agent sleeps and its scope is stopped', async () => {
  const m = await mirador();
  const id = claudeIn(m, 'mcp-child', 5000);
  await proc(m, 5000, 'bash', 1, ['bash', '--rcfile', '/run/mirador/agent.bashrc', '-i']);
  await proc(m, 5001, 'claude', 5000, ['claude', '--resume', 'sess-mcp-child']);
  await proc(m, 5002, 'node', 5001, ['node', '/opt/mcp/server.js', SECRET]);
  await scope(m, id, [5000, 5001, 5002]);
  finished(m, id, 't-1');
  await idleFor(m);
  assert.equal(m.registry.get(id), undefined, 'asleep');
  assert.deepEqual(m.stopped, [[`mirador-agent-${id}`]], 'its scope is stopped, the MCP server with it');
  assert.equal(m.logs.filter((line) => SLEEPS.test(line)).length, 1);
  assert.equal(m.logs.filter((line) => AWAKE.test(line)).length, 0);
});

test('an MCP server launched with `sh -c` whose command line is one configured for that agent is its own: the agent sleeps', async () => {
  const m = await mirador();
  await writeFile(join(m.agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { acme: { command: 'npx', args: ['-y', '@acme/mcp', SECRET] } } }));
  m.withPid(5100);
  const info = m.registry.create({ cwd: '/w/pi-mcp', kind: 'agent', cols: 100, rows: 30, workspaceId: 'dev', rel: 'pi-mcp', ...agentLaunch('pi', CONFIGURED) });
  const sessionFile = join(m.place, 'pi-mcp.jsonl');
  await writeFile(sessionFile, '{}\n');
  assert.equal(await m.openAgents.recordSession(info.id, sessionFile), true);
  working(m, info.id);
  await proc(m, 5100, 'bash', 1);
  await proc(m, 5101, 'node', 5100, ['node', '/opt/gentle-shell/gentle-shell.mjs', '--session', sessionFile]);
  await proc(m, 5102, 'sh', 5101, ['sh', '-c', `npx -y @acme/mcp ${SECRET}`]);
  await proc(m, 5103, 'node', 5102, ['node', '/usr/lib/node_modules/npm/bin/npx-cli.js', '-y', '@acme/mcp', SECRET]);
  await scope(m, info.id, [5100, 5101, 5102, 5103]);
  finished(m, info.id, 't-1');
  await idleFor(m);
  assert.deepEqual(m.notes, [info.id], 'nothing keeps it awake: it is asked to save before it sleeps');
  working(m, info.id);
  finished(m, info.id, 't-2');
  assert.equal(m.registry.get(info.id), undefined, 'asleep');
  assert.deepEqual(m.stopped, [[`mirador-agent-${info.id}`]]);
});

test('an MCP server the agent started through a shell (`bash start.sh`, `sh -c \'…; exit\'`), its stdin and stdout connected to the agent, is its own: the agent sleeps', async () => {
  const m = await mirador();
  const id = claudeIn(m, 'mcp-shell', 5050);
  await proc(m, 5050, 'bash', 1, ['bash', '--rcfile', '/run/mirador/agent.bashrc', '-i']);
  await proc(m, 5051, 'claude', 5050, ['claude', '--resume', 'sess-mcp-shell']);
  // Claude Code (Bun) hands its MCP servers socket pairs; an agent built on Node hands them pipes.
  await proc(m, 5052, 'bash', 5051, ['bash', '/opt/mcp/start.sh', SECRET]);
  await stdio(m, 5052, 'socket:[700]', 'socket:[701]');
  await proc(m, 5053, 'node', 5052, ['node', '/opt/mcp/server.js', SECRET]);
  await stdio(m, 5053, 'socket:[700]', 'socket:[701]');
  await proc(m, 5054, 'sh', 5051, ['sh', '-c', `node /opt/mcp/other.js ${SECRET}; exit $?`]);
  await stdio(m, 5054, 'pipe:[710]', 'pipe:[711]');
  await proc(m, 5055, 'node', 5054, ['node', '/opt/mcp/other.js', SECRET]);
  await stdio(m, 5055, 'pipe:[710]', 'pipe:[711]');
  await scope(m, id, [5050, 5051, 5052, 5053, 5054, 5055]);
  finished(m, id, 't-1');
  await idleFor(m);
  assert.equal(m.idle.awake(id), null);
  assert.equal(m.registry.get(id), undefined, 'asleep');
  assert.deepEqual(m.stopped, [[`mirador-agent-${id}`]], 'its scope is stopped, its MCP servers with it');
  assert.deepEqual(m.openAgents.sleeping().map((s) => s.id), [id]);
  assert.equal(m.logs.filter((line) => SLEEPS.test(line)).length, 1);
  assert.equal(m.logs.filter((line) => AWAKE.test(line)).length, 0);
});

test('a background job its Bash tool left running (stdin /dev/null, output to a file or a pipe) still keeps the agent awake', async () => {
  const m = await mirador();
  // Claude Code's run_in_background, as seen live: `bash -c …` with stdin /dev/null and its output in a task file.
  const id = claudeIn(m, 'bg-file', 5060);
  await proc(m, 5060, 'bash', 1);
  await proc(m, 5061, 'claude', 5060);
  await proc(m, 5062, 'bash', 5061, ['/bin/bash', '-c', `sleep 90 ${SECRET}`]);
  await stdio(m, 5062, '/dev/null', '/tmp/claude-1000/tasks/b1.output');
  await proc(m, 5063, 'sleep', 5062, ['sleep', '90']);
  await stdio(m, 5063, '/dev/null', '/tmp/claude-1000/tasks/b1.output');
  await scope(m, id, [5060, 5061, 5062, 5063]);
  // A tool shell whose output the agent reads through a pipe, its stdin closed.
  const other = claudeIn(m, 'bg-pipe', 5070);
  await proc(m, 5070, 'bash', 1);
  await proc(m, 5071, 'claude', 5070);
  await proc(m, 5072, 'bash', 5071, ['/bin/bash', '-c', 'npm run dev']);
  await stdio(m, 5072, '/dev/null', 'pipe:[720]');
  await proc(m, 5073, 'npm', 5072, ['npm', 'run', 'dev']);
  await scope(m, other, [5070, 5071, 5072, 5073]);
  finished(m, id, 't-1');
  finished(m, other, 't-1');
  await idleFor(m);
  assert.equal(isOpen(m, id), true);
  assert.equal(isOpen(m, other), true);
  assert.deepEqual(m.stopped, []);
  assert.deepEqual(m.idle.awake(id), { name: 'sleep' });
  assert.deepEqual(m.idle.awake(other), { name: 'npm' });
  assert.equal(m.logs.filter((line) => AWAKE.test(line)).length, 2);
});

test('an orphan in the scope (`sh -c \'sleep 1000 &\'`) keeps the agent awake: its name on the card, one log line with name and PID across several checks', async () => {
  const m = await mirador();
  const id = claudeIn(m, 'orphan', 5200);
  await proc(m, 5200, 'bash', 1);
  await proc(m, 5201, 'claude', 5200, ['claude', '--resume', 'sess-orphan']);
  // Its sh exited: the sleep was handed to the user's manager and no longer descends from the agent.
  await proc(m, 6000, 'sleep', 900, ['sleep', '1000', SECRET]);
  await scope(m, id, [5200, 5201, 6000]);
  finished(m, id, 't-1');
  await idleFor(m, 3);
  assert.equal(isOpen(m, id), true, 'not put to sleep');
  assert.deepEqual(m.stopped, []);
  assert.deepEqual(m.openAgents.sleeping(), []);
  assert.equal(m.timers.armed(IDLE_MS), 1, 'its clock keeps running: checked again at the next tick');
  assert.deepEqual(m.idle.awake(id), { name: 'sleep' });

  const awakeLines = m.logs.filter((line) => AWAKE.test(line));
  assert.equal(awakeLines.length, 1, 'one log line per reason, not per check');
  assert.match(awakeLines[0], /\bsleep\b/);
  assert.match(awakeLines[0], /\b6000\b/, 'the log names its PID');

  const api = await terminalsApi(m);
  assert.deepEqual(api.list.find((t) => t.id === id)?.awake, { name: 'sleep' }, 'GET /api/terminals carries the name only');
  const model = buildTracking({ terminals: api.list, items: m.attention.items(), activity: [], now: Date.now() });
  const card = model.workspaces.flatMap((w: any) => w.folders.flatMap((f: any) => f.agents)).find((a: any) => a.id === id);
  assert.equal(card.state, 'finished');
  assert.equal(card.awake, 'sleep');
  assert.equal(translate('en', 'tracking.awake', { name: card.awake }), 'Awake: sleep is still running');
  assert.equal(translate('es', 'tracking.awake', { name: card.awake }), 'Despierto: sleep sigue corriendo');

  // Another program now: a new reason, a new line.
  await ended(m, 6000);
  await proc(m, 6001, 'npm', 900, ['npm', 'run', 'dev', SECRET]);
  await scope(m, id, [5200, 5201, 6001]);
  await idleFor(m, 2);
  assert.deepEqual(m.idle.awake(id), { name: 'npm' });
  assert.equal(m.logs.filter((line) => AWAKE.test(line)).length, 2, 'a new line only when the reason changes');
  assert.match(m.logs.filter((line) => AWAKE.test(line))[1], /\bnpm\b.*\b6001\b/);

  // It ends: the card line goes away within a minute, and the next tick puts the agent to sleep.
  await ended(m, 6001);
  await scope(m, id, [5200, 5201]);
  m.timers.pass(MINUTE);
  await m.idle.checked();
  assert.equal(m.idle.awake(id), null, 'the card line goes away when the process ends');
  assert.equal((await terminalsApi(m)).list.find((t) => t.id === id)?.awake, undefined);
  assert.equal(isOpen(m, id), true, 'the clock decides when it sleeps');
  await idleFor(m);
  assert.equal(m.registry.get(id), undefined, 'asleep at the next tick');
  assert.deepEqual(m.stopped, [[`mirador-agent-${id}`]]);
});

test('a live shell child after the turn finished (a background job) keeps the agent awake', async () => {
  const m = await mirador();
  const id = claudeIn(m, 'shell-child', 5300);
  await proc(m, 5300, 'bash', 1);
  await proc(m, 5301, 'claude', 5300);
  await proc(m, 5302, 'bash', 5301, ['/bin/bash', '-c', `npm run dev ${SECRET}`]);
  await proc(m, 5303, 'npm', 5302, ['npm', 'run', 'dev', SECRET]);
  await scope(m, id, [5300, 5301, 5302, 5303]);
  finished(m, id, 't-1');
  await idleFor(m, 2);
  assert.equal(isOpen(m, id), true);
  assert.deepEqual(m.stopped, []);
  assert.deepEqual(m.idle.awake(id), { name: 'npm' }, 'the program, not the shell that runs it');
  const lines = m.logs.filter((line) => AWAKE.test(line));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\bnpm\b.*\b5303\b/);
});

test('no extra process: the agent sleeps and its scope is stopped', async () => {
  const m = await mirador();
  const id = claudeIn(m, 'alone', 5400);
  await proc(m, 5400, 'bash', 1);
  await proc(m, 5401, 'claude', 5400);
  await scope(m, id, [5400, 5401]);
  finished(m, id, 't-1');
  await idleFor(m);
  assert.equal(m.registry.get(id), undefined);
  assert.deepEqual(m.stopped, [[`mirador-agent-${id}`]]);
  assert.deepEqual(m.openAgents.sleeping().map((s) => s.id), [id]);
});

test('the reason never carries the command line, and it is absent from browser notifications and the phone’s inbox', async () => {
  const m = await mirador();
  const id = claudeIn(m, 'secret', 5500);
  await proc(m, 5500, 'bash', 1);
  await proc(m, 5501, 'claude', 5500);
  await proc(m, 6500, 'sleep', 900, ['sleep', '1000', SECRET]);
  await scope(m, id, [5500, 5501, 6500]);
  finished(m, id, 't-1');
  await idleFor(m, 2);
  assert.deepEqual(m.idle.awake(id), { name: 'sleep' });

  const api = await terminalsApi(m);
  const model = buildTracking({ terminals: api.list, items: m.attention.items(), activity: [], now: Date.now() });
  const card = model.workspaces.flatMap((w: any) => w.folders.flatMap((f: any) => f.agents)).find((a: any) => a.id === id);
  const shown = [translate('en', 'tracking.awake', { name: card.awake }), translate('es', 'tracking.awake', { name: card.awake })];
  const inbox = inboxPayload(m);
  const items = m.attention.items();
  assert.ok(items.some((item) => item.terminalId === id && item.kind === 'finished'), 'its finished card is in the inbox');
  const notifications = JSON.stringify(items.map((item) => cardNotification(item, { reason: 'Finished its turn', workspace: 'dev', agent: 'claude', lang: 'en' })));
  for (const [where, text] of [['card', JSON.stringify(card) + shown.join('\n')], ['log', m.logs.join('\n')], ['GET /api/terminals', api.text], ['inbox (phone)', inbox], ['notification', notifications]] as const) {
    for (const leak of ['hunter2', '--password']) assert.equal(text.includes(leak), false, `${where} holds no argument (${leak})`);
  }
  for (const [where, text] of [['inbox (phone)', inbox], ['notification', notifications]] as const) {
    assert.equal(/still running|sigue corriendo|awake|despierto/i.test(text), false, `${where} carries no reason`);
    assert.equal(/\bsleep\b/.test(text), false, `${where} does not name the program`);
  }
});

test('without scopes an orphan is not seen and the agent sleeps as before (the documented limit, #1)', async () => {
  const m = await mirador({ scopes: false });
  const id = claudeIn(m, 'no-scopes', 5600);
  await proc(m, 5600, 'bash', 1);
  await proc(m, 5601, 'claude', 5600);
  await proc(m, 6600, 'sleep', 900, ['sleep', '1000']);
  // Even a cgroup file at the scope's place is not read: there is no scope.
  await scope(m, id, [5600, 5601, 6600]);
  finished(m, id, 't-1');
  await idleFor(m);
  assert.equal(m.registry.get(id), undefined, 'asleep');
  assert.deepEqual(m.stopped, [], 'no scope to stop');
  assert.equal(m.logs.filter((line) => AWAKE.test(line)).length, 0);
});

test('without scopes a live shell child (kind b) still keeps the agent awake', async () => {
  const m = await mirador({ scopes: false });
  const id = claudeIn(m, 'no-scopes-shell', 5700);
  await proc(m, 5700, 'bash', 1);
  await proc(m, 5701, 'claude', 5700);
  await proc(m, 5702, 'sh', 5701, ['sh', '-c', 'sleep 1000']);
  await proc(m, 5703, 'sleep', 5702, ['sleep', '1000']);
  finished(m, id, 't-1');
  await idleFor(m);
  assert.equal(isOpen(m, id), true);
  assert.deepEqual(m.idle.awake(id), { name: 'sleep' });
});

test('with a 1 min threshold (the clock and the 60 s re-read of the reason in the same tick) the agent sleeps once the work ends, without a new turn', async () => {
  const m = await mirador();
  m.idle.setIdleMs(MINUTE);
  const id = claudeIn(m, 'same-tick', 5900);
  await proc(m, 5900, 'bash', 1);
  await proc(m, 5901, 'claude', 5900);
  await proc(m, 6900, 'sleep', 900);
  await scope(m, id, [5900, 5901, 6900]);
  finished(m, id, 't-1');
  m.timers.pass(MINUTE);
  await m.idle.checked();
  assert.deepEqual(m.idle.awake(id), { name: 'sleep' }, 'kept awake');
  await ended(m, 6900);
  await scope(m, id, [5900, 5901]);
  for (let minute = 0; minute < 3 && m.registry.get(id); minute++) {
    m.timers.pass(MINUTE);
    await m.idle.checked();
  }
  assert.equal(m.registry.get(id), undefined, 'asleep within three minutes of the work ending');
  assert.deepEqual(m.stopped, [[`mirador-agent-${id}`]]);
  assert.deepEqual(m.openAgents.sleeping().map((s) => s.id), [id]);
  assert.equal(m.logs.filter((line) => AWAKE.test(line)).length, 1);
  assert.equal(m.logs.filter((line) => SLEEPS.test(line)).length, 1);
});

test('typing or a new threshold while the agent is kept awake leaves its clock running: it sleeps once the work ends', async () => {
  const m = await mirador();
  m.idle.setIdleMs(MINUTE);
  const id = claudeIn(m, 'typed-awake', 5950);
  await proc(m, 5950, 'bash', 1);
  await proc(m, 5951, 'claude', 5950);
  await proc(m, 6950, 'sleep', 900);
  await scope(m, id, [5950, 5951, 6950]);
  finished(m, id, 't-1');
  m.timers.pass(MINUTE);
  await m.idle.checked();
  assert.deepEqual(m.idle.awake(id), { name: 'sleep' });
  // The user types while the clock's and the reason's checks are under way, then Settings sets 2 min.
  m.timers.pass(MINUTE);
  m.registry.write(id, 'x');
  await m.idle.checked();
  m.idle.setIdleMs(2 * MINUTE);
  await ended(m, 6950);
  await scope(m, id, [5950, 5951]);
  for (let minute = 0; minute < 4 && m.registry.get(id); minute++) {
    m.timers.pass(MINUTE);
    await m.idle.checked();
  }
  assert.equal(m.registry.get(id), undefined, 'asleep once the work ended');
  assert.deepEqual(m.stopped, [[`mirador-agent-${id}`]]);
});

test('the reason leaves when the agent starts working again', async () => {
  const m = await mirador();
  const id = claudeIn(m, 'works-again', 5800);
  await proc(m, 5800, 'bash', 1);
  await proc(m, 5801, 'claude', 5800);
  await proc(m, 6800, 'sleep', 900);
  await scope(m, id, [5800, 5801, 6800]);
  finished(m, id, 't-1');
  await idleFor(m);
  assert.deepEqual(m.idle.awake(id), { name: 'sleep' });
  working(m, id);
  assert.equal(m.idle.awake(id), null);
  assert.equal((await terminalsApi(m)).list.find((t) => t.id === id)?.awake, undefined);
});
