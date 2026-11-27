// How agy (Antigravity CLI) starts and resumes, and what bin/agy-hook
// sends. agy reads hooks from the `.agents/hooks.json` of each workspace folder, and `--add-dir` adds one
// per launch, so Mirador writes its hooks into a folder of its own and starts agy with `--add-dir <folder>`
// as the configured agent and as a chosen one. It resumes with `--conversation <id>` only for a SESSION_ID,
// and Pi's, claude's and opencode's forms stay exactly as they were.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, agentLaunch } from '../src/agents/catalog.ts';
import { bridgeArgs, bridgeEnvProvider, resumeArgs } from '../src/attention/agent-args.ts';
import { prepareAgyHooks } from '../src/attention/agy-hooks.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn, type TerminalRequest } from '../src/terminals/registry.ts';

const HOOK = fileURLToPath(new URL('../bin/agy-hook', import.meta.url));
const SETTINGS = '/run/mirador/herdr/claude-settings.json';
const CONTENT = '{"plugins":["/run/mirador/herdr/opencode-plugin"]}';
const FOLDER = '/run/mirador/herdr/agy-workspace';
const BRIDGES = { pi: '/app/bridge.ts', 'claude-code': SETTINGS, opencode: CONTENT, antigravity: FOLDER };
const ID = 'ec33ebf9-0cba-4100-8142-c61503f6c587';
/** A working report expires after 10 minutes without a hook (#3); finished and waiting never do. */
const WORKING_TTL_MS = 600_000;

const pty: PtyProcess = { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
/** The command line and the OPENCODE_CONFIG_CONTENT of a terminal, with the bridges as inbox.ts adds them. */
function launch(agentCommand: string, request: Partial<TerminalRequest> = {}, enabled = true): { line?: string; content?: string } {
  let env: Record<string, string> = {};
  const spawnPty: SpawnFn = (_file, _args, opts) => { env = opts.env; return pty; };
  const registry = new TerminalRegistry(spawnPty, { shell: '/bin/bash', agentCommand, agentRcFile: '/run/mirador/agent.bashrc', env: { HOME: '/h', PATH: '/usr/bin' }, scrollbackLimit: 100, scopes: false });
  registry.addAgentArgs(bridgeArgs(agentCommand, BRIDGES, enabled));
  registry.addEnvProvider(bridgeEnvProvider(agentCommand, BRIDGES, enabled));
  registry.addChosenAgentArgs('claude-code', bridgeArgs('claude', BRIDGES, enabled));
  registry.addChosenAgentArgs('opencode', bridgeArgs('opencode', BRIDGES, enabled));
  registry.addChosenAgentArgs('antigravity', bridgeArgs('agy', BRIDGES, enabled));
  registry.create({ cwd: '/w/alpha', kind: 'agent', cols: 90, rows: 33, workspaceId: 'dev', rel: 'alpha', ...request });
  return { line: env.MIRADOR_AGENT_COMMAND, content: env.OPENCODE_CONFIG_CONTENT };
}
const line = (agentCommand: string, request: Partial<TerminalRequest> = {}, enabled = true) => launch(agentCommand, request, enabled).line;
const restore = (agentCommand: string, key: string, agent?: string) => {
  const chosen = agent ? agentLaunch(agent, agentCommand) : null;
  return line(agentCommand, { agentArgs: resumeArgs(chosen?.agentCommand || agentCommand, key), ...(chosen ?? {}) });
};

test('agy has hooks attention and a verified --conversation <id> that takes only a SESSION_ID', () => {
  const agy = AGENTS.find((agent) => agent.id === 'antigravity');
  assert.equal(agy?.attention, 'hooks');
  assert.deepEqual(agy?.resume, ['--conversation', '{session}']);
  assert.equal(agy?.resumeKey, 'id');
  assert.equal(agy?.bridgeFlag, '--add-dir');
  assert.equal(agy?.bridgeEnv, undefined);
  assert.deepEqual(resumeArgs('agy', ID), ['--conversation', ID]);
  assert.deepEqual(resumeArgs('agy --model gemini-3.6-flash', ID), ['--conversation', ID]);
  for (const key of ['/s/old.jsonl', '-c', '--continue', '--help', '', 'a b', 'x;rm', 'é']) assert.deepEqual(resumeArgs('agy', key), [], JSON.stringify(key));
});

test('agy starts with --add-dir <its hook folder>, configured or chosen, and resumes its conversation id', () => {
  const bridged = `agy '--add-dir' '${FOLDER}'`;
  assert.equal(line('agy'), bridged);
  assert.equal(line('agy', { agent: 'antigravity' }), bridged);
  assert.equal(line('agy --model gemini-3.6-flash'), `agy --model gemini-3.6-flash '--add-dir' '${FOLDER}'`);
  assert.equal(line('gentle-shell', agentLaunch('antigravity', 'gentle-shell')!), bridged);
  assert.equal(restore('agy', ID), `${bridged} '--conversation' '${ID}'`);
  assert.equal(restore('gentle-shell', ID, 'antigravity'), `${bridged} '--conversation' '${ID}'`);
  assert.equal(restore('gentle-shell', '/s/old.jsonl', 'antigravity'), bridged, 'a pi session file is no agy id');
  assert.equal(restore('gentle-shell', '--help', 'antigravity'), bridged, 'an id that reads as an option is never passed');
  // No environment rides with it.
  assert.equal(launch('agy').content, undefined);
  // attentionBridge: false starts agy exactly as configured, with no hook folder; a resume stays.
  assert.equal(line('agy', {}, false), 'agy');
  assert.equal(line('gentle-shell', agentLaunch('antigravity', 'gentle-shell')!, false), 'agy');
  assert.deepEqual(bridgeArgs('agy', BRIDGES, false), []);
  // A command Mirador cannot add words to gets no folder, and a lone bridge path is the gentle-shell one.
  assert.equal(line('agy; echo done'), 'agy; echo done');
  assert.deepEqual(bridgeArgs('agy', '/app/bridge.ts'), []);
});

test('pi, claude and opencode keep their forms beside agy, and only agy terminals get --add-dir', () => {
  assert.equal(line('gentle-shell'), "gentle-shell '-e' '/app/bridge.ts'");
  assert.equal(line('pi --thinking high'), "pi --thinking high '-e' '/app/bridge.ts'");
  assert.equal(restore('gentle-shell', '/s/old.jsonl'), "gentle-shell '-e' '/app/bridge.ts' '--session' '/s/old.jsonl'");
  assert.equal(restore('gentle-shell', ID), "gentle-shell '-e' '/app/bridge.ts'", 'an id never resumes pi');
  assert.equal(restore('agy', '/s/old.jsonl', 'pi'), "gentle-shell '--session' '/s/old.jsonl'");
  assert.equal(line('claude'), `claude '--settings' '${SETTINGS}'`);
  assert.equal(restore('agy', ID, 'claude-code'), `claude '--settings' '${SETTINGS}' '--resume' '${ID}'`);
  assert.deepEqual(launch('opencode'), { line: "opencode '--standalone'", content: CONTENT });
  assert.deepEqual(launch('agy', agentLaunch('opencode', 'agy')!), { line: "opencode '--standalone'", content: CONTENT });
  assert.equal(line('my-agent --x'), 'my-agent --x');
  assert.equal(line('agy', { kind: 'shell' }), undefined);
});

test('prepareAgyHooks writes only <dir>/agy-workspace/.agents/hooks.json (0700/0600), whose hooks run bin/agy-hook per event', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mirador-agy-hooks-'));
  try {
    const folder = await prepareAgyHooks(dir, '/app/bin/agy-hook', '/opt/node/bin/node');
    assert.equal(folder, join(dir, 'agy-workspace'));
    assert.deepEqual(await readdir(dir), ['agy-workspace']);
    assert.deepEqual(await readdir(folder), ['.agents']);
    assert.deepEqual(await readdir(join(folder, '.agents')), ['hooks.json']);
    for (const sub of ['', '.agents']) assert.equal((await stat(join(folder, sub))).mode & 0o777, 0o700, `folder ${sub}`);
    const file = join(folder, '.agents', 'hooks.json');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const run = (event: string) => ({ type: 'command', command: `'/opt/node/bin/node' '/app/bin/agy-hook' ${event}`, timeout: 5 });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
      'mirador-attention': {
        PreInvocation: [run('PreInvocation')],
        // PreToolUse answers {"decision":"allow"}: only the tools that wait for an answer, never every tool.
        PreToolUse: [{ matcher: 'ask_question|ask_permission', hooks: [run('PreToolUse')] }],
        PostToolUse: [{ matcher: '', hooks: [run('PostToolUse')] }],
        PostInvocation: [run('PostInvocation')],
        Stop: [run('Stop')],
      },
    });
    // Preparing again (a restart) rewrites the same file.
    const before = await readFile(file, 'utf8');
    assert.equal(await prepareAgyHooks(dir, '/app/bin/agy-hook', '/opt/node/bin/node'), folder);
    assert.equal(await readFile(file, 'utf8'), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Runs bin/agy-hook for `event` with `stdin` and the herdr variables of pane `pane`; resolves with what it printed and sent. */
async function hook(event: string, stdin: string, pane = 'pane-1'): Promise<{ code: number | null; out: string; err: string; lines: Array<Record<string, unknown>> }> {
  const dir = await mkdtemp(join(tmpdir(), 'mirador-agy-hook-'));
  const socketPath = join(dir, 'socket');
  const lines: Array<Record<string, unknown>> = [];
  const listener = createServer((conn) => {
    let buffered = '';
    conn.on('data', (chunk) => (buffered += chunk));
    conn.on('end', () => lines.push(...buffered.split('\n').filter(Boolean).map((text) => JSON.parse(text))));
  });
  await new Promise<void>((resolve) => listener.listen(socketPath, resolve));
  try {
    const child = spawn(process.execPath, [HOOK, ...(event ? [event] : [])], { env: { HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: pane, PATH: '/usr/bin' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.stdin.end(stdin);
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { code, out, err, lines };
  } finally {
    listener.close();
    await rm(dir, { recursive: true, force: true });
  }
}
/** A payload shaped like https://antigravity.google/docs/hooks (common fields first). */
const payload = (fields: object = {}) => JSON.stringify({
  conversationId: ID,
  workspacePaths: ['/w/alpha', FOLDER],
  transcriptPath: `/h/.gemini/antigravity-cli/brain/${ID}/.system_generated/logs/transcript.jsonl`,
  artifactDirectoryPath: `/h/.gemini/antigravity-cli/brain/${ID}`,
  modelName: 'gemini-3.6-flash-medium',
  ...fields,
});
const NONE = '{}';
const ALLOW = '{"decision":"allow"}';
// Stop requires `decision`; anything but "continue" lets agy stop (https://antigravity.google/docs/hooks).
const STOP = '{"decision":"stop"}';

test('bin/agy-hook maps PreInvocation, a question or permission tool and Stop to one mirador:attention line each', async () => {
  const working = await hook('PreInvocation', payload({ invocationNum: 0, initialNumSteps: 1, lastUserInput: 'Fix the failing unit test' }));
  assert.deepEqual([working.code, working.out, working.err], [0, NONE, '']);
  assert.equal(working.lines.length, 1);
  const [first] = working.lines;
  assert.deepEqual({ ...first, seq: 0 }, { v: 1, cmd: 'report-metadata', pane: 'pane-1', source: 'mirador:attention', seq: 0, ttlMs: WORKING_TTL_MS, tokens: { session: ID }, clear: ['blocked', 'prompt', 'finished'] });
  assert.ok(Math.abs((first.seq as number) - Date.now()) < 10_000, 'seq is the clock');

  const question = await hook('PreToolUse', payload({ stepIdx: 4, toolCall: { name: 'ask_question', args: { questions: [{ question: 'Which  database\nshould I use?', options: ['sqlite', 'postgres'], is_multi_select: false }] } } }));
  assert.deepEqual([question.code, question.out, question.err], [0, ALLOW, ''], 'PreToolUse defers to the next hook or the default policy');
  assert.deepEqual([question.lines[0].tokens, question.lines[0].clear, question.lines[0].ttlMs], [{ session: ID, prompt: 'Which database should I use?' }, ['blocked', 'finished'], null]);

  const permission = await hook('PreToolUse', payload({ stepIdx: 5, toolCall: { name: 'ask_permission', args: { Action: 'write', Target: '/etc/hosts', Reason: 'Add the staging host' } } }));
  assert.deepEqual([permission.out, permission.lines[0].tokens], [ALLOW, { session: ID, prompt: 'Add the staging host' }]);
  const bare = await hook('PreToolUse', payload({ toolCall: { name: 'ask_permission', args: {} } }));
  assert.deepEqual(bare.lines[0].tokens, { session: ID, prompt: 'Antigravity needs your input' });

  const finished = await hook('Stop', payload({ executionNum: 1, terminationReason: 'model_stop', error: '', fullyIdle: true }));
  assert.deepEqual([finished.code, finished.out, finished.err], [0, STOP, '']);
  assert.deepEqual(Object.keys(finished.lines[0].tokens as object).sort(), ['finished', 'session']);
  assert.match((finished.lines[0].tokens as { finished: string }).finished, /^\d+$/);
  assert.deepEqual([finished.lines[0].clear, finished.lines[0].ttlMs], [['blocked', 'prompt'], null]);
});

test('bin/agy-hook refreshes the working report on every other tool and model-call event', async () => {
  const tool = { toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } } };
  for (const [event, fields, answer] of [['PreToolUse', tool, ALLOW], ['PostToolUse', tool, NONE], ['PostToolUse', { toolCall: { name: 'ask_question', args: {} } }, NONE], ['PostInvocation', { invocationNum: 0 }, NONE]] as const) {
    const result = await hook(event, payload(fields));
    assert.deepEqual([result.code, result.out, result.err, result.lines.length], [0, answer, '', 1], event);
    const [line] = result.lines;
    assert.deepEqual([line.cmd, line.source, line.ttlMs, line.tokens, line.clear], ['report-metadata', 'mirador:attention', WORKING_TTL_MS, { session: ID }, ['blocked', 'prompt', 'finished']], event);
  }
});

test('bin/agy-hook sends nothing for unknown events or bad input, always answers JSON and exits 0', async () => {
  // SessionStart is not hooked: a stray call still reports nothing, so an agent that has not started a turn never reads as working.
  for (const [event, input] of [['SessionStart', payload()], ['', payload()], ['PreToolUse', 'not json'], ['PostToolUse', '[]'], ['Stop', 'not json'], ['Stop', '[]'], ['Stop', '']]) {
    const result = await hook(event, input);
    assert.deepEqual([result.code, result.out, result.err, result.lines], [0, event === 'Stop' ? STOP : event === 'PreToolUse' ? ALLOW : NONE, '', []], `${event} ${input}`);
  }
  // A conversation id that could be read as an option is left out; the state still goes.
  const odd = (await hook('Stop', payload({ conversationId: '--help', fullyIdle: true }))).lines[0];
  assert.equal('session' in (odd.tokens as object), false);
  assert.ok('finished' in (odd.tokens as object));
  const outside = await hook('Stop', payload(), '');
  assert.deepEqual([outside.code, outside.out, outside.lines], [0, STOP, []], 'outside a Mirador agent terminal');
});
