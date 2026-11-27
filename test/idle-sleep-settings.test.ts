// Settings → idle sleep (#115): GET and PUT /api/settings/idle-sleep read
// and save the switch and the threshold in minutes in config.json (saveSettings, every other key kept), and
// a save applies at once to the running idle sleep, with no restart. Rejected input answers the exact error
// and leaves config.json as it was. Real route over HTTP, real IdleSleep, registry, attention and OpenAgents.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { idleSleepMs, loadConfig } from '../src/config.ts';
import { agentLaunch } from '../src/agents/catalog.ts';
import { AttentionStore } from '../src/attention/store.ts';
import type { AppContext } from '../src/http/context.ts';
import { HttpError, sendJson } from '../src/http/respond.ts';
import { Router } from '../src/http/router.ts';
import { createIdleSleepRoutes } from '../src/http/routes/idle-sleep.ts';
import { IdleSleep, provideIdleSleep } from '../src/terminals/hibernate.ts';
import { OpenAgents } from '../src/terminals/open-agents.ts';
import { TerminalRegistry, type PtyProcess } from '../src/terminals/registry.ts';

const MINUTE = 60_000;

let scratch: string;
const servers: Server[] = [];
const idles: IdleSleep[] = [];
const agentFiles: OpenAgents[] = [];
before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-idle-settings-')));
});
after(async () => {
  for (const idle of idles) idle.stop();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(agentFiles.map((openAgents) => openAgents.flush()));
  await rm(scratch, { recursive: true, force: true });
});

class FakePty implements PtyProcess {
  onData() {}
  onExit() {}
  write() {}
  resize() {}
  kill() {}
}

let counter = 0;
let seq = 1_000_000;

/** A server with the idle-sleep routes over `saved` (config.json), and the running idle sleep they control. */
async function serve(saved: Record<string, unknown>) {
  const place = join(scratch, `case-${++counter}`);
  await mkdir(join(place, 'state'), { recursive: true });
  const configFile = join(place, 'config.json');
  await writeFile(configFile, `${JSON.stringify(saved, null, 2)}\n`);
  const config = await loadConfig(configFile, { HOME: place });
  const registry = new TerminalRegistry(() => new FakePty(), { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/rc', env: {}, scrollbackLimit: 1000 });
  const attention = new AttentionStore({ now: () => 1_000_000 });
  registry.subscribe((event) => attention.track(event));
  const openAgents = await OpenAgents.load(join(place, 'state', 'open-agents.json'), { owner: configFile, log: () => undefined, schedule: () => () => undefined });
  agentFiles.push(openAgents);
  openAgents.track(registry);
  attention.onSession((id, session) => void openAgents.recordSessionId(id, session));
  let clock = 0;
  const timers: Array<{ due: number; run: () => void; cancelled: boolean }> = [];
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
  const idle = new IdleSleep({
    registry, attention, openAgents, idleMs: idleSleepMs(config), log: () => undefined,
    schedule: (run, ms) => {
      const timer = { due: clock + ms, run, cancelled: false };
      timers.push(timer);
      return () => void (timer.cancelled = true);
    },
  });
  idle.start();
  idles.push(idle);
  provideIdleSleep(registry, idle);
  const { workspaces: _w, workspaceProblems: _p, launchProblems: _l, ...settings } = config;
  const ctx = { config: settings, terminals: registry } as unknown as AppContext;
  const router = new Router();
  for (const route of await createIdleSleepRoutes({ configFile })(ctx)) router.add(route);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const found = router.match(req.method ?? 'GET', url.pathname);
      if (!found) throw new HttpError(404, 'not found');
      await found.route.handler({ req, res, url, params: found.params });
    } catch (error) {
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message, code: error.code });
      sendJson(res, 500, { error: String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const api = async (method: string, body?: unknown) => {
    const response = await fetch(`${base}/api/settings/idle-sleep`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  /** A Claude Code agent that reported its session and finished its turn. */
  const finishedClaude = (rel: string) => {
    const info = registry.create({ cwd: `/w/${rel}`, kind: 'agent', cols: 100, rows: 30, workspaceId: 'dev', rel, ...agentLaunch('claude-code', 'gentle-shell') });
    attention.receive(JSON.stringify({ v: 1, cmd: 'report-metadata', pane: info.id, source: 'mirador:attention', seq: ++seq, ttlMs: null, tokens: { session: `sess-${rel}` }, clear: [] }));
    attention.receive(JSON.stringify({ v: 1, cmd: 'report-metadata', pane: info.id, source: 'mirador:attention', seq: ++seq, ttlMs: null, tokens: { finished: 't-1' }, clear: [] }));
    return info.id;
  };
  return { configFile, api, registry, pass, finishedClaude };
}

test('GET answers the switch and the threshold in minutes as the config gives them', async () => {
  for (const [saved, expected] of [
    [{}, { on: true, minutes: 240 }],
    [{ idleSleepHours: 2 }, { on: true, minutes: 120 }],
    [{ idleSleepHours: 2, idleSleepMinutes: 45 }, { on: true, minutes: 45 }],
    [{ idleSleep: false, idleSleepMinutes: 45 }, { on: false, minutes: 45 }],
    // idleSleepHours 0 still means off; the threshold shown is the default.
    [{ idleSleepHours: 0 }, { on: false, minutes: 240 }],
  ] as const) {
    const { api } = await serve(saved);
    assert.deepEqual(await api('GET'), { status: 200, body: expected }, JSON.stringify(saved));
  }
});

test('PUT saves the switch and the minutes in config.json, keeps every other key, and GET reads them back', async () => {
  const { api, configFile } = await serve({ port: 5000, agentCommand: 'pi', idleSleepHours: 3 });
  assert.deepEqual(await api('PUT', { on: false, minutes: 30 }), { status: 200, body: { on: false, minutes: 30 } });
  assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')), { port: 5000, agentCommand: 'pi', idleSleepHours: 3, idleSleep: false, idleSleepMinutes: 30 });
  assert.deepEqual(await api('GET'), { status: 200, body: { on: false, minutes: 30 } });
  assert.deepEqual(await api('PUT', { on: true, minutes: 10080 }), { status: 200, body: { on: true, minutes: 10080 } });
  const reloaded = await loadConfig(configFile, { HOME: scratch });
  assert.deepEqual([reloaded.idleSleep, reloaded.idleSleepMinutes, idleSleepMs(reloaded), reloaded.launchProblems], [true, 10080, 10080 * MINUTE, []]);
});

test('a save applies at once, with no restart: switched off nothing sleeps, back on the new threshold puts a finished agent to sleep', async () => {
  const { api, registry, pass, finishedClaude } = await serve({});
  assert.equal((await api('PUT', { on: false, minutes: 240 })).status, 200);
  const a = finishedClaude('a');
  pass(10 * 240 * MINUTE);
  assert.equal(registry.get(a)?.status, 'running', 'off: it stays open');
  assert.equal((await api('PUT', { on: true, minutes: 5 })).status, 200);
  pass(5 * MINUTE - 1);
  assert.equal(registry.get(a)?.status, 'running');
  pass(1);
  assert.equal(registry.get(a), undefined, 'asleep 5 minutes after the save');
});

test('rejected input answers the exact error and leaves config.json and the setting unchanged', async () => {
  const { api, configFile } = await serve({ port: 5000, idleSleepMinutes: 60 });
  const before = await readFile(configFile, 'utf8');
  const invalid = (error: string) => ({ status: 400, body: { error, code: 'idle_sleep_invalid' } });
  const minutesError = invalid('minutes must be a whole number from 1 to 10080');
  for (const [body, expected] of [
    [{ on: 'yes', minutes: 30 }, invalid('on must be true or false')],
    [{ minutes: 30 }, invalid('on must be true or false')],
    [{ on: true }, minutesError],
    [{ on: true, minutes: 0 }, minutesError],
    [{ on: true, minutes: 10081 }, minutesError],
    [{ on: true, minutes: 1.5 }, minutesError],
    [{ on: true, minutes: '30' }, minutesError],
    [{ on: true, minutes: 30, idleSleepHours: 0 }, invalid('only on and minutes can be saved')],
    ['[1]', { status: 400, body: { error: 'expected a JSON object' } }],
  ] as const) {
    assert.deepEqual(await api('PUT', body), expected, JSON.stringify(body));
    assert.equal(await readFile(configFile, 'utf8'), before, `${JSON.stringify(body)}: config.json unchanged`);
  }
  assert.deepEqual(await api('GET'), { status: 200, body: { on: true, minutes: 60 } });
});
