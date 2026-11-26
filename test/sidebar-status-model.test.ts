// The sidebar's state glyphs and the counts of its state filter
// (public/features/sidebar-status-model.js): derived only
// from data the window already has, the terminals, the inbox items and the sleeping agents. Nothing
// shows without an agent behind it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ICONS, STATES, folderKey, sidebarStatus, terminalState } from '../public/features/sidebar-status-model.js';

const agent = (id: string, rel: string, extra: Record<string, unknown> = {}) => ({ id, workspaceId: 'dev', rel, kind: 'agent', status: 'running', ...extra });
const shell = (id: string, rel: string) => ({ id, workspaceId: 'dev', rel, kind: 'shell', status: 'running' });
const waiting = (terminalId: string, since = '2026-11-06T10:00:00Z') => ({ terminalId, kind: 'blocked', since });
const finished = (terminalId: string) => ({ terminalId, kind: 'finished', since: '2026-11-06T10:00:00Z' });

test('S3: an agent works while it runs and the inbox says nothing, waits or is done as the inbox says', () => {
  assert.equal(terminalState(agent('a', 'x'), undefined), 'work');
  assert.equal(terminalState(agent('a', 'x'), waiting('a')), 'wait');
  assert.equal(terminalState(agent('a', 'x'), finished('a')), 'done');
});

// #12: once an agent's card leaves the inbox, the sidebar, tab and pane showed it working again while
// the server still reported error or finished. The server's agentState is the fallback for that case.
test('#12: with no card, the server\'s agentState decides instead of working', () => {
  assert.equal(terminalState(agent('a', 'x', { agentState: 'error' }), undefined), 'err');
  assert.equal(terminalState(agent('a', 'x', { agentState: 'finished' }), undefined), 'done');
  assert.equal(terminalState(agent('a', 'x', { agentState: 'waiting' }), undefined), 'wait');
  assert.equal(terminalState(agent('a', 'x', { agentState: 'working' }), undefined), 'work');
  // unknown, absent or an older server: working, exactly as before.
  assert.equal(terminalState(agent('a', 'x', { agentState: 'unknown' }), undefined), 'work');
  assert.equal(terminalState(agent('a', 'x'), undefined), 'work');
  // A card still wins: it is the fresher word on what the agent needs.
  assert.equal(terminalState(agent('a', 'x', { agentState: 'error' }), waiting('a')), 'wait');
});

test('S3: an ended agent is an error only when it did not end cleanly; a shell has no state', () => {
  assert.equal(terminalState(agent('a', 'x', { status: 'exited', exitCode: 1 }), undefined), 'err');
  assert.equal(terminalState(agent('a', 'x', { status: 'exited', exitCode: 0, oomKilled: true }), undefined), 'err');
  assert.equal(terminalState(agent('a', 'x', { status: 'exited', exitSignal: 'SIGKILL' }), undefined), 'err');
  assert.equal(terminalState(agent('a', 'x', { status: 'exited', exitCode: 0 }), finished('a')), null, 'a clean exit shows nothing');
  assert.equal(terminalState(shell('s', 'x') as never, waiting('s')), null);
});

// A running agent whose program stopped with an error (an
// OSC 7501 error card) shows the error glyph, as an agent that did not end cleanly does.
test('F2: a running agent with an error card is an error, counted once, and a folder with a waiting agent still shows waiting', () => {
  const error = (terminalId: string) => ({ terminalId, kind: 'error', label: 'Error', detail: 'Build failed', since: '2026-11-06T10:00:00Z' });
  assert.equal(terminalState(agent('e', 'x'), error('e')), 'err');
  const status = sidebarStatus({ terminals: [agent('e', 'x'), agent('q', 'x'), agent('f', 'y')], items: [error('e'), waiting('q'), error('f')] });
  assert.deepEqual(status.counts, { work: 0, wait: 1, done: 0, sleep: 0, err: 2 });
  assert.equal(status.folders.get(folderKey('dev', 'x')), 'wait', 'waiting stays the most urgent');
  assert.equal(status.folders.get(folderKey('dev', 'y')), 'err');
});

const none = { work: 0, wait: 0, done: 0, sleep: 0, err: 0 };

test('S3: no terminals, no inbox and no sleeping agents give no glyph and no count', () => {
  const status = sidebarStatus({ terminals: [], items: [], sleeping: [] });
  assert.equal(status.folders.size, 0);
  assert.deepEqual(status.agents, []);
  assert.deepEqual(status.counts, none);
  assert.deepEqual(sidebarStatus({}).counts, none, 'missing sources count as empty');
});

test('S3: a folder shows the glyph of its most urgent agent: waiting, error, done, working, then sleeping', () => {
  const status = sidebarStatus({
    terminals: [agent('w1', 'web/a'), agent('w2', 'web/a'), agent('d1', 'web/b'), agent('e1', 'web/b', { status: 'exited', exitCode: 2 }), agent('k1', 'web/c'), shell('s1', 'web/d')],
    items: [waiting('w2'), finished('d1')],
    sleeping: [{ id: 'z1', workspaceId: 'dev', rel: 'web/c' }, { id: 'z2', workspaceId: 'dev', rel: 'web/e' }],
  });
  assert.equal(status.folders.get(folderKey('dev', 'web/a')), 'wait');
  assert.equal(status.folders.get(folderKey('dev', 'web/b')), 'err');
  assert.equal(status.folders.get(folderKey('dev', 'web/c')), 'work');
  assert.equal(status.folders.get(folderKey('dev', 'web/d')), undefined, 'a shell gives no glyph');
  assert.equal(status.folders.get(folderKey('dev', 'web/e')), 'sleep');
  assert.equal(status.folders.get(folderKey('other', 'web/a')), undefined, 'folders are per workspace');
});

test('S3: the counts are agents, not folders, per state in filter order', () => {
  const status = sidebarStatus({
    terminals: [agent('a', 'x'), agent('b', 'x'), agent('c', 'y'), agent('e', 'y', { status: 'exited', exitCode: 1 })],
    items: [waiting('c')],
    sleeping: [{ id: 'z', workspaceId: 'dev', rel: 'q' }, { id: 'z2', workspaceId: 'dev', rel: 'q' }],
  });
  assert.deepEqual(STATES, ['work', 'wait', 'done', 'sleep', 'err']);
  assert.deepEqual(status.counts, { work: 2, wait: 1, done: 0, sleep: 2, err: 1 });
  assert.deepEqual(ICONS, { work: 'work', wait: 'wait', done: 'check', sleep: 'sleep', err: 'error' });
});

test('S3 (state filter): the agents list each agent with a state once, and the glyphs and counts stay as before', () => {
  const status = sidebarStatus({
    terminals: [agent('w1', 'web/a'), agent('w2', 'web/a'), shell('s1', 'web/d'), agent('r1', '', { rel: undefined })],
    items: [waiting('w2')],
    sleeping: [{ id: 'z1', workspaceId: 'dev', rel: 'web/e' }],
  });
  assert.deepEqual(status.agents, [
    { workspaceId: 'dev', rel: 'web/a', state: 'work' },
    { workspaceId: 'dev', rel: 'web/a', state: 'wait' },
    { workspaceId: 'dev', rel: '', state: 'work' },
    { workspaceId: 'dev', rel: 'web/e', state: 'sleep' },
  ]);
  assert.deepEqual([...status.folders], [[folderKey('dev', 'web/a'), 'wait'], [folderKey('dev', ''), 'work'], [folderKey('dev', 'web/e'), 'sleep']]);
  assert.deepEqual(status.counts, { work: 2, wait: 1, done: 0, sleep: 1, err: 0 });
});

test('S3: inbox items of terminals this window does not show are ignored', () => {
  const status = sidebarStatus({ terminals: [agent('a', 'x')], items: [waiting('ghost')], sleeping: [] });
  assert.deepEqual(status.counts, { ...none, work: 1 });
});

// The TerminalInfo loaded with the page used to carry the only agentState there was, and it went
// stale, so the sidebar read only the inbox. Since #12 the stream refreshes the states
// (public/terminals.js merges inboxAgentStates into terminalList), and an agent whose card left the
// inbox keeps showing finished or in error instead of flipping back to working.
test('#12: the agentState a terminal carries is read when no card says otherwise', () => {
  assert.equal(terminalState(agent('a', 'x', { agentState: 'error' }), undefined), 'err');
  assert.equal(terminalState(agent('a', 'x', { agentState: 'finished' }), undefined), 'done');
  assert.deepEqual(sidebarStatus({ terminals: [agent('a', 'x', { agentState: 'error' })] }).counts, { work: 0, wait: 0, done: 0, sleep: 0, err: 1 });
});
