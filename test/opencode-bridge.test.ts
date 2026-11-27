// opencode's attention plugin is injected per launch, never by editing
// the user's opencode config: Mirador writes it under its runtime folder and starts opencode with
// `--standalone` and OPENCODE_CONFIG_CONTENT naming it. Its events drive the inbox, the root session id
// is recorded, and a restore or wake resumes it with `--session <id>`. The real server runs with a
// scratch HOME, runtime, state and config dir and a PATH of stand-ins: the fake `opencode` records its
// argv and config, loads the plugin it was given as opencode 2 does (default export, `setup(ctx)`) and
// feeds it the events the test drops in a file. No real agent binary ever runs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchBase } from './helpers/scratch.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const S1 = 'ses_7f3e2d1c0b9aXyZwVuTsRqPoNm';
const S2 = 'ses_7f3e2d1c0b97QwErTyUiOpAsDf';

let scratch: string;
let base: string;
let server: ChildProcess | undefined;
let output = '';
let api: (method: string, path: string, body?: unknown) => Promise<Response>;

type Info = { id: string; rel: string; agent?: string };
type Record = { id: string; rel: string; sessionFile: string | null; session?: string; agent?: string; lastState?: string };

async function waitFor<T>(check: () => Promise<T | undefined>, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out; server output:\n${output}`);
}

const home = () => join(scratch, 'home');
const herdrDir = () => join(scratch, 'run', 'mirador', 'herdr');
const recordsPath = () => join(scratch, 'state', 'mirador', 'open-agents.json');
const records = async () => (JSON.parse(await readFile(recordsPath(), 'utf8')) as { agents: Record[] }).agents;
const recordOf = (id: string) => waitFor(async () => (await records()).find((r) => r.id === id));
/** The argv and OPENCODE_CONFIG_CONTENT the stand-in agent of terminal `id` was started with. */
const started = (id: string) => waitFor(async () => JSON.parse(await readFile(join(home(), `args-${id}`), 'utf8')) as { argv: string[]; config?: string });
const exists = (path: string) => access(path).then(() => true, () => false);
const listed = async () => (await (await api('GET', '/api/terminals')).json()) as Info[];
const inbox = async () => ((await (await api('GET', '/api/inbox')).json()) as { items: Array<{ terminalId: string; kind: string; label: string }> }).items;
/**
 * Waits until the server logged the end of its restore, and resolves with how many agents it reopened and
 * dropped. Until then the terminal list can hold only part of what the restore reopens.
 */
const restoreDone = () =>
  waitFor(async () => {
    const done = /^mirador: reopened (\d+) agent\(s\), dropped (\d+)$/m.exec(output);
    return done ? [Number(done[1]), Number(done[2])] : undefined;
  }, 15_000);

let fired = 0;
/** Makes the fake opencode of terminal `id` hand `events` to Mirador's plugin, and waits until it did. */
async function fire(id: string, ...events: Array<{ type: string; data: object }>): Promise<void> {
  const done = join(home(), `done-${id}-${++fired}`);
  // Written aside and renamed into place: the fake opencode polls for the file and must never read half of
  // it (a half-written file made its JSON.parse throw, which ended the fake and timed the test out).
  const trigger = join(home(), `do-${id}`);
  await writeFile(`${trigger}.tmp`, JSON.stringify({ done, events: events.map((event, i) => ({ id: `evt_${fired}_${i}`, created: Date.now(), ...event })) }));
  await rename(`${trigger}.tmp`, trigger);
  await waitFor(async () => ((await exists(done)) ? true : undefined));
}

async function start(): Promise<void> {
  output = '';
  const port = await new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: {
      PATH: join(scratch, 'bin'),
      HOME: home(),
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
}

async function stop(): Promise<void> {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((resolve) => server!.once('exit', resolve));
  server.kill('SIGTERM');
  await exited;
}

// The fake opencode: an opencode 2 to the server's `--version` (it reads it once at start), otherwise it
// records its argv and OPENCODE_CONFIG_CONTENT, and with --standalone loads each
// configured plugin directory's index.js as opencode 2 does, giving its setup an event stream fed from
// `$HOME/do-<pane>`.
const FAKE_OPENCODE = `#!${process.execPath}
if (process.argv[2] === '--version') {
  console.log('2.4.2');
  process.exit(0);
}
const { existsSync, readFileSync, unlinkSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const home = process.env.HOME;
const pane = process.env.HERDR_PANE_ID;
const config = process.env.OPENCODE_CONFIG_CONTENT;
writeFileSync(home + '/args-' + pane, JSON.stringify({ argv: ['opencode', ...process.argv.slice(2)], config }));
const queue = [];
let wake = null;
const ctx = { event: { subscribe: (options) => (async function* () {
  for (;;) {
    if (!queue.length) await new Promise((resolve) => (wake = resolve));
    while (queue.length) yield queue.shift();
  }
})() } };
(async () => {
  if (!process.argv.includes('--standalone') || !config) return;
  for (const dir of JSON.parse(config).plugins) await (await import(pathToFileURL(join(dir, 'index.js')).href)).default.setup(ctx);
})();
setInterval(() => {
  const trigger = home + '/do-' + pane;
  if (!existsSync(trigger)) return;
  const { done, events } = JSON.parse(readFileSync(trigger, 'utf8'));
  unlinkSync(trigger);
  queue.push(...events);
  if (wake) wake();
  setTimeout(() => writeFileSync(done, ''), 150);
}, 30);
`;

before(async () => {
  scratch = await realpath(await mkdtemp(join(scratchBase(), 'mirador-opencode-bridge-')));
  for (const rel of ['alpha', 'beta', 'gamma', 'delta']) await mkdir(join(scratch, 'root', rel), { recursive: true });
  await mkdir(home(), { recursive: true });
  await mkdir(join(scratch, 'bin'), { recursive: true });
  await writeFile(join(scratch, 'bin', 'opencode'), FAKE_OPENCODE, { mode: 0o755 });
  await writeFile(join(scratch, 'bin', 'gentle-shell'), '#!/bin/sh\nexec /bin/sleep 600\n', { mode: 0o755 });
  await mkdir(join(scratch, 'gentle-ai'), { recursive: true });
  await writeFile(join(scratch, 'gentle-ai', 'state.json'), JSON.stringify({ installed_agents: ['pi', 'opencode'] }));
  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(join(scratch, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root: join(scratch, 'root'), engramUrl: 'http://127.0.0.1:9', launches: { batchSize: 10, settleMs: 0, reserveMb: 0 } }));
});

after(async () => {
  await stop();
  await rm(scratch, { recursive: true, force: true });
});

const open = async (rel: string) => {
  const response = await api('POST', '/api/terminals', { ws: 'dev', rel, kind: 'agent', cols: 90, rows: 33, agent: 'opencode' });
  assert.equal(response.status, 201);
  return (await response.json()) as Info;
};

let alpha: Info;
let beta: Info;

test('choosing opencode starts it with --standalone and the plugin from the runtime folder, writing no opencode config', async () => {
  await start();
  alpha = await open('alpha');
  const pluginDir = join(herdrDir(), 'opencode-plugin');
  assert.deepEqual(await started(alpha.id), { argv: ['opencode', '--standalone'], config: JSON.stringify({ plugins: [pluginDir] }) });
  for (const name of ['index.js', 'package.json']) assert.equal((await stat(join(pluginDir, name))).mode & 0o777, 0o600, name);
  assert.equal(await readFile(join(pluginDir, 'index.js'), 'utf8'), await readFile(join(APP_DIR, 'bin', 'opencode-plugin.js'), 'utf8'));
  assert.equal(await exists(join(home(), '.config', 'opencode')), false, 'no ~/.config/opencode written');
  assert.equal(await exists(join(scratch, 'cfg', 'opencode')), false, 'no $XDG_CONFIG_HOME/opencode written');
  assert.equal(await exists(join(scratch, 'root', 'alpha', '.opencode')), false, 'no project .opencode written');
  assert.equal(await exists(join(scratch, 'root', 'alpha', 'opencode.json')), false, 'no project opencode.json written');
});

test('the plugin drives the inbox: execution started working, a permission waiting, execution succeeded finished; the session id is recorded', async () => {
  await fire(alpha.id, { type: 'session.execution.started', data: { sessionID: S1 } });
  const working = await waitFor(async () => {
    const record = await recordOf(alpha.id);
    return record.lastState === 'working' ? record : undefined;
  });
  assert.deepEqual([working.session, working.sessionFile], [S1, null]);

  await fire(alpha.id, { type: 'permission.asked', data: { id: 'per_1', sessionID: S1, action: 'bash', resources: ['git push'], message: 'Allow bash: git push?' } });
  const waiting = await waitFor(async () => ((await inbox()).length ? inbox() : undefined));
  assert.deepEqual(waiting.map((item) => [item.terminalId, item.kind, item.label]), [[alpha.id, 'prompt', 'Allow bash: git push?']]);

  await fire(alpha.id, { type: 'permission.replied', data: { sessionID: S1, requestID: 'per_1', reply: 'once' } }, { type: 'session.execution.succeeded', data: { sessionID: S1 } });
  const finished = await waitFor(async () => ((await inbox())[0]?.kind === 'finished' ? inbox() : undefined));
  assert.deepEqual(finished.map((item) => [item.terminalId, item.kind]), [[alpha.id, 'finished']]);
  await waitFor(async () => ((await recordOf(alpha.id)).lastState === 'finished' ? true : undefined));

  beta = await open('beta');
  await started(beta.id);
  await fire(beta.id, { type: 'session.execution.started', data: { sessionID: S2 } });
  await waitFor(async () => ((await recordOf(beta.id)).session === S2 ? true : undefined));
});

test('a restart resumes opencode with --session <id>, never with an invalid id, and a wake resumes the finished one', async () => {
  await stop();
  // A hand-edited record whose session id could read as an option: it is dropped, so that agent starts fresh.
  const saved = JSON.parse(await readFile(recordsPath(), 'utf8')) as { owner: string; agents: object[] };
  saved.agents.push({ id: 'odd', workspaceId: 'dev', rel: 'delta', cwd: join(scratch, 'root', 'delta'), cols: 90, rows: 33, sessionFile: null, createdAt: '2026-11-09T00:00:00.000Z', lastState: 'working', agent: 'opencode', session: '--help' });
  await writeFile(recordsPath(), JSON.stringify(saved), { mode: 0o600 });

  await start();
  // The restore reopens one agent after another: read the list once it has ended, not when it first counts two.
  const counts = await restoreDone();
  const reopened = await listed();
  const byRel = Object.fromEntries(reopened.map((info) => [info.rel, info]));
  assert.deepEqual(reopened.map((info) => info.rel).sort(), ['beta', 'delta'], 'alpha had finished: it sleeps');
  assert.deepEqual(Object.keys(byRel).sort(), ['beta', 'delta'], 'alpha had finished: it sleeps');
  assert.deepEqual(counts, [2, 0], 'the restore reopened beta and delta and dropped nothing');
  assert.deepEqual((await started(byRel.beta.id)).argv, ['opencode', '--standalone', '--session', S2]);
  assert.deepEqual((await started(byRel.delta.id)).argv, ['opencode', '--standalone'], 'an invalid session id is never passed');

  const sleeping = ((await (await api('GET', '/api/terminals/sleeping')).json()) as { agents: Array<{ id: string; agent: string | null; resumable: boolean }> }).agents;
  assert.deepEqual(sleeping.map((a) => [a.id, a.agent, a.resumable]), [[alpha.id, 'opencode', true]]);
  assert.equal((await api('POST', `/api/terminals/sleeping/${alpha.id}/wake`)).status, 202);
  const woken = await waitFor(async () => (await listed()).find((info) => info.rel === 'alpha'), 15_000);
  assert.deepEqual(await started(woken.id), { argv: ['opencode', '--standalone', '--session', S1], config: JSON.stringify({ plugins: [join(herdrDir(), 'opencode-plugin')] }) });
  assert.equal(await exists(join(home(), '.config', 'opencode')), false, 'still no ~/.config/opencode');
  assert.deepEqual((await readdir(herdrDir())).filter((name) => name.includes('opencode')), ['opencode-plugin']);
});
