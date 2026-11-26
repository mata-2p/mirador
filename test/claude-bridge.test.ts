// Claude Code's attention hooks are injected per launch with
// `--settings <file>`, never by editing the user's Claude config. `Stop` is finished, `Notification`
// waiting, a submitted prompt working; the hooks' `session_id` is recorded and a restore or wake
// resumes it with `--resume <id>`. The real server runs with a scratch HOME, runtime, state and config
// dir and a PATH of stand-ins: the fake `claude` records its argv, reads the settings it was given and
// runs their hook commands with realistic stdin JSON when the test drops an event file. No real agent
// binary ever runs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchBase } from './helpers/scratch.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const S1 = '0f8e2a4c-1b7d-4e5f-9a6b-3c2d1e0f9a8b';
const S2 = '7c1d9e3f-5a2b-4c8d-8e6f-1a0b2c3d4e5f';

let scratch: string;
let base: string;
let server: ChildProcess | undefined;
let output = '';
let api: Api;

type Api = (method: string, path: string, body?: unknown) => Promise<Response>;
type Info = { id: string; kind: string; rel: string; agent?: string };
type Record = { id: string; rel: string; sessionFile: string | null; session?: string; agent?: string; lastState?: string };
type Sleeper = { id: string; workspaceId: string; rel: string; createdAt: string; resumable: boolean; agent: string | null };

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
  throw new Error(`timed out; server output:\n${output}`);
}

const home = () => join(scratch, 'home');
const configFile = () => join(scratch, 'cfg', 'mirador', 'config.json');
const recordsPath = () => join(scratch, 'state', 'mirador', 'open-agents.json');
const settingsPath = () => join(scratch, 'run', 'mirador', 'herdr', 'claude-settings.json');
const records = async () => (JSON.parse(await readFile(recordsPath(), 'utf8')) as { agents: Record[] }).agents;
const recordOf = (id: string) => waitFor(async () => (await records()).find((r) => r.id === id));
/** The program name and arguments the stand-in agent of terminal `id` was started with. */
const started = (id: string) => waitFor(async () => (await readFile(join(home(), `args-${id}`), 'utf8')).split('\n').slice(0, -1));
const exists = (path: string) => access(path).then(() => true, () => false);
/**
 * Waits until the server logged the end of its restore, and resolves with how many agents it reopened and
 * dropped. Until then the terminal list can hold only part of what the restore reopens.
 */
const restoreDone = () =>
  waitFor(async () => {
    const done = /^mirador: reopened (\d+) agent\(s\), dropped (\d+)$/m.exec(output);
    return done ? [Number(done[1]), Number(done[2])] : undefined;
  }, 15_000);

let events = 0;
/** Makes the fake claude of terminal `id` run its hooks for one event, and waits until they ran. */
async function fire(id: string, event: string, fields: object): Promise<void> {
  const done = join(home(), `done-${id}-${++events}`);
  const payload = { session_id: S1, transcript_path: join(home(), 'projects', `${S1}.jsonl`), cwd: join(scratch, 'root'), permission_mode: 'default', hook_event_name: event, ...fields };
  // Written aside and renamed into place: the fake claude polls for the file and must never read half of it.
  const trigger = join(home(), `do-${id}`);
  await writeFile(`${trigger}.tmp`, JSON.stringify({ done, payload }));
  await rename(`${trigger}.tmp`, trigger);
  await waitFor(async () => ((await exists(done)) ? true : undefined));
}

async function start(): Promise<Api> {
  output = '';
  // A fresh free port for each start: the one a stopped server freed may be taken by then.
  const port = await freePort();
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
  return api;
}

async function stop(): Promise<void> {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((resolve) => server!.once('exit', resolve));
  server.kill('SIGTERM');
  await exited;
}

// The fake claude: records its argv, reads `--settings`, and runs every command hook of an event the
// test drops in `$HOME/do-<pane>` (as Claude Code does: `sh -c <command>`, the payload on stdin). Each file
// it writes is written aside and renamed into place, so the test never reads half of one.
const FAKE_CLAUDE = `#!${process.execPath}
const { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const home = process.env.HOME;
const pane = process.env.HERDR_PANE_ID;
const put = (file, text) => {
  writeFileSync(file + '.tmp', text);
  renameSync(file + '.tmp', file);
};
put(home + '/args-' + pane, ['claude', ...process.argv.slice(2)].map((word) => word + '\\n').join(''));
const at = process.argv.indexOf('--settings');
const settings = at > 0 ? JSON.parse(readFileSync(process.argv[at + 1], 'utf8')) : {};
setInterval(() => {
  const trigger = home + '/do-' + pane;
  if (!existsSync(trigger)) return;
  const { done, payload } = JSON.parse(readFileSync(trigger, 'utf8'));
  unlinkSync(trigger);
  for (const group of (settings.hooks || {})[payload.hook_event_name] || []) {
    for (const hook of group.hooks || []) {
      if (hook.type === 'command') spawnSync('/bin/sh', ['-c', hook.command], { input: JSON.stringify(payload), env: process.env });
    }
  }
  put(done, '');
}, 30);
`;

before(async () => {
  scratch = await realpath(await mkdtemp(join(scratchBase(), 'mirador-claude-bridge-')));
  for (const rel of ['alpha', 'beta', 'gamma', 'delta', 'pi']) await mkdir(join(scratch, 'root', rel), { recursive: true });
  await mkdir(home(), { recursive: true });
  await mkdir(join(scratch, 'bin'), { recursive: true });
  await writeFile(join(scratch, 'bin', 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  await writeFile(join(scratch, 'bin', 'gentle-shell'), [
    '#!/bin/sh',
    '{ printf \'%s\\n\' "${0##*/}"; for word in "$@"; do printf \'%s\\n\' "$word"; done; } > "$HOME/args-$HERDR_PANE_ID.tmp"',
    '/bin/mv -f "$HOME/args-$HERDR_PANE_ID.tmp" "$HOME/args-$HERDR_PANE_ID"',
    'exec /bin/sleep 600',
    '',
  ].join('\n'), { mode: 0o755 });
  await mkdir(join(scratch, 'gentle-ai'), { recursive: true });
  await writeFile(join(scratch, 'gentle-ai', 'state.json'), JSON.stringify({ installed_agents: ['pi', 'claude-code'] }));
  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(configFile(), JSON.stringify({ root: join(scratch, 'root'), engramUrl: 'http://127.0.0.1:9', launches: { batchSize: 10, settleMs: 0, reserveMb: 0 } }));
});

after(async () => {
  await stop();
  await rm(scratch, { recursive: true, force: true });
});

const open = async (rel: string, agent?: string) => {
  const response = await api('POST', '/api/terminals', { ws: 'dev', rel, kind: 'agent', cols: 90, rows: 33, ...(agent === undefined ? {} : { agent }) });
  assert.equal(response.status, 201);
  return (await response.json()) as Info;
};
const inbox = async () => ((await (await api('GET', '/api/inbox')).json()) as { items: Array<{ terminalId: string; kind: string; label: string }> }).items;

let alpha: Info;
let beta: Info;
let gamma: Info;

test('choosing claude-code launches claude --settings <file> with Mirador hooks, and writes no Claude config', async () => {
  await start();
  alpha = await open('alpha', 'claude-code');
  assert.deepEqual(await started(alpha.id), ['claude', '--settings', settingsPath()]);
  const settings = JSON.parse(await readFile(settingsPath(), 'utf8')) as { hooks: { [event: string]: Array<{ hooks: Array<{ type: string; command: string }> }> } };
  for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop']) {
    assert.equal(settings.hooks[event]?.[0]?.hooks[0]?.type, 'command', event);
    assert.match(settings.hooks[event][0].hooks[0].command, /bin\/claude-hook'?$/, event);
  }
  assert.equal((await stat(settingsPath())).mode & 0o777, 0o600);
  // The pi agent beside it is untouched: the configured gentle-shell with its own bridge.
  const pi = await open('pi');
  const piArgs = await started(pi.id);
  assert.deepEqual([piArgs[0], piArgs[1], piArgs.length], ['gentle-shell', '-e', 3]);
  assert.match(piArgs[2], /gentle-shell-bridge\.ts$/);
  assert.equal((await api('DELETE', `/api/terminals/${pi.id}`)).status, 204);
  assert.equal(await exists(join(home(), '.claude')), false, 'no ~/.claude written');
  assert.equal(await exists(join(scratch, 'root', 'alpha', '.claude')), false, 'no project .claude written');
});

test('the hooks drive the attention state: prompt submit working, Notification waiting, Stop finished; session_id is recorded', async () => {
  await fire(alpha.id, 'UserPromptSubmit', { prompt: 'fix the tests' });
  const working = await waitFor(async () => {
    const record = (await records()).find((r) => r.id === alpha.id);
    return record?.lastState === 'working' ? record : undefined;
  });
  assert.equal(working.session, S1, 'the hook payload session_id is the record resume key');
  assert.equal(working.sessionFile, null);
  assert.deepEqual(await inbox(), []);

  await fire(alpha.id, 'Notification', { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' });
  const waiting = await waitFor(async () => {
    const items = await inbox();
    return items.length ? items : undefined;
  });
  assert.deepEqual(waiting.map((item) => [item.terminalId, item.kind, item.label]), [[alpha.id, 'prompt', 'Claude needs your permission to use Bash']]);
  // The records file is written in the background: wait for the write after the working one.
  const recorded = await waitFor(async () => {
    const record = await recordOf(alpha.id);
    return record.lastState !== 'working' ? record : undefined;
  });
  assert.equal(recorded.lastState, 'waiting');

  await fire(alpha.id, 'Stop', { stop_hook_active: false, last_assistant_message: 'Done.' });
  const finished = await waitFor(async () => {
    const items = await inbox();
    return items[0]?.kind === 'finished' ? items : undefined;
  });
  assert.deepEqual(finished.map((item) => [item.terminalId, item.kind]), [[alpha.id, 'finished']]);
  await waitFor(async () => ((await recordOf(alpha.id)).lastState === 'finished' ? true : undefined));

  // A later idle reminder is not a question: the finished turn stays finished.
  await fire(alpha.id, 'Notification', { message: 'Claude is waiting for your input', notification_type: 'idle_prompt' });
  assert.deepEqual((await inbox()).map((item) => [item.terminalId, item.kind]), [[alpha.id, 'finished']]);

  // beta works on session S2; gamma never reports a session.
  beta = await open('beta', 'claude-code');
  await started(beta.id);
  await fire(beta.id, 'UserPromptSubmit', { session_id: S2, prompt: 'go on' });
  await waitFor(async () => ((await recordOf(beta.id)).session === S2 ? true : undefined));
  gamma = await open('gamma', 'claude-code');
  await started(gamma.id);
  assert.equal(await exists(join(home(), '.claude')), false, 'still no ~/.claude');
});

test('a restart resumes claude with --resume <id>, starts one without an id fresh, and the sleeping list says which agent and whether it resumes', async () => {
  await stop();
  // Two older sleeping records: a claude one with only a pi-style session file, and a pi one.
  const piSession = join(scratch, 'pi-session.jsonl');
  await writeFile(piSession, '{}\n');
  const saved = JSON.parse(await readFile(recordsPath(), 'utf8')) as { owner: string; agents: object[] };
  const sleeper = (id: string, rel: string, extra: object) => ({ id, workspaceId: 'dev', rel, cwd: join(scratch, 'root', rel), cols: 90, rows: 33, sessionFile: null, createdAt: '2026-11-09T00:00:00.000Z', lastState: 'finished', ...extra });
  saved.agents.push(sleeper('old-claude', 'delta', { agent: 'claude-code', sessionFile: piSession }), sleeper('old-pi', 'pi', { sessionFile: piSession }));
  await writeFile(recordsPath(), JSON.stringify(saved), { mode: 0o600 });

  await start();
  // The restore reopens one agent after another: read the list once it has ended, not when it first counts two.
  const counts = await restoreDone();
  const reopened = (await (await api('GET', '/api/terminals')).json()) as Info[];
  const byRel = Object.fromEntries(reopened.map((info) => [info.rel, info]));
  assert.deepEqual(reopened.map((info) => info.rel).sort(), ['beta', 'gamma'], 'alpha had finished: it sleeps');
  assert.deepEqual(Object.keys(byRel).sort(), ['beta', 'gamma'], 'alpha had finished: it sleeps');
  assert.deepEqual(counts, [2, 0], 'the restore reopened beta and gamma and dropped nothing');
  assert.deepEqual(await started(byRel.beta.id), ['claude', '--settings', settingsPath(), '--resume', S2]);
  assert.deepEqual(await started(byRel.gamma.id), ['claude', '--settings', settingsPath()], 'no recorded id: a fresh session');
  assert.equal((await recordOf(byRel.beta.id)).session, S2, 'the reopened record keeps its id');

  const sleeping = ((await (await api('GET', '/api/terminals/sleeping')).json()) as { agents: Sleeper[] }).agents;
  assert.deepEqual(sleeping.map((a) => [a.id, a.rel, a.agent, a.resumable]).sort(), [
    [alpha.id, 'alpha', 'claude-code', true],
    ['old-claude', 'delta', 'claude-code', false],
    ['old-pi', 'pi', null, true],
  ].sort(), 'a pi session file does not make a claude agent resumable');
  for (const agent of sleeping) assert.deepEqual(Object.keys(agent).sort(), ['agent', 'createdAt', 'id', 'rel', 'resumable', 'workspaceId']);

  assert.equal((await api('POST', `/api/terminals/sleeping/${alpha.id}/wake`)).status, 202);
  assert.equal((await api('POST', '/api/terminals/sleeping/old-claude/wake')).status, 202);
  const woken = await waitFor(async () => {
    const list = (await (await api('GET', '/api/terminals')).json()) as Info[];
    return list.length === 4 ? list : undefined;
  }, 15_000);
  const wokenByRel = Object.fromEntries(woken.map((info) => [info.rel, info]));
  assert.deepEqual(await started(wokenByRel.alpha.id), ['claude', '--settings', settingsPath(), '--resume', S1]);
  assert.deepEqual(await started(wokenByRel.delta.id), ['claude', '--settings', settingsPath()], 'a pi session file is never passed to claude');
  assert.equal(await exists(join(home(), '.claude')), false, 'no ~/.claude after restore and wake');
  assert.deepEqual((await readdir(home())).filter((name) => name.includes('claude')), []);
});
