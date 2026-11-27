// The local "where it left off" record from Claude Code's hooks, rule by rule: what bin/claude-hook
// sends for each event, the config keys `leftOff` and `leftOffDays`, how a record is read back and
// expires, how the folder view picks the newest of Engram's summary and the record and names its
// source, which of the record's two agent texts is shown (the newer), SessionEnd's reason, Forget on
// the block, and how both modes show it (as text). The end-to-end path is test/left-off-local.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { claudeSettings, prepareClaudeSettings } from '../src/attention/claude-hooks.ts';
import { LEFT_OFF_MAX_TEXT_BYTES, boundText, readLeftOff, recordFile, type LeftOffRecord } from '../src/memory/left-off.ts';
import { buildWorkspaceOverview, type OverviewFolder } from '../src/memory/overview.ts';
// The browser modules have no type declarations: loaded by a computed path, typed loosely.
const publicModule = (path: string): Promise<any> => import(new URL(`../public/${path}`, import.meta.url).href);
const { leftOffLayout, sourceKey } = await publicModule('leftoff-model.js');
const { plainLeftOffView } = await publicModule('features/plain-left-off.js');
const { MESSAGES, translate } = await publicModule('i18n.js');

const HOOK = fileURLToPath(new URL('../bin/claude-hook', import.meta.url));
const ID = '0f8e2a4c-1b7d-4e5f-9a6b-3c2d1e0f9a8b';

/** Runs bin/claude-hook with `stdin` (and `args`) for pane `pane-1`; resolves with the lines it sent. */
async function hook(stdin: string, args: string[] = []): Promise<Array<Record<string, any>>> {
  const dir = await mkdtemp(join(tmpdir(), 'mirador-left-off-hook-'));
  const socketPath = join(dir, 'socket');
  const lines: Array<Record<string, any>> = [];
  const listener = createServer((conn) => {
    let buffered = '';
    conn.on('data', (chunk) => (buffered += chunk));
    conn.on('end', () => lines.push(...buffered.split('\n').filter(Boolean).map((line) => JSON.parse(line))));
  });
  await new Promise<void>((resolve) => listener.listen(socketPath, resolve));
  try {
    const child = spawn(process.execPath, [HOOK, ...args], { env: { HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: 'pane-1', PATH: '/usr/bin' }, stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.end(stdin);
    assert.equal(await new Promise<number | null>((resolve) => child.on('exit', resolve)), 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    return lines;
  } finally {
    listener.close();
    await rm(dir, { recursive: true, force: true });
  }
}
const payload = (event: string, fields: object = {}) => JSON.stringify({ session_id: ID, transcript_path: `/h/.claude/projects/x/${ID}.jsonl`, cwd: '/w/alpha', hook_event_name: event, ...fields });
const leftOffLines = (lines: Array<Record<string, any>>) => lines.filter((line) => line.cmd === 'left-off');

/* ---------- T1: the hook forwards the documented fields ---------- */

test('the hook sends the prompt, the final message and the compaction summary as left-off lines after the attention line', async () => {
  const asked = await hook(payload('UserPromptSubmit', { prompt: '/deploy staging' }));
  assert.deepEqual(asked.map((line) => line.cmd), ['report-metadata', 'left-off'], 'the attention line first, unchanged');
  assert.deepEqual(leftOffLines(asked), [{ v: 1, cmd: 'left-off', pane: 'pane-1', agent: 'claude-code', event: 'UserPromptSubmit', session: ID, text: '/deploy staging' }]);
  const stopped = leftOffLines(await hook(payload('Stop', { stop_hook_active: false, last_assistant_message: 'Done.' })));
  assert.deepEqual(stopped.map((line) => [line.event, line.text]), [['Stop', 'Done.']]);
  const compacted = await hook(payload('PostCompact', { trigger: 'auto', compact_summary: 'So far: the hook.' }));
  assert.deepEqual(compacted.map((line) => [line.cmd, line.event, line.text]), [['left-off', 'PostCompact', 'So far: the hook.']], 'PostCompact reports no attention state');
});

test('the hook bounds a long text after paste expansion, and sends nothing for a missing field, a bad session or --no-left-off', async () => {
  const big = 'ñ'.repeat(20_000);
  const [line] = leftOffLines(await hook(payload('UserPromptSubmit', { prompt: big })));
  assert.ok(Buffer.byteLength(line.text) <= LEFT_OFF_MAX_TEXT_BYTES);
  assert.equal(line.truncated, true);
  assert.ok(line.text.endsWith('…'));
  assert.equal(line.text.includes('�'), false);
  assert.deepEqual(leftOffLines(await hook(payload('Stop', { stop_hook_active: false }))), [], 'no last message: nothing');
  assert.deepEqual(leftOffLines(await hook(payload('Stop', { last_assistant_message: 42 }))), [], 'not text: nothing');
  assert.deepEqual(leftOffLines(await hook(payload('Stop', { session_id: '--help', last_assistant_message: 'x' }))), [], 'no valid session: nothing');
  const off = await hook(payload('UserPromptSubmit', { prompt: 'private' }), ['--no-left-off']);
  assert.deepEqual(off.map((l) => l.cmd), ['report-metadata'], '--no-left-off: attention only');
});

test('the hook sends SessionEnd\'s reason as a left-off line without text or attention report; a bad reason or --no-left-off sends nothing', async () => {
  const ended = await hook(payload('SessionEnd', { reason: 'prompt_input_exit' }));
  assert.deepEqual(ended, [{ v: 1, cmd: 'left-off', pane: 'pane-1', agent: 'claude-code', event: 'SessionEnd', session: ID, reason: 'prompt_input_exit' }]);
  assert.deepEqual(leftOffLines(await hook(payload('SessionEnd', { reason: 'other' }))).map((line) => line.reason), ['other']);
  for (const reason of [undefined, 42, '', 'Not A Reason', 'clear; rm -rf', 'x'.repeat(65), 'clear\n']) {
    assert.deepEqual(await hook(payload('SessionEnd', reason === undefined ? {} : { reason })), [], `reason ${JSON.stringify(reason)}: nothing`);
  }
  assert.deepEqual(await hook(payload('SessionEnd', { session_id: '--help', reason: 'clear' })), [], 'no valid session: nothing');
  assert.deepEqual(await hook(payload('SessionEnd', { reason: 'clear' }), ['--no-left-off']), [], '--no-left-off: nothing');
  // PRESERVE: Stop still sends its attention report and its final message, with no reason.
  const stopped = await hook(payload('Stop', { last_assistant_message: 'Done.', reason: 'clear' }));
  assert.deepEqual(stopped.map((line) => [line.cmd, line.reason]), [['report-metadata', undefined], ['left-off', undefined]]);
});

test('the settings add PostCompact and SessionEnd, and --no-left-off when the capture is off; nothing else changes', async () => {
  assert.deepEqual(Object.keys(claudeSettings('hook').hooks), ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'PostCompact', 'SessionEnd']);
  const dir = await mkdtemp(join(tmpdir(), 'mirador-left-off-settings-'));
  try {
    const on = JSON.parse(await readFile(await prepareClaudeSettings(dir, '/app/bin/claude-hook', '/usr/bin/node'), 'utf8'));
    assert.equal(on.hooks.Stop[0].hooks[0].command, "'/usr/bin/node' '/app/bin/claude-hook'", 'PRESERVE: the command as before');
    const off = JSON.parse(await readFile(await prepareClaudeSettings(dir, '/app/bin/claude-hook', '/usr/bin/node', { leftOff: false }), 'utf8'));
    assert.equal(off.hooks.Stop[0].hooks[0].command, "'/usr/bin/node' '/app/bin/claude-hook' '--no-left-off'");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('boundText keeps text within the bound whole, and cuts longer text on a character with the marker', () => {
  assert.deepEqual(boundText('short'), { text: 'short', truncated: false });
  const exact = 'a'.repeat(LEFT_OFF_MAX_TEXT_BYTES);
  assert.deepEqual(boundText(exact), { text: exact, truncated: false });
  const cut = boundText('😀'.repeat(LEFT_OFF_MAX_TEXT_BYTES));
  assert.equal(cut.truncated, true);
  assert.ok(Buffer.byteLength(cut.text) <= LEFT_OFF_MAX_TEXT_BYTES);
  assert.match(cut.text, /^(😀)+…$/u);
});

/* ---------- T2: config ---------- */

test('leftOffDays is 30 by default, a whole number of days from 1 to 3650, and leftOff only turns off with false', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mirador-left-off-config-'));
  const file = join(dir, 'config.json');
  const load = async (saved: object) => {
    await writeFile(file, JSON.stringify(saved));
    return loadConfig(file, { HOME: dir });
  };
  try {
    const plain = await load({});
    assert.deepEqual([plain.leftOffDays, plain.leftOff, plain.launchProblems], [30, true, []]);
    assert.equal((await loadConfig(join(dir, 'missing.json'), { HOME: dir })).leftOffDays, 30, 'no file: the default');
    const set = await load({ leftOffDays: 7, leftOff: false });
    assert.deepEqual([set.leftOffDays, set.leftOff, set.launchProblems], [7, false, []]);
    for (const bad of [0, 3651, 1.5, '30', null]) {
      const loaded = await load({ leftOffDays: bad });
      assert.equal(loaded.leftOffDays, 30, String(bad));
      assert.deepEqual(loaded.launchProblems, bad === null ? [] : ['leftOffDays must be a whole number of days from 1 to 3650; the default (30) applies'], String(bad));
    }
    assert.equal((await load({ leftOff: 'no' })).leftOff, true, 'only false turns it off');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---------- T2: reading back and expiry ---------- */

const record = (fields: Partial<LeftOffRecord> = {}): LeftOffRecord => ({
  v: 1,
  agent: 'claude-code',
  workspaceId: 'dev',
  rel: 'alpha',
  sessionId: ID,
  at: '2026-10-28T12:00:00.000Z',
  lastUserMessage: { text: 'fix the tests', at: '2026-10-28T11:00:00.000Z' },
  lastMessage: { text: 'Fixed.\n\n## Next steps\n- ship it', at: '2026-10-28T12:00:00.000Z' },
  compactSummary: null,
  ...fields,
});

test('a record is read back while it is younger than its days, and an invalid one reads as none', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mirador-left-off-read-'));
  try {
    const file = recordFile(dir, 'dev', 'alpha');
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, JSON.stringify(record()));
    const now = Date.parse('2026-11-20T12:00:00.000Z');
    assert.deepEqual(await readLeftOff(dir, 'dev', 'alpha', { days: 30, now }), record());
    assert.equal(await readLeftOff(dir, 'dev', 'alpha', { days: 10, now }), null, 'older than leftOffDays: none');
    assert.equal(await readLeftOff(dir, 'dev', 'beta', { days: 30, now }), null, 'another folder: none');
    assert.notEqual(recordFile(dir, 'dev', 'alpha'), recordFile(dir, 'dev', 'beta'));
    assert.ok(recordFile(dir, '../x', 'a').startsWith(dir + '/'), 'an odd workspace id stays inside the folder');
    // Format v1 with the end of the session: endedAt and endReason, both or neither.
    const ended = { ...record(), endedAt: '2026-10-28T12:30:00.000Z', endReason: 'prompt_input_exit' };
    await writeFile(file, JSON.stringify(ended));
    assert.deepEqual(await readLeftOff(dir, 'dev', 'alpha', { days: 30, now }), ended);
    for (const broken of [
      'not json',
      JSON.stringify({ ...record(), v: 2 }),
      JSON.stringify({ ...record(), lastMessage: { text: 5 } }),
      JSON.stringify({ ...record(), at: 'yesterday' }),
      JSON.stringify({ ...ended, endedAt: 'later' }),
      JSON.stringify({ ...ended, endReason: 'Not A Reason' }),
      JSON.stringify({ ...record(), endedAt: '2026-10-28T12:30:00.000Z' }),
      JSON.stringify({ ...record(), endReason: 'other' }),
    ]) {
      await writeFile(file, broken);
      assert.equal(await readLeftOff(dir, 'dev', 'alpha', { days: 30, now }), null, broken);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---------- T3: newest wins, with its source ---------- */

const folder: OverviewFolder = { name: 'alpha', rel: 'alpha', path: '/w/alpha', isRepo: true, projects: ['alpha'], hasMemory: true };
const engramSummary = (created_at: string) => ({ id: 1, type: 'session_summary', title: 'Session summary', project: 'alpha', created_at, content: '## Goal\nFrom Engram\n## Next Steps\n- engram step' });
const overview = (observations: object[], local: LeftOffRecord | null) =>
  buildWorkspaceOverview({ date: '2026-10-28', timeZone: 'UTC', folders: [folder], observations: observations as any, windowFull: false, foldLines: Infinity, goalLines: Infinity, goalChars: Infinity, localLeftOff: () => local }).rows[0];

test('the newer of Engram\'s summary and the local record wins; the record names its source and brings the user\'s last message', () => {
  const local = overview([engramSummary('2026-10-27 10:00:00')], record());
  assert.deepEqual(local.leftOff.summary, { at: '2026-10-28 12:00:00', goal: null, accomplished: null, nextSteps: '- ship it', source: 'claude-code', from: 'lastMessage', lastUserMessage: 'fix the tests' });
  assert.deepEqual([local.lastAt, local.lastDay], ['2026-10-28 12:00:00', '2026-10-28'], 'last worked counts the record');
  const engram = overview([engramSummary('2026-10-29 10:00:00')], record());
  assert.deepEqual(engram.leftOff.summary, { at: '2026-10-29 10:00:00', goal: 'From Engram', accomplished: null, nextSteps: '- engram step' }, 'Engram\'s summary as before');
  assert.equal(engram.lastAt, '2026-10-29 10:00:00');
  const onlyLocal = overview([], record({ lastMessage: null, compactSummary: { text: 'Compacted text.', at: '2026-10-28T09:00:00.000Z' } }));
  assert.deepEqual(onlyLocal.leftOff.summary, { at: '2026-10-28 09:00:00', goal: null, accomplished: null, nextSteps: null, excerpt: 'Compacted text.', source: 'claude-code', from: 'compactSummary', lastUserMessage: 'fix the tests' });
  const asked = overview([], record({ lastMessage: null }));
  assert.deepEqual([asked.leftOff.summary?.from, asked.leftOff.summary?.at, asked.leftOff.summary?.lastUserMessage], ['lastUserMessage', '2026-10-28 11:00:00', 'fix the tests']);
  const long = overview([], record({ lastUserMessage: { text: Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'), at: '2026-10-28T11:00:00.000Z' } }));
  assert.equal(long.leftOff.summary?.lastUserMessage?.split('\n').length, 13, 'the user\'s message is clipped like an excerpt: 12 lines and "…"');
  assert.deepEqual(overview([engramSummary('2026-10-27 10:00:00')], null).leftOff.summary, { at: '2026-10-27 10:00:00', goal: 'From Engram', accomplished: null, nextSteps: '- engram step' }, 'PRESERVE: no record, Engram as before');
});

test('Engram is compared with the time of the text the view shows, not the latest write: a later prompt never flips it to an older final message', () => {
  // Final message at 10:00, Engram's summary at 11:00, then a prompt at 12:00 (the record's latest write).
  const later = record({ at: '2026-10-28T12:00:00.000Z', lastUserMessage: { text: 'and now?', at: '2026-10-28T12:00:00.000Z' }, lastMessage: { text: 'Old answer.', at: '2026-10-28T10:00:00.000Z' } });
  const flipped = overview([engramSummary('2026-10-28 11:00:00')], later);
  assert.deepEqual(flipped.leftOff.summary, { at: '2026-10-28 11:00:00', goal: 'From Engram', accomplished: null, nextSteps: '- engram step' }, 'Engram\'s newer summary stays');
  assert.equal(flipped.lastAt, '2026-10-28 12:00:00', 'the prompt still counts as last worked');
  // A record with only a prompt never beats Engram's summary, however new.
  const bare = record({ at: '2026-10-28T12:00:00.000Z', lastUserMessage: { text: 'hello', at: '2026-10-28T12:00:00.000Z' }, lastMessage: null, compactSummary: null });
  assert.equal(overview([engramSummary('2026-10-27 10:00:00')], bare).leftOff.summary?.source, undefined);
  assert.equal(overview([], bare).leftOff.summary?.from, 'lastUserMessage', 'PRESERVE: with no Engram summary the prompt still shows');
  // A compaction summary newer than Engram's wins when there is no final message.
  const compacted = record({ lastMessage: null, compactSummary: { text: 'Compacted.', at: '2026-10-28T12:00:00.000Z' } });
  assert.equal(overview([engramSummary('2026-10-28 11:00:00')], compacted).leftOff.summary?.from, 'compactSummary');
});

test('the newer of the final message and the compaction summary is the text shown; a tie keeps the final message', () => {
  const both = (lastAt: string, compactAt: string) =>
    record({ lastMessage: { text: 'The final answer.', at: lastAt }, compactSummary: { text: '## Next Steps\n- from the compaction', at: compactAt } });
  // A compaction after the final message wins, and is judged against Engram by its own time.
  const later = overview([engramSummary('2026-10-28 11:00:00')], both('2026-10-28T10:00:00.000Z', '2026-10-28T12:00:00.000Z'));
  assert.deepEqual(later.leftOff.summary, { at: '2026-10-28 12:00:00', goal: null, accomplished: null, nextSteps: '- from the compaction', source: 'claude-code', from: 'compactSummary', lastUserMessage: 'fix the tests' });
  // A final message after the compaction wins.
  const answered = overview([], both('2026-10-28T12:00:00.000Z', '2026-10-28T10:00:00.000Z'));
  assert.deepEqual(answered.leftOff.summary, { at: '2026-10-28 12:00:00', goal: null, accomplished: null, nextSteps: null, excerpt: 'The final answer.', source: 'claude-code', from: 'lastMessage', lastUserMessage: 'fix the tests' });
  // The same instant: the final message.
  assert.equal(overview([], both('2026-10-28T12:00:00.000Z', '2026-10-28T12:00:00.000Z')).leftOff.summary?.from, 'lastMessage');
  // An older compaction than Engram's summary loses even though it is the newer of the two texts.
  const stale = overview([engramSummary('2026-10-28 13:00:00')], both('2026-10-28T10:00:00.000Z', '2026-10-28T12:00:00.000Z'));
  assert.equal(stale.leftOff.summary?.goal, 'From Engram');
});

test('the layout reads the user\'s message first, and the foot names the source in both languages', () => {
  const summary = { at: '2026-10-28 12:00:00', goal: null, accomplished: null, nextSteps: '- ship it', source: 'claude-code', from: 'lastMessage', lastUserMessage: 'fix the tests' };
  const layout = leftOffLayout({ lastAt: summary.at, lastDay: '2026-10-28', hasMemory: false, leftOff: { summary, memory: null } });
  assert.deepEqual(layout.read, ['ask']);
  assert.deepEqual(layout.folds.map((fold: any) => fold.id), ['next']);
  assert.equal(sourceKey(summary), 'overview.fromClaudeMessage');
  assert.equal(sourceKey({ ...summary, from: 'compactSummary' }), 'overview.fromClaudeCompact');
  assert.equal(sourceKey({ ...summary, from: 'lastUserMessage' }), 'overview.fromClaudePrompt');
  assert.equal(sourceKey({ at: summary.at, goal: 'g' }), 'overview.fromSummary', 'PRESERVE: Engram\'s summary keeps its key');
  for (const key of ['overview.fromClaudeMessage', 'overview.fromClaudeCompact', 'overview.fromClaudePrompt', 'overview.lastUserMessage', 'overview.fromSummary']) {
    for (const language of ['en', 'es']) assert.equal(typeof MESSAGES[language][key], 'string', `${language} ${key}`);
  }
  assert.equal(translate('en', 'overview.fromClaudeMessage', { when: 'today · 18:04' }), "From Claude Code's last message · today · 18:04");
  assert.equal(translate('es', 'overview.fromClaudeMessage', { when: 'hoy · 18:04' }), 'Del último mensaje de Claude Code · hoy · 18:04');
  assert.match(translate('en', 'overview.fromSummary', { when: 'x' }), /Engram/, 'Engram\'s summary names Engram');
});

type Node = { tag: string; attrs: Record<string, unknown>; children: Array<Node | string> };
const el = (tag: string, attrs: Record<string, unknown> = {}, ...children: unknown[]): Node => ({
  tag,
  attrs,
  children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) as Array<Node | string>,
});
const text = (node: Node | string | null): string => (node === null ? '' : typeof node === 'string' ? node : node.children.map(text).join(' ').replace(/ {2,}/g, ' '));
const pres = (node: Node | string): Node[] => (typeof node === 'string' ? [] : [...(node.tag === 'pre' ? [node] : []), ...node.children.flatMap(pres)]);

test('plain mode shows the record above git, as text, with its source; one API call as before', async () => {
  const answer = {
    cwd: '/work/dev/app',
    git: { available: false, reason: 'not_repo' },
    notes: null,
    leftOff: { source: 'claude-code', from: 'lastMessage', at: '2026-11-12T10:00:00.000Z', text: 'Done <b>x</b>', lastUserMessage: 'fix <script>' },
  };
  for (const language of ['en', 'es']) {
    const calls: string[] = [];
    const view = plainLeftOffView({ api: async (method: string, path: string) => (calls.push(`${method} ${path}`), answer), el, t: (key: string, vars?: Record<string, unknown>) => translate(language, key, vars), isPlain: () => true });
    const nodes = (await view.render({ selection: { ws: 'dev', rel: 'app' }, date: '2026-11-12', setHeading: () => {} })) as Node[];
    assert.deepEqual(calls, ['GET /api/folder/git?ws=dev&rel=app']);
    assert.equal(nodes[0].attrs['aria-label'], 'Claude Code', 'first, above git');
    assert.deepEqual(pres(nodes[0]).map((pre) => pre.children), [['fix <script>'], ['Done <b>x</b>']], 'what you asked, then where it got to, as text');
    assert.match(text(nodes[0]), language === 'en' ? /Your last message/ : /Tu último mensaje/);
    assert.match(text(nodes[0]), language === 'en' ? /From Claude Code's last message/ : /Del último mensaje de Claude Code/);
  }
  const { leftOff: _none, ...withoutRecord } = answer;
  const view = plainLeftOffView({ api: async () => withoutRecord, el, t: (key: string) => key, isPlain: () => true });
  const nodes = (await view.render({ selection: { ws: 'dev', rel: 'app' }, date: '2026-11-12', setHeading: () => {} })) as Node[];
  assert.equal(nodes.length, 2, 'PRESERVE: no record, git and NOTES.md only');
});

const buttons = (node: Node | string): Node[] => (typeof node === 'string' ? [] : [...(node.tag === 'button' ? [node] : []), ...node.children.flatMap(buttons)]);

test('plain mode\'s record has Forget: it asks first, then DELETE /api/folder/left-off and the view reloads', async () => {
  const answer = {
    cwd: '/work/dev/app',
    git: { available: false, reason: 'not_repo' },
    notes: null,
    leftOff: { source: 'claude-code', from: 'lastMessage', at: '2026-11-12T10:00:00.000Z', text: 'Done.', lastUserMessage: null },
  };
  for (const [language, label] of [['en', 'Forget'], ['es', 'Olvidar']]) {
    for (const sure of [true, false]) {
      const calls: string[] = [];
      const asked: Array<Record<string, unknown>> = [];
      let refreshed = 0;
      const t = (key: string, vars?: Record<string, unknown>) => translate(language, key, vars);
      const view = plainLeftOffView({
        api: async (method: string, path: string) => (calls.push(`${method} ${path}`), method === 'GET' ? answer : null),
        el,
        t,
        isPlain: () => true,
        confirm: async (options: Record<string, unknown>) => (asked.push(options), sure),
        refresh: () => refreshed++,
      });
      const nodes = (await view.render({ selection: { ws: 'dev', rel: 'a b' }, date: '2026-11-12', setHeading: () => {} })) as Node[];
      const [forget] = buttons(nodes[0]);
      assert.equal(text(forget), label, language);
      await (forget.attrs.onclick as () => Promise<void>)();
      assert.deepEqual(asked, [{ title: t('overview.forgetTitle'), message: t('overview.forgetConfirm'), confirmLabel: label, cancelLabel: t('overview.cancel'), danger: true }]);
      assert.deepEqual(calls, sure ? ['GET /api/folder/git?ws=dev&rel=a+b', 'DELETE /api/folder/left-off?ws=dev&rel=a+b'] : ['GET /api/folder/git?ws=dev&rel=a+b'], `${language} confirmed: ${sure}`);
      assert.equal(refreshed, sure ? 1 : 0);
    }
  }
  for (const key of ['overview.forget', 'overview.forgetTitle', 'overview.forgetConfirm', 'overview.forgetFailed', 'overview.cancel']) {
    for (const language of ['en', 'es']) assert.equal(typeof MESSAGES[language][key], 'string', `${language} ${key}`);
  }
  // gentle-deck's block (a browser module, read as source): Forget only on a record's summary, after confirmDialog, then the panel reloads.
  const overviewJs = readFileSync(fileURLToPath(new URL('../public/features/overview.js', import.meta.url)), 'utf8');
  assert.match(overviewJs, /summary\?\.source === 'claude-code'/);
  assert.match(overviewJs, /confirmDialog\(\{ title: t\('overview\.forgetTitle'\)/);
  assert.match(overviewJs, /api\('DELETE', `\/api\/folder\/left-off\?\$\{new URLSearchParams\(\{ ws: selection\.ws, rel: selection\.rel \}\)\}`\)/);
  assert.match(overviewJs, /panel\.refreshPanel\(\)/);
  // Without the confirm and reload it is given (an older caller), no button: never a forget without asking.
  const bare = plainLeftOffView({ api: async () => answer, el, t: (key: string) => key, isPlain: () => true });
  assert.deepEqual(buttons((await bare.render({ selection: { ws: 'dev', rel: 'app' }, date: '2026-11-12', setHeading: () => {} }))[0]), []);
});

/** The source of a top-level declaration of public/features/overview.js (a browser module Node cannot import), up to its closing line. */
function overviewDeclaration(head: string, close = '\n}\n'): string {
  const source = readFileSync(fileURLToPath(new URL('../public/features/overview.js', import.meta.url)), 'utf8');
  const start = source.indexOf(`\n${head}`);
  assert.ok(start >= 0, `${head} is missing from overview.js`);
  return source.slice(start, source.indexOf(close, start) + close.length);
}
const overviewFunction = (name: string) => overviewDeclaration(`function ${name}(`);

test('an answer with engramUnavailable shows a notice that Engram is not responding, above the rows and the block; without it, none', () => {
  for (const language of ['en', 'es']) {
    const t = (key: string, vars?: Record<string, unknown>) => translate(language, key, vars);
    // The function as overview.js has it, run with the test's el and t.
    const engramDownNotice = new Function('el', 't', `${overviewFunction('engramDownNotice')}\nreturn engramDownNotice;`)(el, t);
    const shown = engramDownNotice({ engramUnavailable: true, rows: [] }) as Node;
    assert.deepEqual(shown, el('p', { class: 'notice overview-warn', role: 'status' }, t('overview.engramDown')), 'the same notice style as overview.truncated');
    assert.match(text(shown), language === 'en' ? /^Engram is not responding, so this shows only Mirador's local records of Claude Code\.$/ : /^Engram no responde, así que esto muestra solo los registros locales de Mirador de Claude Code\.$/);
    assert.equal(engramDownNotice({ rows: [] }), null, 'no flag: no notice');
    assert.equal(engramDownNotice({ engramUnavailable: false, rows: [] }), null);
  }
  // Both views put it under the truncated notice and above what they show from the records.
  const workspace = overviewDeclaration('const workspaceView = {', '\n};\n');
  assert.match(workspace, /truncatedNotice\(data\),\s*engramDownNotice\(data\),\s*summaryCard\(data, selection\.ws\),/);
  assert.match(workspace, /data\.rows\.map\(\(row\) => rowView\(row, selection\.ws, textOptions\)\)/, 'the rows still show under it');
  assert.match(overviewDeclaration('async function leftOff('), /\[call, truncatedNotice\(folder\.value\), engramDownNotice\(folder\.value\), leftOffCard\(folder\.value, selection\)\]/);
});
