// How opencode starts and resumes. opencode runs its plugins in its
// server, so Mirador starts it with `--standalone` (a private server that inherits the terminal's
// environment) and names its plugin in OPENCODE_CONFIG_CONTENT, in opencode agent terminals only; it
// resumes with `--session <id>` only for a SESSION_ID, and Pi's and claude's forms stay as they were.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, agentLaunch } from '../src/agents/catalog.ts';
import { bridgeArgs, bridgeEnvProvider, resumeArgs } from '../src/attention/agent-args.ts';
import { prepareOpencodePlugin } from '../src/attention/opencode-plugin.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn, type TerminalRequest } from '../src/terminals/registry.ts';

const PLUGIN = fileURLToPath(new URL('../bin/opencode-plugin.js', import.meta.url));
const SETTINGS = '/run/mirador/herdr/claude-settings.json';
const CONTENT = '{"plugins":["/run/mirador/herdr/opencode-plugin"]}';
const BRIDGES = { pi: '/app/bridge.ts', 'claude-code': SETTINGS, opencode: CONTENT };
const ID = 'ses_1a2b3c4d5e6fGhIjKlMnOpQrSt';

const pty: PtyProcess = { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
/** The command line and the OPENCODE_CONFIG_CONTENT of a terminal, with the bridges as inbox.ts adds them. */
function launch(agentCommand: string, request: Partial<TerminalRequest> = {}, enabled = true): { line?: string; content?: string } {
  let env: Record<string, string> = {};
  const spawnPty: SpawnFn = (_file, _args, opts) => { env = opts.env; return pty; };
  const registry = new TerminalRegistry(spawnPty, { shell: '/bin/bash', agentCommand, agentRcFile: '/run/mirador/agent.bashrc', env: { HOME: '/h', PATH: '/usr/bin' }, scrollbackLimit: 100, scopes: false });
  registry.addEnvProvider(bridgeEnvProvider(agentCommand, BRIDGES, enabled));
  registry.addAgentArgs(bridgeArgs(agentCommand, BRIDGES, enabled));
  registry.addChosenAgentArgs('claude-code', bridgeArgs('claude', BRIDGES, enabled));
  registry.addChosenAgentArgs('opencode', bridgeArgs('opencode', BRIDGES, enabled));
  registry.create({ cwd: '/w/alpha', kind: 'agent', cols: 90, rows: 33, workspaceId: 'dev', rel: 'alpha', ...request });
  return { line: env.MIRADOR_AGENT_COMMAND, content: env.OPENCODE_CONFIG_CONTENT };
}
const restore = (agentCommand: string, key: string, agent?: string) => {
  const chosen = agent ? agentLaunch(agent, agentCommand) : null;
  return launch(agentCommand, { agentArgs: resumeArgs(chosen?.agentCommand || agentCommand, key), ...(chosen ?? {}) });
};

test('opencode has hooks attention and a verified --session <id> that takes only a SESSION_ID', () => {
  const opencode = AGENTS.find((agent) => agent.id === 'opencode');
  assert.equal(opencode?.attention, 'hooks');
  assert.deepEqual(opencode?.resume, ['--session', '{session}']);
  assert.equal(opencode?.resumeKey, 'id');
  assert.deepEqual(resumeArgs('opencode', ID), ['--session', ID]);
  assert.deepEqual(resumeArgs('opencode --model x/y', ID), ['--session', ID]);
  for (const key of ['/s/old.jsonl', '-c', '--help', '', 'a b', 'x;rm', 'é']) assert.deepEqual(resumeArgs('opencode', key), [], JSON.stringify(key));
});

test('opencode starts with --standalone and its plugin in OPENCODE_CONFIG_CONTENT, configured or chosen, and resumes its id', () => {
  const plugin = { line: "opencode '--standalone'", content: CONTENT };
  assert.deepEqual(launch('opencode'), plugin);
  assert.deepEqual(launch('opencode', { agent: 'opencode' }), plugin);
  assert.deepEqual(launch('opencode --model x/y'), { line: "opencode --model x/y '--standalone'", content: CONTENT });
  assert.deepEqual(launch('gentle-shell', agentLaunch('opencode', 'gentle-shell')!), plugin);
  assert.deepEqual(restore('opencode', ID), { line: `opencode '--standalone' '--session' '${ID}'`, content: CONTENT });
  assert.deepEqual(restore('gentle-shell', ID, 'opencode'), { line: `opencode '--standalone' '--session' '${ID}'`, content: CONTENT });
  assert.deepEqual(restore('gentle-shell', '/s/old.jsonl', 'opencode'), plugin, 'a pi session file is no opencode id');
  // attentionBridge: false starts opencode exactly as configured, with no plugin; a resume stays.
  assert.deepEqual(launch('opencode', {}, false), { line: 'opencode', content: undefined });
  assert.deepEqual(bridgeArgs('opencode', BRIDGES, false), []);
  // A command Mirador cannot add words to gets neither the flag nor the plugin.
  assert.deepEqual(launch('opencode; echo done'), { line: 'opencode; echo done', content: undefined });
});

test('only opencode agent terminals carry the plugin: pi, claude, other commands and shells keep their own forms', () => {
  assert.deepEqual(launch('gentle-shell'), { line: "gentle-shell '-e' '/app/bridge.ts'", content: undefined });
  assert.deepEqual(restore('gentle-shell', '/s/old.jsonl'), { line: "gentle-shell '-e' '/app/bridge.ts' '--session' '/s/old.jsonl'", content: undefined });
  assert.deepEqual(restore('opencode', '/s/old.jsonl', 'pi'), { line: "gentle-shell '--session' '/s/old.jsonl'", content: undefined });
  assert.deepEqual(launch('opencode', { agent: 'pi', agentCommand: 'gentle-shell' }), { line: 'gentle-shell', content: undefined });
  assert.deepEqual(launch('claude'), { line: `claude '--settings' '${SETTINGS}'`, content: undefined });
  assert.deepEqual(launch('opencode', agentLaunch('claude-code', 'opencode')!), { line: `claude '--settings' '${SETTINGS}'`, content: undefined });
  assert.deepEqual(launch('my-agent --x'), { line: 'my-agent --x', content: undefined });
  assert.deepEqual(launch('opencode', { kind: 'shell' }), { line: undefined, content: undefined });
  assert.deepEqual(bridgeArgs('gentle-shell', '/app/bridge.ts'), ['-e', '/app/bridge.ts']);
  assert.deepEqual(bridgeArgs('opencode', '/app/bridge.ts'), [], 'a lone bridge path is the gentle-shell one');
});

test('prepareOpencodePlugin writes the plugin under the runtime folder only (0700/0600) and names it in the config content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mirador-opencode-plugin-'));
  try {
    const content = await prepareOpencodePlugin(dir, PLUGIN);
    const pluginDir = join(dir, 'opencode-plugin');
    assert.deepEqual(JSON.parse(content), { plugins: [pluginDir] });
    assert.deepEqual((await readdir(dir)).sort(), ['opencode-plugin']);
    assert.deepEqual((await readdir(pluginDir)).sort(), ['index.js', 'package.json']);
    assert.equal((await stat(pluginDir)).mode & 0o777, 0o700);
    for (const name of ['index.js', 'package.json']) assert.equal((await stat(join(pluginDir, name))).mode & 0o777, 0o600, name);
    assert.equal(await readFile(join(pluginDir, 'index.js'), 'utf8'), await readFile(PLUGIN, 'utf8'));
    assert.deepEqual(JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8')), { type: 'module' });
    // Preparing again (a restart) rewrites the same files.
    assert.equal(await prepareOpencodePlugin(dir, PLUGIN), content);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a configured opencode with its own flags keeps them before --standalone, and resumes after it', () => {
  assert.deepEqual(launch('opencode --model x/y'), { line: "opencode --model x/y '--standalone'", content: CONTENT });
  assert.deepEqual(restore('opencode --model x/y', ID), { line: `opencode --model x/y '--standalone' '--session' '${ID}'`, content: CONTENT });
  assert.deepEqual(launch('opencode --model x/y', {}, false), { line: 'opencode --model x/y', content: undefined });
});

test('resumeArgs leaves an agent withoutBridge names to a fresh session, and every other agent as it was', () => {
  const old = new Set(['opencode']);
  assert.deepEqual(resumeArgs('opencode', ID, old), []);
  assert.deepEqual(resumeArgs('opencode --model x/y', ID, old), []);
  assert.deepEqual(resumeArgs('opencode', ID, new Set()), ['--session', ID]);
  assert.deepEqual(resumeArgs('claude', 'claude-sess-1', old), ['--resume', 'claude-sess-1']);
  assert.deepEqual(resumeArgs('gentle-shell', '/s/old.jsonl', old), ['--session', '/s/old.jsonl']);
  assert.deepEqual(resumeArgs('agy', 'agy-conv-1', old), ['--conversation', 'agy-conv-1']);
});
