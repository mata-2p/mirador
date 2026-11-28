// The user chooses which offered agent opens in a folder, and a
// restored agent reopens with the same agent; only an agent with a verified resume (pi) continues
// its session (claude-code resumes only a session id its hooks reported, test/claude-bridge.test.ts).
// The real server runs with a scratch HOME, GENTLE_AI_HOME, state dir and a PATH of
// stand-in agents that record how they were started; no real agent binary ever runs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchBase } from './helpers/scratch.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

let scratch: string;
let port: number;
let base: string;
let server: ChildProcess | undefined;
let output = '';
/** The API of the server that runs now (start()). */
let api: Api;

type Api = (method: string, path: string, body?: unknown) => Promise<Response>;
type Info = { id: string; kind: string; rel: string; agent?: string };
type Record = { id: string; rel: string; sessionFile: string | null; agent?: string };

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return typeof address === 'object' && address ? address.port : 0;
}

async function waitFor<T>(check: () => Promise<T | undefined>, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out');
}

const configFile = () => join(scratch, 'cfg', 'mirador', 'config.json');
const recordsPath = () => join(scratch, 'state', 'mirador', 'open-agents.json');
const records = async () => (JSON.parse(await readFile(recordsPath(), 'utf8')) as { agents: Record[] }).agents;
/** The program name and arguments the stand-in agent of terminal `id` was started with. */
const started = (id: string) => waitFor(async () => (await readFile(join(scratch, 'home', `args-${id}`), 'utf8')).split('\n').slice(0, -1));

async function start(): Promise<Api> {
  output = '';
  server = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: {
      PATH: join(scratch, 'bin'),
      HOME: join(scratch, 'home'),
      GENTLE_AI_HOME: join(scratch, 'gentle-ai'),
      GENTLE_SHELL_HOME: join(scratch, 'no-gentle-shell'),
      MIRADOR_SCOPES: '0',
      XDG_RUNTIME_DIR: join(scratch, 'run'),
      XDG_CONFIG_HOME: join(scratch, 'cfg'),
      XDG_STATE_HOME: join(scratch, 'state'),
      MIRADOR_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (d) => (output += d));
  server.stderr?.on('data', (d) => (output += d));
  const state = await waitFor(async () => JSON.parse(await readFile(join(scratch, 'run', 'mirador', 'state.json'), 'utf8')));
  const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${state.launchSecret}` } });
  const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
  const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
  const token = ((await session.json()) as { token: string }).token;
  api = (method, path, body) =>
    fetch(`${base}${path}`, { method, headers: { origin: base, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return api;
}

async function stop(): Promise<void> {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((resolve) => server!.once('exit', resolve));
  server.kill('SIGTERM');
  await exited;
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(scratchBase(), 'mirador-agents-choose-')));
  for (const rel of ['alpha', 'beta', 'gamma', 'delta', 'eps', 'zeta']) await mkdir(join(scratch, 'root', rel), { recursive: true });
  await mkdir(join(scratch, 'home'), { recursive: true });
  await mkdir(join(scratch, 'bin'), { recursive: true });
  // Stand-ins: each records its own name and arguments, then idles. kimi is in the catalog but not installed.
  // The args file is written aside and renamed into place, so started() never reads half of one.
  // opencode answers the server's `--version` (read once, at the first opencode open) as an opencode 2, which gets its bridge.
  for (const program of ['gentle-shell', 'claude', 'opencode', 'kimi']) {
    await writeFile(join(scratch, 'bin', program), [
      '#!/bin/sh',
      ...(program === 'opencode' ? ['if [ "$1" = --version ]; then echo 2.4.2; exit 0; fi'] : []),
      '{ printf \'%s\\n\' "${0##*/}"; for word in "$@"; do printf \'%s\\n\' "$word"; done; } > "$HOME/args-$HERDR_PANE_ID.tmp"',
      '/bin/mv -f "$HOME/args-$HERDR_PANE_ID.tmp" "$HOME/args-$HERDR_PANE_ID"',
      'exec /bin/sleep 600',
      '',
    ].join('\n'), { mode: 0o755 });
  }
  await mkdir(join(scratch, 'gentle-ai'), { recursive: true });
  await writeFile(join(scratch, 'gentle-ai', 'state.json'), JSON.stringify({ installed_agents: ['pi', 'claude-code', 'opencode'] }));
  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(configFile(), JSON.stringify({ root: join(scratch, 'root'), engramUrl: 'http://127.0.0.1:9', launches: { batchSize: 10, settleMs: 0, reserveMb: 0 } }));
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await stop();
  await rm(scratch, { recursive: true, force: true });
});

test('opening an agent terminal with an offered agent id starts that agent, and its record keeps the id', async () => {
  await start();
  const open = async (rel: string, agent?: string) => {
    const response = await api('POST', '/api/terminals', { ws: 'dev', rel, kind: 'agent', cols: 90, rows: 33, ...(agent === undefined ? {} : { agent }) });
    assert.equal(response.status, 201);
    return (await response.json()) as Info;
  };

  const claude = await open('alpha', 'claude-code');
  assert.equal(claude.agent, 'claude-code');
  assert.deepEqual(await started(claude.id), ['claude', '--settings', join(scratch, 'run', 'mirador', 'herdr', 'claude-settings.json')], 'the chosen agent with its own hooks (S8), without the gentle-shell bridge');

  const plain = await open('beta');
  assert.equal(plain.agent, undefined, 'no id: the configured agent, as today');
  const plainArgs = await started(plain.id);
  assert.deepEqual(plainArgs.slice(0, 2), ['gentle-shell', '-e']);
  assert.match(plainArgs[2], /gentle-shell-bridge\.ts$/);
  assert.equal(plainArgs.length, 3);

  const pi = await open('gamma', 'pi');
  assert.equal(pi.agent, 'pi');
  assert.deepEqual(await started(pi.id), plainArgs, 'the configured agent by its id starts exactly as without one');

  const saved = await waitFor(async () => {
    const value = await records();
    return value.length === 3 ? value : undefined;
  });
  assert.deepEqual(saved.map((r) => [r.rel, r.agent]), [['alpha', 'claude-code'], ['beta', undefined], ['gamma', 'pi']]);
  assert.equal('agent' in saved[1], false, 'an agent opened without an id leaves the record as before');
});

test('an unknown or not-offered agent id is a 400 and opens and records nothing', async () => {
  // The server of the previous test still runs.
  const call = api;
  const before = (await (await call('GET', '/api/terminals')).json()) as Info[];
  const recorded = await records();
  for (const body of [
    { agent: 'nope' },
    { agent: 'kimi' }, // in the catalog and on PATH, but not installed by gentle-ai
    { agent: 7 },
    { agent: '' },
    { agent: 'claude' }, // a command, not an id
    { kind: 'shell', agent: 'claude-code' },
  ]) {
    const response = await call('POST', '/api/terminals', { ws: 'dev', rel: 'delta', kind: 'agent', ...body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(((await response.json()) as { code: string }).code, 'agent_not_offered', JSON.stringify(body));
  }
  assert.deepEqual(((await (await call('GET', '/api/terminals')).json()) as Info[]).map((t) => t.id), before.map((t) => t.id));
  assert.deepEqual(await records(), recorded);
});

test('a restore reopens each agent with its own agent; only pi continues its session, old records restore as before', async () => {
  await stop();
  const sessions = await Promise.all(['pi', 'old', 'claude'].map(async (name) => {
    const file = join(scratch, `${name}-session.jsonl`);
    await writeFile(file, '{}\n');
    return file;
  }));
  const [piSession, oldSession, claudeSession] = sessions;
  const record = (id: string, rel: string, extra: object) => ({ id, workspaceId: 'dev', rel, cwd: join(scratch, 'root', rel), cols: 90, rows: 33, sessionFile: null, createdAt: '', ...extra });
  await mkdir(join(scratch, 'state', 'mirador'), { recursive: true });
  await writeFile(recordsPath(), JSON.stringify({
    owner: configFile(),
    agents: [
      record('r-pi', 'alpha', { agent: 'pi', sessionFile: piSession }),
      record('r-old', 'beta', { sessionFile: oldSession }),
      record('r-claude', 'gamma', { agent: 'claude-code', sessionFile: claudeSession }),
      record('r-opencode', 'delta', { agent: 'opencode' }),
      record('r-gone', 'eps', { agent: 'no-such-agent' }),
    ],
  }), { mode: 0o600 });

  await start();
  const reopened = await waitFor(async () => {
    const list = (await (await api('GET', '/api/terminals')).json()) as Info[];
    return list.length === 4 ? list : undefined;
  }, 15_000).catch((error) => assert.fail(`${error.message}; server output:\n${output}`));
  const byRel = Object.fromEntries(reopened.map((info) => [info.rel, info]));
  assert.deepEqual(reopened.map((t) => [t.rel, t.agent]).sort(), [['alpha', 'pi'], ['beta', undefined], ['delta', 'opencode'], ['gamma', 'claude-code']]);

  const piArgs = await started(byRel.alpha.id);
  assert.deepEqual([piArgs[0], piArgs[1], ...piArgs.slice(3)], ['gentle-shell', '-e', '--session', piSession], 'pi: the bridge and its session, unchanged');
  const oldArgs = await started(byRel.beta.id);
  assert.deepEqual([oldArgs[0], oldArgs[1], ...oldArgs.slice(3)], ['gentle-shell', '-e', '--session', oldSession], 'a record without an id restores exactly as before');
  assert.deepEqual(await started(byRel.gamma.id), ['claude', '--settings', join(scratch, 'run', 'mirador', 'herdr', 'claude-settings.json')], 'a pi session file is no claude session id: a fresh session');
  assert.deepEqual(await started(byRel.delta.id), ['opencode', '--standalone'], 'no recorded session id: a fresh session, with its plugin (S9)');

  const now = await waitFor(async () => {
    const value = await records();
    return value.length === 4 && value.every((r) => !r.id.startsWith('r-')) ? value : undefined;
  });
  assert.deepEqual(now.map((r) => [r.rel, r.agent, r.sessionFile]).sort(), [
    ['alpha', 'pi', piSession],
    ['beta', undefined, oldSession],
    ['delta', 'opencode', null],
    ['gamma', 'claude-code', null],
  ], 'the reopened agents keep their ids; a fresh session keeps no session file');
  assert.match(output, /no-such-agent/, 'a record of an agent Mirador no longer knows is dropped and logged');
});
