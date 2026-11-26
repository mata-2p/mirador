// Integration: the real server, agent terminals that report like gentle-shell does
// through the herdr shim, and the inbox API. No real agent or model is involved.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAttentionBridge } from '../src/attention/gentle-shell-bridge.ts';
import { scratchBase } from './helpers/scratch.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const WebSocket = createRequire(import.meta.url)('ws');

let scratch: string;
let root: string;
let server: ChildProcess;
let base: string;
let launchSecret: string;
let herdrDir: string;

interface Item { terminalId: string; workspaceId: string; rel: string; title: string; kind: string; label: string; detail: string | null; since: string; activity: string | null }

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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out');
}

async function login(): Promise<string> {
  const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${launchSecret}` } });
  const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
  const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
  return ((await session.json()) as { token: string }).token;
}

function api(token: string, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { origin: base, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function items(token: string): Promise<Item[]> {
  const response = await api(token, 'GET', '/api/inbox');
  assert.equal(response.status, 200);
  return ((await response.json()) as { items: Item[] }).items;
}

async function openTerminal(token: string, rel: string, kind: 'agent' | 'shell'): Promise<string> {
  const response = await api(token, 'POST', '/api/terminals', { ws: 'dev', rel, kind, cols: 80, rows: 24 });
  assert.equal(response.status, 201);
  return ((await response.json()) as { id: string }).id;
}

/** Runs the herdr CLI agent terminals get, the way gentle-shell runs it. */
function herdr(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(join(herdrDir, 'herdr'), args, { env: { PATH: process.env.PATH ?? '', HERDR_SOCKET_PATH: join(herdrDir, 'socket'), ...env }, timeout: 5000 },
      (error, stdout, stderr) => resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr, ms: Date.now() - started }));
  });
}

const report = (pane: string, seq: number, ...flags: string[]) => herdr(['pane', 'report-metadata', pane, '--source', 'mirador:attention', '--agent', 'pi', '--seq', String(seq), ...flags]);

/** Reads the NDJSON stream line by line. */
async function openStream(token: string) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/inbox/stream`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/x-ndjson/);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  return {
    async next(): Promise<Item[]> {
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end >= 0) {
          const line = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          if (Array.isArray(line.items)) return line.items;
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buffer += value;
      }
    },
    close: () => controller.abort(),
  };
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(scratchBase(), 'mirador-inbox-')));
  root = join(scratch, 'root');
  for (const dir of ['alpha', 'beta/sub']) await mkdir(join(root, dir), { recursive: true });
  await mkdir(join(scratch, 'home'), { recursive: true });

  // A stand-in for gentle-shell (found on PATH, as the default agent command) plus the attention
  // bridge: record its arguments, report activity and a blocker, then idle.
  await mkdir(join(scratch, 'bin'), { recursive: true });
  await writeFile(join(scratch, 'bin', 'gentle-shell'), [
    '#!/bin/sh',
    'printf \'%s\\n\' "$@" > "$HOME/argv-$HERDR_PANE_ID"',
    '"$HERDR_BIN_PATH" pane report-metadata "$HERDR_PANE_ID" --source gentle:activity --agent pi --seq 1 --ttl-ms 30000 --token "summary=◐ Wire the inbox" --clear-token summary2',
    '"$HERDR_BIN_PATH" pane report-metadata "$HERDR_PANE_ID" --source mirador:attention --agent pi --seq 1 --token "blocked=Guarded command confirmation"',
    'exec sleep 600',
    '',
  ].join('\n'), { mode: 0o755 });

  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(join(scratch, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root, engramUrl: 'http://127.0.0.1:9' }));

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: { ...process.env, PATH: `${join(scratch, 'bin')}:${process.env.PATH}`, HOME: join(scratch, 'home'), XDG_RUNTIME_DIR: join(scratch, 'run'), XDG_STATE_HOME: join(scratch, 'state'), XDG_CONFIG_HOME: join(scratch, 'cfg'), MIRADOR_PORT: String(port), MIRADOR_SCOPES: '0' },
    stdio: 'ignore',
  });
  const state = await waitFor(async () => JSON.parse(await readFile(join(scratch, 'run', 'mirador', 'state.json'), 'utf8')));
  launchSecret = state.launchSecret;
  herdrDir = join(scratch, 'run', 'mirador', 'herdr');
});

after(async () => {
  server?.kill('SIGTERM');
  await new Promise((resolve) => server?.once('exit', resolve));
  await rm(scratch, { recursive: true, force: true });
});

test('the inbox API and its stream need the session token', async () => {
  for (const path of ['/api/inbox', '/api/inbox/stream']) {
    assert.equal((await fetch(`${base}${path}`)).status, 401, path);
    assert.equal((await fetch(`${base}${path}`, { headers: { authorization: 'Bearer wrong' } })).status, 401, path);
  }
});

test('the herdr folder, socket and launcher are private to this user', async () => {
  const dir = await stat(herdrDir);
  assert.equal(dir.mode & 0o777, 0o700);
  const socket = await stat(join(herdrDir, 'socket'));
  assert.ok(socket.isSocket());
  assert.equal(socket.mode & 0o077, 0, 'no access for group or others');
  assert.equal((await stat(join(herdrDir, 'herdr'))).mode & 0o777, 0o700);
});

test('an agent that reports a blocker through the shim shows in the inbox until its terminal closes', async () => {
  const token = await login();
  const id = await openTerminal(token, 'beta/sub', 'agent');
  const [item] = await waitFor(async () => {
    const list = await items(token);
    return list.length ? list : undefined;
  });
  assert.deepEqual({ ...item, since: undefined }, {
    terminalId: id, workspaceId: 'dev', rel: 'beta/sub', title: 'sub',
    kind: 'blocked', label: 'Guarded command confirmation', detail: null, activity: '◐ Wire the inbox', since: undefined,
  });
  assert.ok(Math.abs(Date.parse(item.since) - Date.now()) < 10_000, item.since);
  const argv = await readFile(join(scratch, 'home', `argv-${id}`), 'utf8');
  assert.deepEqual(argv.split('\n').slice(0, -1), ['-e', join(APP_DIR, 'src', 'attention', 'gentle-shell-bridge.ts')], 'Mirador loads the bridge itself');

  assert.equal((await api(token, 'DELETE', `/api/terminals/${id}`)).status, 204);
  assert.deepEqual(await items(token), []);
});

test('the stream sends the current inbox, then every change, without polling', async () => {
  const token = await login();
  const stream = await openStream(token);
  try {
    assert.deepEqual(await stream.next(), []);
    const id = await openTerminal(token, 'alpha', 'agent');
    const pushed = await stream.next();
    assert.deepEqual(pushed.map((i) => [i.terminalId, i.rel, i.label]), [[id, 'alpha', 'Guarded command confirmation']]);

    // The agent got its answer: the bridge clears the token and the item leaves every window.
    const cleared = await report(id, 2, '--clear-token', 'blocked');
    assert.equal(cleared.code, 0);
    assert.deepEqual(await stream.next(), []);
    assert.deepEqual(await items(token), []);
    await api(token, 'DELETE', `/api/terminals/${id}`);
  } finally {
    stream.close();
  }
});

test('reports for shell or unknown terminals, and garbage on the socket, change nothing', async () => {
  const token = await login();
  const shell = await openTerminal(token, 'alpha', 'shell');
  assert.equal((await report(shell, 1, '--token', 'blocked=Choice awaiting input')).code, 0);
  assert.equal((await report('no-such-terminal', 1, '--token', 'blocked=Choice awaiting input')).code, 0);

  const socket = join(herdrDir, 'socket');
  const send = (payload: string | Buffer) => new Promise<void>((resolve) => {
    const conn = createConnection(socket);
    conn.on('error', () => resolve());
    conn.on('close', () => resolve());
    conn.on('connect', () => conn.end(payload));
  });
  await send('not json\n');
  await send(Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a]));
  await send('{"v":1,"cmd":"report-metadata","pane":"' + 'x'.repeat(100_000) + '"}\n');
  await send('x'.repeat(1024 * 1024));
  await Promise.all(Array.from({ length: 50 }, () => send('{}\n')));

  assert.deepEqual(await items(token), []);
  assert.equal((await api(token, 'GET', '/api/terminals')).status, 200, 'server still up');

  // The socket still serves a valid report afterwards.
  const agent = await openTerminal(token, 'alpha', 'agent');
  await waitFor(async () => ((await items(token)).some((i) => i.terminalId === agent) ? true : undefined));
  await api(token, 'DELETE', `/api/terminals/${agent}`);
  await api(token, 'DELETE', `/api/terminals/${shell}`);
});

test('the gentle-shell bridge relabels and releases a blocked terminal through the real shim', async () => {
  const token = await login();
  const id = await openTerminal(token, 'beta', 'agent');
  await waitFor(async () => ((await items(token)).some((i) => i.terminalId === id) ? true : undefined));

  const bus = new Map<string, (payload: unknown) => void>();
  createAttentionBridge({
    env: { PATH: process.env.PATH, TERM_PROGRAM: 'mirador', HERDR_ENV: '1', HERDR_PANE_ID: id, HERDR_SOCKET_PATH: join(herdrDir, 'socket'), HERDR_BIN_PATH: join(herdrDir, 'herdr') },
  })({ events: { on: (name, handler) => bus.set(name, handler) } });

  bus.get('herdr:blocked')!({ active: true, label: 'Questionnaire awaiting input' });
  await waitFor(async () => ((await items(token)).find((i) => i.terminalId === id)?.label === 'Questionnaire awaiting input' ? true : undefined));
  bus.get('herdr:blocked')!({ active: false });
  await waitFor(async () => ((await items(token)).some((i) => i.terminalId === id) ? undefined : true));
  await api(token, 'DELETE', `/api/terminals/${id}`);
});

test('a finished turn leaves the inbox when the user types into the terminal or marks it seen', async () => {
  const token = await login();
  const id = await openTerminal(token, 'alpha', 'agent');
  await waitFor(async () => ((await items(token)).some((i) => i.terminalId === id) ? true : undefined));
  const kindOf = async () => (await items(token)).find((i) => i.terminalId === id)?.kind ?? null;

  assert.equal((await report(id, 2, '--clear-token', 'blocked', '--clear-token', 'prompt', '--token', 'finished=turn-1')).code, 0);
  await waitFor(async () => ((await kindOf()) === 'finished' ? true : undefined));
  assert.equal((await fetch(`${base}/api/inbox/${id}/seen`, { method: 'POST', headers: { origin: base } })).status, 401, 'needs the session token');
  assert.equal((await fetch(`${base}/api/inbox/${id}/seen`, { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: 'http://evil.example' } })).status, 403, 'needs the app origin');
  assert.equal(await kindOf(), 'finished');
  assert.equal((await api(token, 'POST', `/api/inbox/${id}/seen`)).status, 204);
  assert.equal(await kindOf(), null);
  assert.equal((await api(token, 'POST', '/api/inbox/no-such-terminal/seen')).status, 204, 'idempotent, even after the terminal is gone');

  assert.equal((await report(id, 3, '--clear-token', 'blocked', '--clear-token', 'prompt', '--token', 'finished=turn-2')).code, 0);
  await waitFor(async () => ((await kindOf()) === 'finished' ? true : undefined));
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/terminals/${id}`, ['mirador.v1', `auth.${token}`], { headers: { origin: base } });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  ws.send(JSON.stringify({ t: 'i', d: '\x1b[I\x1b[12;40R' }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await kindOf(), 'finished', 'replies the terminal sends by itself are not typing');
  ws.send(JSON.stringify({ t: 'i', d: 'y' }));
  await waitFor(async () => ((await kindOf()) === null ? true : undefined));
  ws.terminate();
  await api(token, 'DELETE', `/api/terminals/${id}`);
});

test('the shim never fails the agent: no Mirador, other commands or bad input all exit 0 quietly', async () => {
  const runs = [
    await herdr(['pane', 'report-metadata', 'p1', '--source', 'mirador:attention', '--seq', '1', '--token', 'blocked=x'], { HERDR_SOCKET_PATH: join(scratch, 'nowhere', 'socket') }),
    await herdr(['pane', 'report-metadata', 'p1', '--token', 'blocked=x'], { HERDR_SOCKET_PATH: '' }),
    await herdr(['workspace', 'list']),
    await herdr([]),
    await herdr(['pane', 'report-metadata', 'p1', '--token', 'y'.repeat(10_000)]),
  ];
  for (const run of runs) {
    assert.deepEqual([run.code, run.stdout, run.stderr], [0, '', '']);
    assert.ok(run.ms < 3000, `took ${run.ms} ms`);
  }
});

test('a night state reaches the card through the stream: a delegation the bridge cannot take shows as deferred', async () => {
  // No model runs: the fake agent has no night bridge, so the night service defers before the decider.
  const token = await login();
  const id = await openTerminal(token, 'alpha', 'agent');
  await waitFor(async () => ((await items(token)).some((i) => i.terminalId === id) ? true : undefined));
  assert.equal((await report(id, 2, '--clear-token', 'blocked', '--clear-token', 'prompt', '--token', 'finished=turn-1')).code, 0);
  await waitFor(async () => ((await items(token)).find((i) => i.terminalId === id)?.kind === 'finished' ? true : undefined));
  const listed = await api(token, 'GET', '/api/inbox');
  assert.deepEqual(((await listed.json()) as { nightNotes: unknown[] }).nightNotes, []);

  const stream = await openStream(token);
  try {
    const first = await stream.next();
    assert.equal(first.find((i) => i.terminalId === id)?.kind, 'finished');
    assert.equal((await api(token, 'POST', `/api/night/delegate/${id}`)).status, 202);
    let night: { state?: string; rule?: string; flow?: string } | undefined;
    while (!night) night = ((await stream.next()).find((i) => i.terminalId === id) as Item & { night?: typeof night })?.night;
    assert.equal(night.state, 'deferred');
    assert.equal(night.flow, 'follow-up');
    assert.equal(night.rule, 'not-connected');
  } finally {
    stream.close();
  }
  await api(token, 'DELETE', `/api/terminals/${id}`);
});

test('the stream still carries items and night notes on every line, and stays capped at 16 open streams', async () => {
  const token = await login();
  const streams = await Promise.all(Array.from({ length: 16 }, () => openStream(token)));
  try {
    for (const stream of streams) assert.ok(Array.isArray(await stream.next()));
    const refused = await fetch(`${base}/api/inbox/stream`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(refused.status, 429);
    assert.equal(((await refused.json()) as { code: string }).code, 'inbox_busy');
  } finally {
    for (const stream of streams) stream.close();
  }
  const again = await waitFor(async () => {
    const response = await fetch(`${base}/api/inbox/stream`, { headers: { authorization: `Bearer ${token}` } });
    if (response.status === 200) return response;
    await response.body?.cancel();
    return undefined;
  });
  const reader = again.body!.pipeThrough(new TextDecoderStream()).getReader();
  const first = JSON.parse((await reader.read()).value!.split('\n')[0]);
  // `sleeping` is the third field: the number of agents asleep, so a forget in another window
  // reaches this one without the inbox changing (#91).
  assert.deepEqual(Object.keys(first).sort(), ['items', 'nightNotes', 'sleeping']);
  assert.equal(typeof first.sleeping, 'number');
  await reader.cancel();
});
