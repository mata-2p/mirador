// agy's (Antigravity CLI) attention hooks are injected per launch,
// never by editing the user's Antigravity config or the project: Mirador writes `.agents/hooks.json` in a
// folder under its runtime folder and starts agy with `--add-dir <folder>`. The hooks drive the inbox, the
// conversation id is recorded, and a restore or wake resumes it with `--conversation <id>`. The real server
// runs with a scratch HOME, runtime, state and config dir and a PATH of stand-ins: the fake `agy` records
// its argv, reads the hooks of each `--add-dir` folder and runs their commands as agy does (`sh -c`, the
// payload on stdin) when the test drops an event file. No real agent binary ever runs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchBase } from './helpers/scratch.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const S1 = 'ec33ebf9-0cba-4100-8142-c61503f6c587';
const S2 = '4e502687-290c-4030-b908-5ed6c68fa5dc';

let scratch: string;
let base: string;
let server: ChildProcess | undefined;
let output = '';
let api: (method: string, path: string, body?: unknown) => Promise<Response>;

type Info = { id: string; rel: string; agent?: string };
type Record = { id: string; rel: string; sessionFile: string | null; session?: string; agent?: string; lastState?: string };

/**
 * Polls `check` until it gives a value. The deadline is generous on purpose: a passing run returns as soon as the
 * condition holds, and a loaded CI runner can take several seconds to start the server, an agent or a hook.
 */
async function waitFor<T>(check: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
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
const folder = () => join(herdrDir(), 'agy-workspace');
const recordsPath = () => join(scratch, 'state', 'mirador', 'open-agents.json');
const records = async () => (JSON.parse(await readFile(recordsPath(), 'utf8')) as { agents: Record[] }).agents;
const recordOf = (id: string) => waitFor(async () => (await records()).find((r) => r.id === id));
/** The program name and arguments the stand-in agent of terminal `id` was started with. */
const started = (id: string) => waitFor(async () => (await readFile(join(home(), `args-${id}`), 'utf8')).split('\n').slice(0, -1));
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
  }, 30_000);
/** What must never appear: the user's Antigravity config, or customizations in the project folders. */
async function untouched(): Promise<void> {
  assert.equal(await exists(join(home(), '.gemini')), false, 'no ~/.gemini written');
  assert.equal(await exists(join(home(), '.antigravity')), false, 'no ~/.antigravity written');
  for (const rel of ['', 'alpha', 'beta', 'gamma']) {
    for (const name of ['.agents', '.agent', 'AGENTS.md', 'GEMINI.md', '.gemini']) assert.equal(await exists(join(scratch, 'root', rel, name)), false, `no ${rel}/${name} written`);
  }
}

let fired = 0;
/** Makes the fake agy of terminal `id` run its hooks for `event`, and resolves with what each printed. */
async function fire(id: string, event: string, fields: object = {}): Promise<unknown[]> {
  const done = join(home(), `done-${id}-${++fired}`);
  const payload = { conversationId: S1, workspacePaths: [join(scratch, 'root', 'alpha'), folder()], transcriptPath: join(home(), 'transcript.jsonl'), artifactDirectoryPath: home(), modelName: 'gemini-3.6-flash-medium', ...fields };
  // Written aside and renamed into place: the fake agy polls for the file and must never read half of it.
  const trigger = join(home(), `do-${id}`);
  await writeFile(`${trigger}.tmp`, JSON.stringify({ done, event, payload }));
  await rename(`${trigger}.tmp`, trigger);
  return waitFor(async () => ((await exists(done)) ? (JSON.parse(await readFile(done, 'utf8')) as unknown[]) : undefined));
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

// The fake agy: records its argv, reads `.agents/hooks.json` in each `--add-dir` folder (agy's workspace
// level, https://antigravity.google/docs/hooks), and runs the handlers of an event the test drops in
// `$HOME/do-<pane>`: SessionStart, PreInvocation and Stop take a flat list, PreToolUse groups whose
// matcher matches the tool name. It writes what each handler printed to the done file. Each file it writes is
// written aside and renamed into place, so the test never reads half of one.
const FAKE_AGY = `#!${process.execPath}
const { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const home = process.env.HOME;
const pane = process.env.HERDR_PANE_ID;
const argv = process.argv.slice(2);
const put = (file, text) => {
  writeFileSync(file + '.tmp', text);
  renameSync(file + '.tmp', file);
};
put(home + '/args-' + pane, ['agy', ...argv].map((word) => word + '\\n').join(''));
const groups = [];
argv.forEach((word, i) => {
  if (word !== '--add-dir') return;
  const file = join(argv[i + 1], '.agents', 'hooks.json');
  if (existsSync(file)) groups.push(...Object.values(JSON.parse(readFileSync(file, 'utf8'))));
});
setInterval(() => {
  const trigger = home + '/do-' + pane;
  if (!existsSync(trigger)) return;
  const { done, event, payload } = JSON.parse(readFileSync(trigger, 'utf8'));
  unlinkSync(trigger);
  const printed = [];
  for (const group of groups) {
    if (group.enabled === false) continue;
    for (const entry of group[event] || []) {
      const handlers = event === 'PreToolUse' || event === 'PostToolUse'
        ? (new RegExp('^(?:' + (entry.matcher || '.*') + ')$').test(payload.toolCall.name) ? entry.hooks : [])
        : [entry];
      for (const handler of handlers) {
        const run = spawnSync('/bin/sh', ['-c', handler.command], { input: JSON.stringify(payload), env: process.env, encoding: 'utf8' });
        printed.push({ status: run.status, out: JSON.parse(run.stdout) });
      }
    }
  }
  put(done, JSON.stringify(printed));
}, 30);
`;

before(async () => {
  scratch = await realpath(await mkdtemp(join(scratchBase(), 'mirador-agy-bridge-')));
  for (const rel of ['alpha', 'beta', 'gamma', 'pi']) await mkdir(join(scratch, 'root', rel), { recursive: true });
  await mkdir(home(), { recursive: true });
  await mkdir(join(scratch, 'bin'), { recursive: true });
  await writeFile(join(scratch, 'bin', 'agy'), FAKE_AGY, { mode: 0o755 });
  await writeFile(join(scratch, 'bin', 'gentle-shell'), [
    '#!/bin/sh',
    '{ printf \'%s\\n\' "${0##*/}"; for word in "$@"; do printf \'%s\\n\' "$word"; done; } > "$HOME/args-$HERDR_PANE_ID.tmp"',
    '/bin/mv -f "$HOME/args-$HERDR_PANE_ID.tmp" "$HOME/args-$HERDR_PANE_ID"',
    'exec /bin/sleep 600',
    '',
  ].join('\n'), { mode: 0o755 });
  await mkdir(join(scratch, 'gentle-ai'), { recursive: true });
  await writeFile(join(scratch, 'gentle-ai', 'state.json'), JSON.stringify({ installed_agents: ['pi', 'antigravity'] }));
  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(join(scratch, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root: join(scratch, 'root'), engramUrl: 'http://127.0.0.1:9', launches: { batchSize: 10, settleMs: 0, reserveMb: 0 } }));
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

let alpha: Info;

test('choosing antigravity starts agy --add-dir <hook folder> from the runtime folder, writing no Antigravity config', async () => {
  await start();
  const offered = ((await (await api('GET', '/api/agents')).json()) as { agents: Array<{ id: string; attention: string; resume: boolean }> }).agents;
  assert.deepEqual(offered.find((agent) => agent.id === 'antigravity'), { id: 'antigravity', label: 'Antigravity', command: 'agy', configured: false, attention: 'hooks', resume: true });
  alpha = await open('alpha', 'antigravity');
  assert.deepEqual(await started(alpha.id), ['agy', '--add-dir', folder()]);
  const file = join(folder(), '.agents', 'hooks.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  for (const dir of [folder(), join(folder(), '.agents')]) assert.equal((await stat(dir)).mode & 0o777, 0o700, dir);
  const hooks = JSON.parse(await readFile(file, 'utf8'))['mirador-attention'];
  assert.deepEqual(Object.keys(hooks), ['PreInvocation', 'PreToolUse', 'PostToolUse', 'PostInvocation', 'Stop']);
  assert.match(hooks.Stop[0].command, /bin\/agy-hook'? Stop$/);
  // The pi agent beside it is untouched: the configured gentle-shell with its own bridge.
  const pi = await open('pi');
  const piArgs = await started(pi.id);
  assert.deepEqual([piArgs[0], piArgs[1], piArgs.length], ['gentle-shell', '-e', 3]);
  assert.match(piArgs[2], /gentle-shell-bridge\.ts$/);
  assert.equal((await api('DELETE', `/api/terminals/${pi.id}`)).status, 204);
  await untouched();
});

test('the hooks drive the inbox: PreInvocation working, a question waiting, Stop finished; the conversation id is recorded', async () => {
  // A new conversation is not hooked: nothing changes before its first model call.
  assert.deepEqual(await fire(alpha.id, 'SessionStart'), []);
  assert.deepEqual(await fire(alpha.id, 'PreInvocation', { invocationNum: 0, initialNumSteps: 1, lastUserInput: 'Fix the tests' }), [{ status: 0, out: {} }]);
  const working = await waitFor(async () => {
    const record = await recordOf(alpha.id);
    return record.lastState === 'working' ? record : undefined;
  });
  assert.deepEqual([working.session, working.sessionFile], [S1, null], 'the payload conversationId is the record resume key');
  assert.deepEqual(await inbox(), []);

  // Any other tool never reaches Mirador's PreToolUse hook (the matcher keeps it out, so agy's own policy decides);
  // its PostToolUse does, and refreshes the working report.
  const tool = { stepIdx: 3, toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } } };
  assert.deepEqual(await fire(alpha.id, 'PreToolUse', tool), []);
  assert.deepEqual(await fire(alpha.id, 'PostToolUse', tool), [{ status: 0, out: {} }]);
  assert.deepEqual(await fire(alpha.id, 'PostInvocation', { invocationNum: 0 }), [{ status: 0, out: {} }]);
  assert.equal((await recordOf(alpha.id)).lastState, 'working');
  assert.deepEqual(await inbox(), []);
  const asked = await fire(alpha.id, 'PreToolUse', { stepIdx: 4, toolCall: { name: 'ask_question', args: { questions: [{ question: 'Which database?', options: ['sqlite', 'postgres'], is_multi_select: false }] } } });
  assert.deepEqual(asked, [{ status: 0, out: { decision: 'allow' } }], 'the hook defers to agy’s own policy');
  const waiting = await waitFor(async () => ((await inbox()).length ? inbox() : undefined));
  assert.deepEqual(waiting.map((item) => [item.terminalId, item.kind, item.label]), [[alpha.id, 'prompt', 'Which database?']]);
  // The records file is written in the background: wait for the write after the working one.
  const recorded = await waitFor(async () => {
    const record = await recordOf(alpha.id);
    return record.lastState !== 'working' ? record : undefined;
  });
  assert.equal(recorded.lastState, 'waiting');

  await fire(alpha.id, 'PreInvocation', { invocationNum: 1, initialNumSteps: 6 });
  await fire(alpha.id, 'Stop', { executionNum: 1, terminationReason: 'model_stop', error: '', fullyIdle: true });
  const finished = await waitFor(async () => ((await inbox())[0]?.kind === 'finished' ? inbox() : undefined));
  assert.deepEqual(finished.map((item) => [item.terminalId, item.kind]), [[alpha.id, 'finished']]);
  await waitFor(async () => ((await recordOf(alpha.id)).lastState === 'finished' ? true : undefined));

  // beta works on conversation S2; gamma never reports one.
  const beta = await open('beta', 'antigravity');
  await started(beta.id);
  await fire(beta.id, 'PreInvocation', { conversationId: S2, invocationNum: 0, initialNumSteps: 1 });
  await waitFor(async () => ((await recordOf(beta.id)).session === S2 ? true : undefined));
  const gamma = await open('gamma', 'antigravity');
  await started(gamma.id);
  await untouched();
});

test('a restart resumes agy with --conversation <id>, never with an invalid id, and a wake resumes the finished one', async () => {
  await stop();
  // A hand-edited record whose conversation id could read as an option: it is dropped, so that agent starts fresh.
  const saved = JSON.parse(await readFile(recordsPath(), 'utf8')) as { owner: string; agents: Array<{ rel: string; session?: string }> };
  const gammaRecord = saved.agents.find((record) => record.rel === 'gamma')!;
  gammaRecord.session = '--help';
  await writeFile(recordsPath(), JSON.stringify(saved), { mode: 0o600 });

  await start();
  // The restore reopens one agent after another: read the list once it has ended, not when it first counts two.
  const counts = await restoreDone();
  const reopened = await listed();
  const byRel = Object.fromEntries(reopened.map((info) => [info.rel, info]));
  assert.deepEqual(reopened.map((info) => info.rel).sort(), ['beta', 'gamma'], 'alpha had finished: it sleeps');
  assert.deepEqual(Object.keys(byRel).sort(), ['beta', 'gamma'], 'alpha had finished: it sleeps');
  assert.deepEqual(counts, [2, 0], 'the restore reopened beta and gamma and dropped nothing');
  assert.deepEqual(await started(byRel.beta.id), ['agy', '--add-dir', folder(), '--conversation', S2]);
  assert.deepEqual(await started(byRel.gamma.id), ['agy', '--add-dir', folder()], 'an invalid conversation id is never passed');
  assert.equal((await recordOf(byRel.beta.id)).session, S2, 'the reopened record keeps its id');

  const sleeping = ((await (await api('GET', '/api/terminals/sleeping')).json()) as { agents: Array<{ id: string; agent: string | null; resumable: boolean }> }).agents;
  assert.deepEqual(sleeping.map((a) => [a.id, a.agent, a.resumable]), [[alpha.id, 'antigravity', true]]);
  assert.equal((await api('POST', `/api/terminals/sleeping/${alpha.id}/wake`)).status, 202);
  const woken = await waitFor(async () => (await listed()).find((info) => info.rel === 'alpha'));
  assert.deepEqual(await started(woken.id), ['agy', '--add-dir', folder(), '--conversation', S1]);
  await untouched();
  assert.deepEqual((await readdir(herdrDir())).filter((name) => name.includes('agy')), ['agy-workspace']);
});
