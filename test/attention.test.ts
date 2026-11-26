// The attention store and the herdr environment: what Mirador learns from agent terminals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { herdrEnvProvider } from '../src/attention/herdr.ts';
import { listenForReports } from '../src/attention/socket.ts';
import { AttentionStore, isTyping, type AttentionItem } from '../src/attention/store.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn, type TerminalInfo } from '../src/terminals/registry.ts';

function terminal(id: string, kind: 'agent' | 'shell' = 'agent', rel = 'vigia/api'): TerminalInfo {
  return { id, workspaceId: 'dev', rel, cwd: `/home/you/Dev/${rel}`, title: rel.split('/').pop() || 'Dev', kind, status: 'running', createdAt: '2026-10-28T10:00:00.000Z' };
}

/** What `herdr pane report-metadata` sends, as the shim forwards it to the socket. */
function report(pane: string, fields: Partial<{ source: string; seq: number; ttlMs: number | null; tokens: Record<string, string>; clear: string[] }> = {}): string {
  return JSON.stringify({ v: 1, cmd: 'report-metadata', pane, source: 'mirador:attention', seq: 1, ttlMs: null, tokens: {}, clear: [], ...fields });
}
const blocked = (pane: string, label: string, seq = 1) => report(pane, { seq, tokens: { blocked: label } });
const unblocked = (pane: string, seq: number) => report(pane, { seq, clear: ['blocked'] });

function setup(start = Date.parse('2026-10-28T10:05:00.000Z')) {
  let clock = start;
  const store = new AttentionStore({ now: () => clock });
  return { store, advance: (ms: number) => { clock += ms; } };
}

test('a blocked agent terminal becomes an inbox item with its place, label and waiting start', () => {
  const { store } = setup();
  store.track({ type: 'created', info: terminal('t1') });
  assert.deepEqual(store.items(), []);

  assert.equal(store.receive(blocked('t1', 'Guarded command confirmation')), true);
  assert.deepEqual(store.items(), [{
    terminalId: 't1', workspaceId: 'dev', rel: 'vigia/api', title: 'api',
    kind: 'blocked', label: 'Guarded command confirmation', detail: null, since: '2026-10-28T10:05:00.000Z', activity: null,
  } satisfies AttentionItem]);
});

test('reports for unknown, shell, exited or closed terminals are ignored', () => {
  const { store } = setup();
  store.track({ type: 'created', info: terminal('shell1', 'shell') });
  store.track({ type: 'created', info: terminal('gone') });
  store.track({ type: 'closed', info: terminal('gone') });
  store.track({ type: 'created', info: terminal('done') });
  store.track({ type: 'exited', info: { ...terminal('done'), status: 'exited', exitCode: 0 } });

  for (const pane of ['nobody', 'shell1', 'gone', 'done']) assert.equal(store.receive(blocked(pane, 'Choice awaiting input')), false, pane);
  assert.deepEqual(store.items(), []);
});

test('malformed or oversized reports are ignored without throwing', () => {
  const { store } = setup();
  store.track({ type: 'created', info: terminal('t1') });
  const tooManyTokens = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, 'v']));
  const lines = [
    '', 'not json', 'null', '42', '[]', '{"v":1}',
    JSON.stringify({ v: 2, cmd: 'report-metadata', pane: 't1', source: 'mirador:attention', seq: 1, tokens: { blocked: 'x' } }),
    report('t1', { cmd: 'pane-close' } as never),
    report('t1', { seq: -1, tokens: { blocked: 'x' } }),
    report('t1', { seq: 1.5, tokens: { blocked: 'x' } }),
    report('t1', { seq: '7' as never, tokens: { blocked: 'x' } }),
    report('t1', { source: 'bad source!', tokens: { blocked: 'x' } }),
    report('t1', { tokens: { blocked: 42 as never } }),
    report('t1', { tokens: tooManyTokens }),
    report('t1', { tokens: { blocked: 'x'.repeat(5000) } }),
    report('t1', { clear: 'blocked' as never }),
    report('t1', { ttlMs: -5, tokens: { blocked: 'x' } }),
    report('../../t1', { tokens: { blocked: 'x' } }),
    '{"v":1,"cmd":"report-metadata","pane":"t1","source":"mirador:attention","seq":1,"tokens":{"blocked":"x"}',
  ];
  for (const line of lines) assert.equal(store.receive(line), false, line.slice(0, 80));
  assert.deepEqual(store.items(), []);
});

test('the label is shown as plain text: control and bidi characters are dropped and it is capped', () => {
  const { store } = setup();
  store.track({ type: 'created', info: terminal('t1') });
  store.receive(blocked('t1', `\u001b[31mApprove‮   rm\n -rf${'!'.repeat(300)}`));
  const [item] = store.items();
  assert.ok(item.label.startsWith('[31mApprove rm -rf!!!'), item.label);
  assert.ok(item.label.length <= 160, String(item.label.length));
  assert.doesNotMatch(item.label, /[\u0000-\u001f\u007f‮]/);
});

test('unblocking clears the item, and an older report arriving late cannot bring it back', () => {
  const { store } = setup();
  store.track({ type: 'created', info: terminal('t1') });
  store.receive(blocked('t1', 'Questionnaire awaiting input', 10));
  assert.equal(store.items().length, 1);

  assert.equal(store.receive(unblocked('t1', 11)), true);
  assert.deepEqual(store.items(), []);
  assert.equal(store.receive(blocked('t1', 'Questionnaire awaiting input', 10)), false, 'same seq is stale');
  assert.equal(store.receive(blocked('t1', 'Questionnaire awaiting input', 9)), false, 'lower seq is stale');
  assert.deepEqual(store.items(), []);
});

test('a new label while still blocked keeps the original waiting start', () => {
  const { store, advance } = setup();
  store.track({ type: 'created', info: terminal('t1') });
  store.receive(blocked('t1', 'Guarded command confirmation', 1));
  advance(60_000);
  store.receive(blocked('t1', 'Choice awaiting input', 2));
  assert.deepEqual(store.items().map((i) => [i.label, i.since]), [['Choice awaiting input', '2026-10-28T10:05:00.000Z']]);
});

test('a terminal that exits or is closed leaves the inbox', () => {
  const { store } = setup();
  for (const id of ['a', 'b']) {
    store.track({ type: 'created', info: terminal(id) });
    store.receive(blocked(id, 'Choice awaiting input'));
  }
  assert.equal(store.items().length, 2);
  store.track({ type: 'exited', info: { ...terminal('a'), status: 'exited', exitCode: 1 } });
  assert.deepEqual(store.items().map((i) => i.terminalId), ['b']);
  store.track({ type: 'closed', info: terminal('b') });
  assert.deepEqual(store.items(), []);
});

test('gentle-shell activity says what a blocked agent was doing, but alone it is not attention', () => {
  const { store, advance } = setup();
  store.track({ type: 'created', info: terminal('t1') });
  const activity = (seq: number, tokens: Record<string, string>, clear: string[] = []) =>
    report('t1', { source: 'gentle:activity', seq, ttlMs: 30_000, tokens, clear });

  assert.equal(store.receive(activity(100, { summary: '◐ Wire the inbox' }, ['summary2'])), true);
  assert.deepEqual(store.items(), [], 'working is not waiting');

  store.receive(blocked('t1', 'Guarded command confirmation'));
  assert.equal(store.items()[0].activity, '◐ Wire the inbox');
  store.receive(activity(101, { summary: '◐ Wire the', summary2: '  inbox stream' }));
  assert.equal(store.items()[0].activity, '◐ Wire the inbox stream');

  advance(31_000);
  assert.equal(store.items()[0].activity, null, 'activity expires with its herdr TTL');
});

test('subscribers hear only changes to the inbox', () => {
  const { store } = setup();
  const heard: AttentionItem[][] = [];
  const off = store.subscribe((items) => heard.push(items));
  store.track({ type: 'created', info: terminal('t1') });
  store.receive(report('t1', { source: 'gentle:activity', seq: 1, tokens: { summary: '◐ x' } }));
  assert.equal(heard.length, 0, 'nothing pending yet');
  store.receive(blocked('t1', 'Choice awaiting input', 2));
  store.receive(blocked('t1', 'Choice awaiting input', 3));
  assert.equal(heard.length, 1, 'a repeated report changes nothing');
  store.track({ type: 'closed', info: terminal('t1') });
  assert.deepEqual(heard.map((items) => items.length), [1, 0]);
  off();
  store.track({ type: 'created', info: terminal('t2') });
  store.receive(blocked('t2', 'Choice awaiting input'));
  assert.equal(heard.length, 2, 'unsubscribed');
});

test('a throwing subscriber does not stop the others or the store', () => {
  const { store } = setup();
  let calls = 0;
  store.subscribe(() => { throw new Error('boom'); });
  store.subscribe(() => { calls++; });
  store.track({ type: 'created', info: terminal('t1') });
  assert.equal(store.receive(blocked('t1', 'Choice awaiting input')), true);
  assert.equal(calls, 1);
});

class FakePty implements PtyProcess {
  env: Record<string, string>;
  constructor(env: Record<string, string>) { this.env = env; }
  onData() {}
  onExit() {}
  write() {}
  resize() {}
  kill() {}
}

test('agent terminals get the herdr variables with their own pane id; shell terminals get none', () => {
  const spawned: FakePty[] = [];
  const spawn: SpawnFn = (_file, _args, opts) => { const p = new FakePty(opts.env); spawned.push(p); return p; };
  const registry = new TerminalRegistry(spawn, {
    shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/run/mirador/agent.bashrc',
    env: { HOME: '/home/you' }, scrollbackLimit: 1000,
  });
  registry.addEnvProvider(herdrEnvProvider({ socketPath: '/run/mirador/herdr/socket', binPath: '/run/mirador/herdr/herdr' }));

  const agent = registry.create({ cwd: '/tmp', kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });
  const shell = registry.create({ cwd: '/tmp', kind: 'shell', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });

  const herdr = (env: Record<string, string>) => Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('HERDR_')));
  assert.deepEqual(herdr(spawned[0].env), {
    HERDR_ENV: '1', HERDR_PANE_ID: agent.id, HERDR_SOCKET_PATH: '/run/mirador/herdr/socket', HERDR_BIN_PATH: '/run/mirador/herdr/herdr',
  });
  assert.deepEqual(herdr(spawned[1].env), {}, `shell ${shell.id} must not look like a herdr pane`);
});

test('a second Mirador never takes over a socket another one is serving, but a stale one is replaced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mirador-sock-'));
  const path = join(dir, 'herdr', 'socket');
  const send = (line: string) => new Promise<void>((resolve) => {
    const conn = createConnection(path);
    conn.on('error', () => resolve());
    conn.on('close', () => resolve());
    conn.on('connect', () => conn.end(line));
  });
  try {
    const lines: string[] = [];
    const first = await listenForReports(path, (line) => lines.push(line));
    assert.equal((await stat(join(dir, 'herdr'))).mode & 0o777, 0o700);
    await assert.rejects(listenForReports(path, () => {}), /in use/);
    await send('still mine\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(lines, ['still mine']);
    first.close();

    await writeFile(path, 'left behind by a crash');
    const again = await listenForReports(path, () => {});
    assert.ok((await stat(path)).isSocket());
    again.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** The bridge's whole state in one report, as it sends it. */
const attention = (pane: string, seq: number, state: { blocked?: string; prompt?: string; finished?: string }) => {
  const tokens = Object.fromEntries(Object.entries(state).filter(([, v]) => v !== undefined)) as Record<string, string>;
  return report(pane, { seq, tokens, clear: ['blocked', 'prompt', 'finished'].filter((key) => !(key in tokens)) });
};
const view = (items: AttentionItem[]) => items.map((i) => [i.terminalId, i.kind, i.label, i.detail]);

test('an open dialog is an answer the agent waits for, with its title as the reason', () => {
  const { store } = setup();
  store.track({ type: 'created', info: terminal('t1') });
  store.receive(attention('t1', 1, { prompt: 'Authorize review authority ABANDON?' }));
  assert.deepEqual(view(store.items()), [['t1', 'prompt', 'Authorize review authority ABANDON?', null]]);
  store.receive(attention('t1', 2, {}));
  assert.deepEqual(store.items(), []);
});

test('a gentle-ai blocker keeps its reason and carries the dialog title as detail', () => {
  const { store, advance } = setup();
  store.track({ type: 'created', info: terminal('t1') });
  store.receive(attention('t1', 1, { blocked: 'Guarded command confirmation' }));
  advance(5_000);
  store.receive(attention('t1', 2, { blocked: 'Guarded command confirmation', prompt: 'Allow recognized data-loss command?' }));
  assert.deepEqual(view(store.items()), [['t1', 'blocked', 'Guarded command confirmation', 'Allow recognized data-loss command?']]);
  assert.equal(store.items()[0].since, '2026-10-28T10:05:00.000Z', 'still the same wait');
  store.receive(attention('t1', 3, { prompt: 'Allow recognized data-loss command?' }));
  assert.deepEqual(view(store.items()), [['t1', 'prompt', 'Allow recognized data-loss command?', null]]);
});

test('a finished turn is a separate, lower-priority item; waiting for an answer outranks it', () => {
  const { store, advance } = setup();
  for (const id of ['done', 'asks']) store.track({ type: 'created', info: terminal(id) });
  store.receive(attention('done', 1, { finished: 'ep1' }));
  advance(60_000);
  store.receive(attention('asks', 1, { prompt: 'Pick a database' }));
  assert.deepEqual(view(store.items()), [['asks', 'prompt', 'Pick a database', null], ['done', 'finished', 'Finished', null]], 'answers first, even when newer');
  assert.equal(store.items()[1].since, '2026-10-28T10:05:00.000Z');

  store.receive(attention('done', 2, { finished: 'ep1', blocked: 'Choice awaiting input' }));
  assert.deepEqual(view(store.items()).map((v) => v.slice(0, 2)), [['asks', 'prompt'], ['done', 'blocked']], 'one item per terminal, the answer wins');
});

test('seeing a finished terminal dismisses that turn only; the next turn shows again', () => {
  const { store } = setup();
  store.track({ type: 'created', info: terminal('t1') });
  store.receive(attention('t1', 1, { finished: 'ep1' }));
  assert.equal(store.dismiss('t1'), true);
  assert.deepEqual(store.items(), []);
  assert.equal(store.dismiss('t1'), false, 'nothing left to dismiss');
  store.receive(attention('t1', 2, { finished: 'ep1', prompt: 'Run /gentle:models?' }));
  store.receive(attention('t1', 3, { finished: 'ep1' }));
  assert.deepEqual(store.items(), [], 'the same turn does not come back with a later report');
  store.receive(attention('t1', 4, {}));
  store.receive(attention('t1', 5, { finished: 'ep2' }));
  assert.deepEqual(view(store.items()), [['t1', 'finished', 'Finished', null]]);
  assert.equal(store.dismiss('nobody'), false);
});

test('dismissing never clears a terminal that waits for an answer', () => {
  const { store } = setup();
  store.track({ type: 'created', info: terminal('t1') });
  store.receive(attention('t1', 1, { blocked: 'Questionnaire awaiting input', prompt: 'Which port?' }));
  assert.equal(store.dismiss('t1'), false);
  assert.deepEqual(view(store.items()), [['t1', 'blocked', 'Questionnaire awaiting input', 'Which port?']]);
});

test('typing is told apart from the replies a terminal sends on its own', () => {
  for (const data of ['a', 'ls\r', '\r', '\x7f', '\x1b[A', '\x1b', '\x03', 'é', '\x1b[200~pasted\x1b[201~']) assert.equal(isTyping(data), true, JSON.stringify(data));
  for (const data of ['', '\x1b[I', '\x1b[O', '\x1b[12;40R', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[?2026;2$y', '\x1b[?7u', '\x1b[8;40;120t',
    '\x1b]11;rgb:1313/1616/1c1c\x07', '\x1b]10;rgb:d6d6/dbdb/e5e5\x1b\\', '\x1bP1+r544e=787465726d\x1b\\', '\x1b[<64;10;5M', '\x1b[I\x1b[12;40R']) {
    assert.equal(isTyping(data), false, JSON.stringify(data));
  }
});

test('the registry tells listeners what was typed into a running terminal', () => {
  const ptys: Array<{ exit: (code: number) => void }> = [];
  const spawn: SpawnFn = () => {
    let onExit: (e: { exitCode: number }) => void = () => {};
    ptys.push({ exit: (code) => onExit({ exitCode: code }) });
    return { onData() {}, onExit(l) { onExit = l; }, write() {}, resize() {}, kill() {} };
  };
  const registry = new TerminalRegistry(spawn, { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/rc', env: {}, scrollbackLimit: 100 });
  const heard: Array<[string, string]> = [];
  registry.onInput(() => { throw new Error('boom'); });
  const off = registry.onInput((id, data) => heard.push([id, data]));
  const a = registry.create({ cwd: '/tmp', kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });
  registry.write(a.id, 'yes\r');
  ptys[0].exit(0);
  registry.write(a.id, 'ignored');
  off();
  const b = registry.create({ cwd: '/tmp', kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });
  registry.write(b.id, 'x');
  assert.deepEqual(heard, [[a.id, 'yes\r']]);
});

test('reports from unknown sources cannot take the slots of the bridge and gentle-shell', () => {
  const { store } = setup();
  store.track({ type: 'created', info: terminal('t1') });
  const other = (source: string) => report('t1', { source, tokens: { blocked: 'Spoofed' } });
  assert.equal(store.receive(other('x:one')), true);
  assert.equal(store.receive(other('x:two')), true);
  assert.equal(store.receive(other('x:three')), false, 'unknown sources get two slots at most');
  assert.equal(store.receive(other('x:four')), false);

  assert.equal(store.receive(blocked('t1', 'Guarded command confirmation')), true, 'the bridge still reports');
  assert.equal(store.receive(report('t1', { source: 'gentle:activity', tokens: { summary: '◐ Wire the inbox' } })), true, 'gentle-shell still reports');
  assert.deepEqual(store.items().map((i) => [i.label, i.activity]), [['Guarded command confirmation', '◐ Wire the inbox']]);
});

test('a single huge seq cannot lock the bridge out', () => {
  const { store } = setup();
  const now = Date.parse('2026-10-28T10:05:00.000Z');
  store.track({ type: 'created', info: terminal('t1') });
  assert.equal(store.receive(blocked('t1', 'Spoofed', Number.MAX_SAFE_INTEGER)), false, 'far beyond the clock');
  assert.equal(store.receive(blocked('t1', 'Guarded command confirmation', now + 1)), true, 'a clock-based seq, as the bridge sends');
  assert.equal(store.receive(blocked('t1', 'Spoofed', now + 10 ** 12)), false, 'a huge jump from the current seq');
  assert.equal(store.receive(unblocked('t1', now + 2)), true, 'the bridge keeps reporting');
  assert.deepEqual(store.items(), []);
  assert.equal(store.receive(blocked('t1', 'Choice awaiting input', now + 30_000)), true, 'a seq a little ahead of the clock is fine');
});

test('a report that expires is pushed to subscribers when it expires, not at the next change', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { store, advance } = setup();
  const heard: AttentionItem[][] = [];
  store.subscribe((items) => heard.push(items));
  store.track({ type: 'created', info: terminal('t1') });
  store.receive(report('t1', { ttlMs: 30_000, tokens: { blocked: 'Guarded command confirmation' } }));
  store.receive(report('t1', { source: 'gentle:activity', ttlMs: 10_000, tokens: { summary: '◐ Wire the inbox' } }));
  assert.deepEqual(heard.at(-1)?.map((i) => [i.label, i.activity]), [['Guarded command confirmation', '◐ Wire the inbox']]);

  advance(10_000);
  t.mock.timers.tick(10_000);
  assert.deepEqual(heard.at(-1)?.map((i) => [i.label, i.activity]), [['Guarded command confirmation', null]], 'the activity expired');

  advance(20_000);
  t.mock.timers.tick(20_000);
  assert.deepEqual(heard.at(-1), [], 'the blocker expired');
  const count = heard.length;
  advance(60_000);
  t.mock.timers.tick(60_000);
  assert.equal(heard.length, count, 'nothing else to push');
});

test('a hook working report with a TTL reads unknown once it expires, a refresh keeps it working, and finished never expires (#3)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { store, advance } = setup();
  const states: Array<[string, string]> = [];
  const heard: AttentionItem[][] = [];
  store.onAgentState((id, state) => states.push([id, state]));
  store.subscribe((items) => heard.push(items));
  store.track({ type: 'created', info: terminal('t1') });
  const now = Date.parse('2026-10-28T10:05:00.000Z');
  const working = (seq: number) => report('t1', { seq, ttlMs: 600_000, tokens: { session: 's1' }, clear: ['blocked', 'prompt', 'finished'] });
  assert.equal(store.receive(working(now)), true);
  assert.equal(store.agentState('t1'), 'working');

  // A tool event 9 minutes in refreshes it: 10 minutes from then, not from the first report.
  advance(540_000);
  t.mock.timers.tick(540_000);
  assert.equal(store.receive(working(now + 540_000)), true);
  advance(540_000);
  t.mock.timers.tick(540_000);
  assert.equal(store.agentState('t1'), 'working', '18 minutes in, 9 after the refresh');
  assert.deepEqual(states, [['t1', 'working']]);

  // No hook for 10 minutes after the refresh (a turn cut by Esc): the state listener hears unknown at expiry.
  advance(60_000);
  t.mock.timers.tick(60_000);
  assert.equal(store.agentState('t1'), 'unknown');
  assert.deepEqual(states, [['t1', 'working'], ['t1', 'unknown']]);
  assert.deepEqual(heard.at(-1) ?? [], [], 'no card for an expired working report');

  // The next turn works again, and its finished report (no TTL) stays finished.
  assert.equal(store.receive(working(now + 1_200_000)), true);
  assert.equal(store.receive(report('t1', { seq: now + 1_200_001, ttlMs: null, tokens: { session: 's1', finished: String(now + 1_200_001) }, clear: ['blocked', 'prompt'] })), true);
  advance(3_600_000);
  t.mock.timers.tick(3_600_000);
  assert.equal(store.agentState('t1'), 'finished');
  assert.deepEqual(states.map(([, state]) => state), ['working', 'unknown', 'working', 'finished']);
  assert.deepEqual(heard.at(-1)?.map((item) => [item.terminalId, item.kind]), [['t1', 'finished']]);
});

test('a hook waiting report has no TTL: it still waits after the working TTL', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { store, advance } = setup();
  store.track({ type: 'created', info: terminal('t1') });
  const now = Date.parse('2026-10-28T10:05:00.000Z');
  store.receive(report('t1', { seq: now, ttlMs: 600_000, tokens: { session: 's1' }, clear: ['blocked', 'prompt', 'finished'] }));
  store.receive(report('t1', { seq: now + 1, ttlMs: null, tokens: { session: 's1', prompt: 'Allow Bash?' }, clear: ['blocked', 'finished'] }));
  advance(3_600_000);
  t.mock.timers.tick(3_600_000);
  assert.equal(store.agentState('t1'), 'waiting');
  assert.deepEqual(view(store.items()), [['t1', 'prompt', 'Allow Bash?', null]]);
});

test('reports each just under the cap cannot ratchet the seq past the bridge, which recovers', () => {
  const { store, advance } = setup();
  let now = Date.parse('2026-10-28T10:05:00.000Z');
  store.track({ type: 'created', info: terminal('t1') });
  assert.equal(store.receive(blocked('t1', 'Guarded command confirmation', now + 1)), true);

  // A spoofer that keeps each report just under the cap, measured from the clock or from the last seq it sent.
  let sent = now + 1;
  for (let i = 0; i < 100; i++) {
    advance(1000);
    now += 1000;
    sent = Math.max(sent + 59_999, now + 59_999);
    store.receive(blocked('t1', 'Spoofed', sent));
  }
  assert.equal(store.items()[0].label, 'Spoofed');
  assert.equal(store.receive(blocked('t1', 'Questionnaire awaiting input', now + 2)), true, 'the bridge, numbering from the clock, is not locked out');
  assert.equal(store.items()[0].label, 'Questionnaire awaiting input');
  assert.equal(store.receive(blocked('t1', 'Stale', now + 1)), false, 'after recovering, a lower seq is stale again');
  assert.equal(store.receive(blocked('t1', 'Spoofed', now + 10 ** 9)), false, 'and a seq far past the clock is never stored');
});

test('a known source keeps reporting after the clock steps back past the cap; first contact stays capped by the clock', () => {
  const { store, advance } = setup();
  const start = Date.parse('2026-10-28T10:05:00.000Z');
  store.track({ type: 'created', info: terminal('t1') });
  assert.equal(store.receive(blocked('t1', 'Guarded command confirmation', start + 1)), true);

  advance(-2 * 60 * 60 * 1000);
  assert.equal(store.receive(unblocked('t1', start + 2)), true, 'the bridge keeps numbering from its stored seq');
  assert.deepEqual(store.items(), []);
  assert.equal(store.receive(blocked('t1', 'Choice awaiting input', start + 3)), true);
  assert.deepEqual(store.items().map((i) => [i.kind, i.label, i.since]), [['blocked', 'Choice awaiting input', '2026-10-28T08:05:00.000Z']]);
  assert.equal(store.receive(blocked('t1', 'Spoofed', start + 3 + 60_001)), false, 'a known source is capped from its stored seq');
  assert.equal(store.items()[0].label, 'Choice awaiting input');
  assert.equal(store.receive(report('t1', { source: 'gentle:activity', seq: start + 4, tokens: { summary: '◐ Wire the inbox' } })), false, 'a source never seen is capped from the clock');
  assert.equal(store.items()[0].activity, null);
  assert.equal(store.receive(unblocked('t1', start + 4)), true, 'the bridge still reports');
  assert.deepEqual(store.items(), []);
});

test('a seq stored ahead of the clock is replaced by the next report at the clock, with a fresh token set', () => {
  const { store } = setup();
  const now = Date.parse('2026-10-28T10:05:00.000Z');
  store.track({ type: 'created', info: terminal('t1') });
  assert.equal(store.receive(report('t1', { seq: now + 59_000, tokens: { blocked: 'Spoofed', extra: 'left behind' } })), true);
  assert.equal(store.receive(report('t1', { seq: now + 30_000, tokens: { blocked: 'Spoofed again' } })), false, 'still beyond what a clock-based reporter sends');
  assert.equal(store.receive(attention('t1', now - 5, { prompt: 'Pick a database' })), true, 'the real reporter recovers the source');
  assert.deepEqual(view(store.items()), [['t1', 'prompt', 'Pick a database', null]]);
  assert.equal(store.receive(attention('t1', now - 6, {})), false, 'its own lower seq is stale as usual');
});
