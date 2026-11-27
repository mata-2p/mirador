// How claude starts and resumes, and what bin/claude-hook sends.
// claude gets `--settings <file>` as the configured agent and as a chosen one, `--resume <id>` only for
// a session id its hooks reported, and Pi's forms stay exactly as they were.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, agentLaunch } from '../src/agents/catalog.ts';
import { bridgeArgs, resumeArgs } from '../src/attention/agent-args.ts';
import { prepareClaudeSettings } from '../src/attention/claude-hooks.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn, type TerminalRequest } from '../src/terminals/registry.ts';

const HOOK = fileURLToPath(new URL('../bin/claude-hook', import.meta.url));
/** A working report expires after 10 minutes without a hook (#3); finished and waiting never do. */
const WORKING_TTL_MS = 600_000;
const SETTINGS = '/run/mirador/herdr/claude-settings.json';
const BRIDGES = { pi: '/app/bridge.ts', 'claude-code': SETTINGS };
const ID = '0f8e2a4c-1b7d-4e5f-9a6b-3c2d1e0f9a8b';

const pty: PtyProcess = { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
/** The command line an agent terminal runs, with the bridges as inbox.ts adds them. */
function launchLine(agentCommand: string, request: Partial<TerminalRequest> = {}): string | undefined {
  let env: Record<string, string> = {};
  const spawnPty: SpawnFn = (_file, _args, opts) => { env = opts.env; return pty; };
  const registry = new TerminalRegistry(spawnPty, { shell: '/bin/bash', agentCommand, agentRcFile: '/run/mirador/agent.bashrc', env: { HOME: '/h', PATH: '/usr/bin' }, scrollbackLimit: 100, scopes: false });
  registry.addAgentArgs(bridgeArgs(agentCommand, BRIDGES));
  registry.addChosenAgentArgs('claude-code', bridgeArgs('claude', BRIDGES));
  registry.create({ cwd: '/w/alpha', kind: 'agent', cols: 90, rows: 33, workspaceId: 'dev', rel: 'alpha', ...request });
  return env.MIRADOR_AGENT_COMMAND;
}
const restoreLine = (agentCommand: string, key: string, agent?: string) => {
  const launch = agent ? agentLaunch(agent, agentCommand) : null;
  return launchLine(agentCommand, { agentArgs: resumeArgs(launch?.agentCommand || agentCommand, key), ...(launch ?? {}) });
};

test('claude-code has hooks attention and a verified --resume <session id>', () => {
  const claude = AGENTS.find((agent) => agent.id === 'claude-code');
  assert.equal(claude?.attention, 'hooks');
  assert.deepEqual(claude?.resume, ['--resume', '{session}']);
  assert.deepEqual(resumeArgs('claude', ID), ['--resume', ID]);
  assert.deepEqual(resumeArgs('claude --verbose', 'abc_123'), ['--resume', 'abc_123']);
  for (const key of ['/s/old.jsonl', '-p', '--help', '', 'a b', 'x;rm', 'é']) assert.deepEqual(resumeArgs('claude', key), [], JSON.stringify(key));
});

test('claude starts with --settings as the configured agent and as a chosen one, and resumes its id', () => {
  assert.equal(launchLine('claude'), `claude '--settings' '${SETTINGS}'`);
  assert.equal(launchLine('claude --verbose'), `claude --verbose '--settings' '${SETTINGS}'`);
  assert.equal(restoreLine('claude', ID), `claude '--settings' '${SETTINGS}' '--resume' '${ID}'`);
  assert.equal(restoreLine('claude', ID, 'claude-code'), `claude '--settings' '${SETTINGS}' '--resume' '${ID}'`);
  assert.equal(launchLine('gentle-shell', agentLaunch('claude-code', 'gentle-shell')!), `claude '--settings' '${SETTINGS}'`);
  assert.equal(restoreLine('gentle-shell', ID, 'claude-code'), `claude '--settings' '${SETTINGS}' '--resume' '${ID}'`);
  assert.equal(restoreLine('gentle-shell', '/s/old.jsonl', 'claude-code'), `claude '--settings' '${SETTINGS}'`, 'a pi session file is no claude id');
  // attentionBridge: false drops the hooks, never the resume.
  assert.deepEqual(bridgeArgs('claude', BRIDGES, false), []);
});

test('pi keeps its bridge and --session resume beside claude, and a lone bridge path is still the gentle-shell one', () => {
  assert.equal(launchLine('gentle-shell'), "gentle-shell '-e' '/app/bridge.ts'");
  assert.equal(restoreLine('gentle-shell', '/s/old.jsonl'), "gentle-shell '-e' '/app/bridge.ts' '--session' '/s/old.jsonl'");
  assert.equal(restoreLine('claude', '/s/old.jsonl', 'pi'), "gentle-shell '--session' '/s/old.jsonl'");
  assert.deepEqual(bridgeArgs('claude', '/app/bridge.ts'), []);
  assert.deepEqual(bridgeArgs('gentle-shell', '/app/bridge.ts'), ['-e', '/app/bridge.ts']);
});

/** Runs bin/claude-hook with `stdin` and the herdr variables of pane `pane`; resolves with the lines it sent. */
async function hook(stdin: string, pane = 'pane-1'): Promise<{ code: number | null; out: string; lines: Array<Record<string, unknown>> }> {
  const dir = await mkdtemp(join(tmpdir(), 'mirador-claude-hook-'));
  const socketPath = join(dir, 'socket');
  const lines: Array<Record<string, unknown>> = [];
  const listener = createServer((conn) => {
    let buffered = '';
    conn.on('data', (chunk) => (buffered += chunk));
    conn.on('end', () => lines.push(...buffered.split('\n').filter(Boolean).map((line) => JSON.parse(line))));
  });
  await new Promise<void>((resolve) => listener.listen(socketPath, resolve));
  try {
    const child = spawn(process.execPath, [HOOK], { env: { HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: pane, PATH: '/usr/bin' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.stdin.end(stdin);
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { code, out, lines };
  } finally {
    listener.close();
    await rm(dir, { recursive: true, force: true });
  }
}
const payload = (event: string, fields: object = {}) => JSON.stringify({ session_id: ID, transcript_path: `/h/.claude/projects/x/${ID}.jsonl`, cwd: '/w/alpha', hook_event_name: event, ...fields });

test('bin/claude-hook reports each event as one mirador:attention line with the session id, silently', async () => {
  const working = await hook(payload('UserPromptSubmit', { prompt: 'go' }));
  assert.equal(working.code, 0);
  assert.equal(working.out, '');
  // One attention line; the prompt itself follows it as a left-off line (test/left-off-view.test.ts).
  assert.deepEqual(working.lines.map((sent) => sent.cmd), ['report-metadata', 'left-off']);
  const [line] = working.lines;
  assert.deepEqual({ ...line, seq: 0 }, { v: 1, cmd: 'report-metadata', pane: 'pane-1', source: 'mirador:attention', seq: 0, ttlMs: WORKING_TTL_MS, tokens: { session: ID }, clear: ['blocked', 'prompt', 'finished'] });
  assert.ok(Math.abs((line.seq as number) - Date.now()) < 10_000, 'seq is the clock');

  const waiting = (await hook(payload('Notification', { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' }))).lines[0];
  assert.deepEqual([waiting.tokens, waiting.clear, waiting.ttlMs], [{ session: ID, prompt: 'Claude needs your permission to use Bash' }, ['blocked', 'finished'], null]);

  const finished = (await hook(payload('Stop', { stop_hook_active: false }))).lines[0];
  assert.deepEqual(Object.keys(finished.tokens as object).sort(), ['finished', 'session']);
  assert.match((finished.tokens as { finished: string }).finished, /^\d+$/);
  assert.deepEqual([finished.clear, finished.ttlMs], [['blocked', 'prompt'], null]);

  // Every tool event refreshes the working report, before and after the tool runs.
  for (const event of ['PreToolUse', 'PostToolUse']) {
    const result = await hook(payload(event, { tool_name: 'Bash', tool_input: { command: 'npm test' } }));
    assert.deepEqual([result.code, result.out, result.lines.length], [0, '', 1], event);
    const [activity] = result.lines;
    assert.deepEqual([activity.cmd, activity.tokens, activity.clear, activity.ttlMs], ['report-metadata', { session: ID }, ['blocked', 'prompt', 'finished'], WORKING_TTL_MS], event);
  }
});

test('prepareClaudeSettings registers PreToolUse beside the events it ran before', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mirador-claude-settings-'));
  try {
    const settings = JSON.parse(await readFile(await prepareClaudeSettings(dir, '/app/bin/claude-hook', '/opt/node/bin/node'), 'utf8'));
    assert.deepEqual(Object.keys(settings.hooks), ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'PostCompact', 'SessionEnd']);
    for (const event of Object.keys(settings.hooks)) {
      assert.deepEqual(settings.hooks[event], [{ hooks: [{ type: 'command', command: "'/opt/node/bin/node' '/app/bin/claude-hook'", timeout: 5 }] }], event);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bin/claude-hook sends nothing for an idle reminder, an unknown event or bad input, and never fails', async () => {
  for (const input of [payload('Notification', { message: 'Claude is waiting for your input', notification_type: 'idle_prompt' }), payload('SessionStart'), 'not json', '[]', '']) {
    const result = await hook(input);
    assert.deepEqual([result.code, result.out, result.lines], [0, '', []], input);
  }
  // A session id that could be read as an option is left out; the state still goes.
  const odd = (await hook(payload('Stop', { session_id: '--help' }))).lines[0];
  assert.equal('session' in (odd.tokens as object), false);
  assert.equal((await hook(payload('Stop'), '')).lines.length, 0, 'outside a Mirador agent terminal');
});
