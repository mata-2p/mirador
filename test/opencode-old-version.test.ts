// An opencode older than 2.0.0 (opencode 1.x has no `--standalone` and another plugin API, #124) starts
// without Mirador's bridge, like Codex: no `--standalone`, no OPENCODE_CONFIG_CONTENT, no `--session` on a
// restore or wake, so no attention, no resume and no idle sleep. The server reads `opencode --version` once
// when it starts, says in one log line per launch kind which version is installed and which one is needed,
// and GET /api/agents offers it with no attention and no resume. A version it cannot read keeps the bridge,
// with one log line. The real server runs with a scratch HOME, runtime, state and config dir and a PATH of
// stand-ins: the fake `opencode` answers `--version` and otherwise records its argv and
// OPENCODE_CONFIG_CONTENT, then idles. No real agent binary ever runs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchBase } from './helpers/scratch.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const S1 = 'ses_7f3e2d1c0b9aXyZwVuTsRqPoNm';
const S2 = 'ses_7f3e2d1c0b97QwErTyUiOpAsDf';
const OLD_START = "mirador: opencode 1.19.6 is older than 2.0.0, the first opencode with --standalone and the plugin API Mirador's bridge needs: opencode agents start without it (no attention, no resume, no idle sleep); update opencode to 2.0.0 or newer";
const OLD_RESUME = 'mirador: opencode 1.19.6 is older than 2.0.0, which resuming an opencode session from Mirador needs: a reopened or woken opencode agent starts a fresh session (no --session)';

type Info = { id: string; rel: string; agent?: string };
type Api = (method: string, path: string, body?: unknown) => Promise<Response>;

interface Mirador {
  scratch: string;
  output: () => string;
  api: Api;
  stop(): Promise<void>;
}

const scratches: string[] = [];
const servers: ChildProcess[] = [];
after(async () => {
  for (const server of servers) if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
  for (const dir of scratches) await rm(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return typeof address === 'object' && address ? address.port : 0;
}

async function waitFor<T>(check: () => Promise<T | undefined>, ms = 8000, why = () => ''): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out${why()}`);
}

/** A fake opencode whose `--version` runs `version` (shell), and otherwise records how it was started and idles. */
const fakeOpencode = (version: string) => [
  '#!/bin/sh',
  `if [ "$1" = --version ]; then ${version}; fi`,
  '{ printf \'%s\\n\' "${0##*/}"; for word in "$@"; do printf \'%s\\n\' "$word"; done; printf \'config=%s\\n\' "${OPENCODE_CONFIG_CONTENT-<unset>}"; } > "$HOME/args-$HERDR_PANE_ID.tmp"',
  '/bin/mv -f "$HOME/args-$HERDR_PANE_ID.tmp" "$HOME/args-$HERDR_PANE_ID"',
  'exec /bin/sleep 600',
  '',
].join('\n');

/** A scratch Mirador home whose PATH holds gentle-shell and a fake opencode with `version`, config `extra`. */
async function place(name: string, version: string, extra: object = {}): Promise<string> {
  const scratch = await realpath(await mkdtemp(join(scratchBase(), `mirador-opencode-old-${name}-`)));
  scratches.push(scratch);
  for (const rel of ['alpha', 'beta', 'gamma', 'delta']) await mkdir(join(scratch, 'root', rel), { recursive: true });
  await mkdir(join(scratch, 'home'), { recursive: true });
  await mkdir(join(scratch, 'bin'), { recursive: true });
  await writeFile(join(scratch, 'bin', 'opencode'), fakeOpencode(version), { mode: 0o755 });
  await writeFile(join(scratch, 'bin', 'gentle-shell'), '#!/bin/sh\nexec /bin/sleep 600\n', { mode: 0o755 });
  await mkdir(join(scratch, 'gentle-ai'), { recursive: true });
  await writeFile(join(scratch, 'gentle-ai', 'state.json'), JSON.stringify({ installed_agents: ['pi', 'opencode'] }));
  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(join(scratch, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root: join(scratch, 'root'), engramUrl: 'http://127.0.0.1:9', launches: { batchSize: 10, settleMs: 0, reserveMb: 0 }, ...extra }));
  return scratch;
}

async function start(scratch: string): Promise<Mirador> {
  let output = '';
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['src/server.ts'], {
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
  servers.push(server);
  server.stdout?.on('data', (d) => (output += d));
  server.stderr?.on('data', (d) => (output += d));
  const why = () => `; server output:\n${output}`;
  const statePath = join(scratch, 'run', 'mirador', 'state.json');
  const state = await waitFor(async () => {
    const value = JSON.parse(await readFile(statePath, 'utf8')) as { pid: number; launchSecret: string };
    return value.pid === server.pid ? value : undefined;
  }, 15_000, why);
  const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${state.launchSecret}` } });
  const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
  const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
  const token = ((await session.json()) as { token: string }).token;
  const api: Api = (method, path, body) =>
    fetch(`${base}${path}`, { method, headers: { origin: base, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return {
    scratch,
    output: () => output,
    api,
    stop: async () => {
      if (server.exitCode !== null || server.signalCode !== null) return;
      const exited = new Promise((resolve) => server.once('exit', resolve));
      server.kill('SIGTERM');
      await exited;
    },
  };
}

/** The argv and OPENCODE_CONFIG_CONTENT (`<unset>` when absent) the stand-in of terminal `id` was started with. */
async function started(m: Mirador, id: string): Promise<{ argv: string[]; config: string }> {
  const lines = await waitFor(async () => (await readFile(join(m.scratch, 'home', `args-${id}`), 'utf8')).split('\n').slice(0, -1), 8000, () => `; server output:\n${m.output()}`);
  return { argv: lines.slice(0, -1), config: lines.at(-1)!.replace(/^config=/, '') };
}

async function open(m: Mirador, rel: string, agent?: string): Promise<Info> {
  const response = await m.api('POST', '/api/terminals', { ws: 'dev', rel, kind: 'agent', cols: 90, rows: 33, ...(agent ? { agent } : {}) });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()) as Info;
}

const count = (output: string, line: string) => output.split('\n').filter((row) => row === line).length;
const restoreDone = (m: Mirador) => waitFor(async () => (/^mirador: reopened \d+ agent\(s\), dropped \d+$/m.test(m.output()) ? true : undefined), 15_000, () => `; server output:\n${m.output()}`);

test('an opencode older than 2.0.0, chosen beside another agent, starts without --standalone or its plugin, offered with no attention or resume, and the log names both versions once', async () => {
  const m = await start(await place('chosen', 'echo 1.19.6; exit 0'));
  try {
    const agents = ((await (await m.api('GET', '/api/agents')).json()) as { agents: Array<{ id: string; attention: string; resume: boolean }> }).agents;
    assert.deepEqual(agents.find((agent) => agent.id === 'opencode'), { id: 'opencode', label: 'opencode', command: 'opencode', configured: false, attention: 'none', resume: false });
    const alpha = await open(m, 'alpha', 'opencode');
    assert.deepEqual(await started(m, alpha.id), { argv: ['opencode'], config: '<unset>' });
    const beta = await open(m, 'beta', 'opencode');
    assert.deepEqual(await started(m, beta.id), { argv: ['opencode'], config: '<unset>' });
    assert.equal(count(m.output(), OLD_START), 1, `one log line for every opencode started; server output:\n${m.output()}`);
    assert.equal(m.output().includes('--standalone'), true, 'the log line says what the old opencode lacks');
  } finally {
    await m.stop();
  }
});

test('a configured opencode older than 2.0.0 starts exactly as configured, without --standalone or its plugin', async () => {
  const m = await start(await place('configured', 'echo 1.19.6; exit 0', { agentCommand: 'opencode' }));
  try {
    const alpha = await open(m, 'alpha');
    assert.deepEqual(await started(m, alpha.id), { argv: ['opencode'], config: '<unset>' });
    assert.equal(count(m.output(), OLD_START), 1, m.output());
  } finally {
    await m.stop();
  }
});

test('with an opencode older than 2.0.0, a restore and a wake of opencode records start a fresh session: no --session, no --standalone, not resumable', async () => {
  const scratch = await place('restore', 'echo 1.19.6; exit 0');
  const record = (id: string, rel: string, extra: object) => ({ id, workspaceId: 'dev', rel, cwd: join(scratch, 'root', rel), cols: 90, rows: 33, sessionFile: null, createdAt: '2026-11-20T00:00:00.000Z', agent: 'opencode', ...extra });
  await mkdir(join(scratch, 'state', 'mirador'), { recursive: true });
  await writeFile(join(scratch, 'state', 'mirador', 'open-agents.json'), JSON.stringify({
    owner: join(scratch, 'cfg', 'mirador', 'config.json'),
    // Records an opencode 2 left: one still working (reopened at the restore), one finished (left asleep).
    agents: [record('r-working', 'gamma', { session: S1, lastState: 'working' }), record('r-finished', 'delta', { session: S2, lastState: 'finished' })],
  }), { mode: 0o600 });
  const m = await start(scratch);
  try {
    await restoreDone(m);
    const gamma = await waitFor(async () => ((await (await m.api('GET', '/api/terminals')).json()) as Info[]).find((info) => info.rel === 'gamma'));
    assert.deepEqual(await started(m, gamma.id), { argv: ['opencode'], config: '<unset>' }, 'restore: no --session and no --standalone');
    const sleeping = ((await (await m.api('GET', '/api/terminals/sleeping')).json()) as { agents: Array<{ id: string; agent: string | null; resumable: boolean }> }).agents;
    assert.deepEqual(sleeping.map((a) => [a.id, a.agent, a.resumable]), [['r-finished', 'opencode', false]]);
    assert.equal((await m.api('POST', '/api/terminals/sleeping/r-finished/wake')).status, 202);
    const delta = await waitFor(async () => ((await (await m.api('GET', '/api/terminals')).json()) as Info[]).find((info) => info.rel === 'delta'), 15_000);
    assert.deepEqual(await started(m, delta.id), { argv: ['opencode'], config: '<unset>' }, 'wake: no --session and no --standalone');
    assert.equal(count(m.output(), OLD_RESUME), 1, `one log line for the opencode sessions not resumed; server output:\n${m.output()}`);
    assert.equal(count(m.output(), OLD_START), 1, m.output());
  } finally {
    await m.stop();
  }
});

test('an opencode whose version cannot be read keeps the bridge as before, with one log line', async () => {
  const m = await start(await place('unreadable', 'echo "not a version"; exit 3'));
  try {
    const agents = ((await (await m.api('GET', '/api/agents')).json()) as { agents: Array<{ id: string; attention: string; resume: boolean }> }).agents;
    assert.deepEqual(agents.find((agent) => agent.id === 'opencode'), { id: 'opencode', label: 'opencode', command: 'opencode', configured: false, attention: 'hooks', resume: true });
    const alpha = await open(m, 'alpha', 'opencode');
    const herdr = join(m.scratch, 'run', 'mirador', 'herdr', 'opencode-plugin');
    assert.deepEqual(await started(m, alpha.id), { argv: ['opencode', '--standalone'], config: JSON.stringify({ plugins: [herdr] }) });
    await open(m, 'beta', 'opencode');
    const unreadable = m.output().split('\n').filter((row) => row.startsWith("mirador: could not read opencode's version"));
    assert.deepEqual(unreadable, ["mirador: could not read opencode's version (opencode --version exited with code 3); opencode agents start with Mirador's bridge as before, which needs opencode 2.0.0 or newer"]);
    assert.equal(m.output().includes('is older than'), false);
  } finally {
    await m.stop();
  }
});
