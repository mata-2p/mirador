// Which opencode Mirador's bridge works with (#124): opencode 2.0.0 is the first with `--standalone` and the V2
// plugin API (setup(ctx), session.execution.*, permission.*, form.*); opencode 1.x has neither
// (opencode's v2.0.0 tag). `opencode --version` is read once, without a shell and within a bounded time, from the
// opencode an agent terminal runs: the configured `agentCommand`'s when it names opencode by path, else the
// `opencode` on Mirador's own PATH (a ~/.bashrc is never run for it). `mirador doctor` names that opencode and warns
// about an older one. Fake `opencode` scripts on a scratch PATH stand in for the real one; no real agent binary
// ever runs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as versions from '../src/agents/opencode-version.ts';
import { OPENCODE_BRIDGE_VERSION, OPENCODE_VERSION_TIMEOUT_MS, oldOpencodeText, readOpencodeVersion } from '../src/agents/opencode-version.ts';
import { doctor } from '../src/doctor.ts';

const scratch = await mkdtemp(join(tmpdir(), 'mirador-opencode-version-'));
after(() => rm(scratch, { recursive: true, force: true }));

let dirs = 0;
/** A PATH directory holding an `opencode` that runs `body` (shell). */
async function withOpencode(body: string): Promise<string> {
  const dir = join(scratch, `bin-${++dirs}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'opencode'), `#!/bin/sh\n${body}\n`);
  await chmod(join(dir, 'opencode'), 0o755);
  return dir;
}

/** What readOpencodeVersion says for an `opencode` printing `body` on a PATH of its own. */
async function versionOf(body: string) {
  const dir = await withOpencode(body);
  return { dir, file: join(dir, 'opencode'), read: await readOpencodeVersion({ PATH: dir }) };
}

/** A scratch HOME whose ~/.bashrc runs `bashrc`. */
async function home(bashrc: string): Promise<string> {
  const dir = join(scratch, `home-${++dirs}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '.bashrc'), `${bashrc}\n`);
  return dir;
}

const waitForFile = async (file: string, ms: number): Promise<string> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const text = await readFile(file, 'utf8').catch(() => '');
    if (text.endsWith('\n')) return text;
    if (Date.now() > deadline) throw new Error(`${file} did not appear within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test('opencode 2.0.0 is the version the bridge needs, and a slow opencode wrapper gets 15 s to answer', () => {
  assert.equal(OPENCODE_BRIDGE_VERSION, '2.0.0');
  assert.equal(OPENCODE_VERSION_TIMEOUT_MS, 15_000);
});

test('readOpencodeVersion reads `opencode --version`: absent, older than 2.0.0, 2.0.0 or newer, or unreadable, naming the file it ran', async () => {
  assert.deepEqual(await readOpencodeVersion({ PATH: join(scratch, 'nowhere') }), { state: 'absent' });
  for (const [body, expected] of [
    ['echo 1.19.6', { state: 'old', version: '1.19.6' }],
    ['echo 1.99.99', { state: 'old', version: '1.99.99' }],
    ['echo 2.0.0', { state: 'ok', version: '2.0.0' }],
    ['echo opencode v2.4.2', { state: 'ok', version: '2.4.2' }],
    ['echo 10.0.1', { state: 'ok', version: '10.0.1' }],
    ['exit 99', { state: 'unreadable', reason: 'opencode --version exited with code 99' }],
    ['echo hello', { state: 'unreadable', reason: 'opencode --version printed no version' }],
    // Only stdout counts: a wrapper's note on stderr is no version.
    ['echo 1.19.6 >&2', { state: 'unreadable', reason: 'opencode --version printed no version' }],
  ] as const) {
    const { file, read } = await versionOf(body);
    assert.deepEqual(read, { ...expected, file }, body);
  }
});

test('a pre-release is compared by its x.y.z, and a 0.0.0-… development build counts as unreadable (the bridge stays)', async () => {
  for (const [body, expected] of [
    ['echo 2.0.0-beta.1', { state: 'ok', version: '2.0.0-beta.1' }],
    ['echo 2.3.1-rc.2', { state: 'ok', version: '2.3.1-rc.2' }],
    ['echo 1.19.6-next.4', { state: 'old', version: '1.19.6-next.4' }],
    ['echo 0.0.0-dev-202611271200', { state: 'unreadable', reason: 'opencode --version printed a development build (0.0.0-dev-202611271200), not a release' }],
    ['echo 0.0.0-main-1a2b3c', { state: 'unreadable', reason: 'opencode --version printed a development build (0.0.0-main-1a2b3c), not a release' }],
  ] as const) {
    const { file, read } = await versionOf(body);
    assert.deepEqual(read, { ...expected, file }, body);
  }
});

test('a configured agentCommand naming opencode by path is the opencode read, not the one on PATH', async () => {
  const onPath = await withOpencode('echo 2.1.0');
  const configured = await withOpencode('echo 1.19.6');
  const env = { PATH: onPath, HOME: await home('') };
  assert.deepEqual(await readOpencodeVersion(env, { agentCommand: `${configured}/opencode --model x` }), { state: 'old', version: '1.19.6', file: join(configured, 'opencode') });
  // `~/` is the agent bash's tilde: HOME.
  const tilde = join(env.HOME, 'tools');
  await mkdir(tilde, { recursive: true });
  await writeFile(join(tilde, 'opencode'), '#!/bin/sh\necho 1.2.3\n', { mode: 0o755 });
  assert.deepEqual(await readOpencodeVersion(env, { agentCommand: '~/tools/opencode' }), { state: 'old', version: '1.2.3', file: join(tilde, 'opencode') });
  // A relative path resolves in each folder an agent opens: no one version to read, so the bridge stays.
  assert.deepEqual(await readOpencodeVersion(env, { agentCommand: 'bin/opencode' }), {
    state: 'unreadable',
    file: 'bin/opencode',
    reason: 'agentCommand names opencode by a relative path, which each folder resolves on its own',
  });
  // A plain `opencode`, or another agent configured (opencode chosen from the catalog), is looked up on PATH.
  for (const agentCommand of ['opencode', 'gentle-shell']) {
    assert.deepEqual(await readOpencodeVersion(env, { agentCommand }), { state: 'ok', version: '2.1.0', file: join(onPath, 'opencode') }, agentCommand);
  }
});

test('a wrapper that prints its own version first: the last x.y.z on stdout is opencode\'s', async () => {
  for (const [body, expected] of [
    ['echo "opencode-wrapper 1.4.0"; echo 2.1.0', { state: 'ok', version: '2.1.0' }],
    ['echo "wrapper 3.0.0"; echo "opencode 1.19.6"', { state: 'old', version: '1.19.6' }],
    ['echo "wrapper 1.0.0"; echo 0.0.0-dev-202611271200', { state: 'unreadable', reason: 'opencode --version printed a development build (0.0.0-dev-202611271200), not a release' }],
  ] as const) {
    const { file, read } = await versionOf(body);
    assert.deepEqual(read, { ...expected, file }, body);
  }
});

test('readOpencodeVersion runs the program itself with --version, no shell, and gives up on one that hangs, ending it and its children', async () => {
  const marks = join(scratch, 'marks');
  await mkdir(marks, { recursive: true });
  // Started directly, it gets exactly one argument, `--version`.
  const args = await withOpencode(`printf '%s\\n' "$@" > ${marks}/argv; echo 2.1.0`);
  assert.deepEqual(await readOpencodeVersion({ PATH: args }), { state: 'ok', version: '2.1.0', file: join(args, 'opencode') });
  assert.equal(await readFile(join(marks, 'argv'), 'utf8'), '--version\n');

  // The child writes its pid first thing; the test waits for that file while the read is still pending (the
  // limit is far longer than that takes), so the kill always finds a child to end.
  const hang = await withOpencode(`/bin/sleep 30 & echo $! > ${marks}/child.tmp; /bin/mv ${marks}/child.tmp ${marks}/child; wait`);
  const began = Date.now();
  const reading = readOpencodeVersion({ PATH: hang }, { timeoutMs: 1500 });
  const child = Number((await waitForFile(join(marks, 'child'), 1500)).trim());
  assert.deepEqual(await reading, { state: 'unreadable', reason: 'opencode --version did not answer within 1500 ms', file: join(hang, 'opencode') });
  assert.ok(Date.now() - began < 5000, `gave up in ${Date.now() - began} ms`);
  const alive = () => { try { process.kill(child, 0); return true; } catch { return false; } };
  for (let i = 0; i < 40 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(), false, 'its child was ended too');
});

const agentLine = (lines: string[]) => lines.find((line) => / agent opencode: /.test(line));
const doctorEnv = async (path: string, bashrc = '') => ({ PATH: path, HOME: await home(bashrc), GENTLE_AI_HOME: join(scratch, 'gentle-ai'), XDG_CONFIG_HOME: join(scratch, 'cfg') });
const runDoctor = (env: NodeJS.ProcessEnv) => doctor({ env, loadPty: async () => ({}), probeEngram: async () => false, platform: 'linux', kernelRelease: '6.12.0' });

test('mirador doctor warns about an opencode older than 2.0.0, naming the file, both versions and what Mirador does with it', async () => {
  const dir = await withOpencode('echo 1.19.6');
  const report = await runDoctor(await doctorEnv(dir));
  const file = join(dir, 'opencode');
  assert.equal(agentLine(report.lines), `  warn     agent opencode: opencode on PATH; opencode 1.19.6 (${file}) is older than 2.0.0, the first opencode with --standalone and the plugin API Mirador's bridge needs; Mirador starts it without attention or resume`);
  // The same words as the server's log line (OpencodeNotices).
  assert.ok(agentLine(report.lines)!.includes(oldOpencodeText({ version: '1.19.6', file })));
});

test('mirador doctor names the opencode agent terminals run: its version when 2.0.0 or newer, or why it could not be read', async () => {
  for (const [body, detail] of [
    ['echo 2.0.0', (file: string) => `opencode 2.0.0 (${file}), with Mirador's bridge`],
    ['echo opencode v2.4.2', (file: string) => `opencode 2.4.2 (${file}), with Mirador's bridge`],
    ['exit 99', (file: string) => `could not read the version of ${file} (opencode --version exited with code 99); opencode agents start with Mirador's bridge as before, which needs opencode 2.0.0 or newer`],
  ] as const) {
    const dir = await withOpencode(body);
    const report = await runDoctor(await doctorEnv(dir));
    assert.equal(agentLine(report.lines), `  ok       agent opencode: opencode on PATH; ${detail(join(dir, 'opencode'))}`, body);
  }
  // The words for a version it could not read are the server's log line's (OpencodeNotices).
  const unreadable = await withOpencode('exit 99');
  const words = (versions as Record<string, unknown>).unreadableOpencodeText as ((version: { reason: string; file: string }) => string) | undefined;
  assert.equal(typeof words, 'function', 'one helper words an unreadable version for doctor and the log');
  assert.ok(agentLine((await runDoctor(await doctorEnv(unreadable))).lines)!.endsWith(words!({ reason: 'opencode --version exited with code 99', file: join(unreadable, 'opencode') })));
});

test('mirador doctor reads the opencode on its own PATH and never runs ~/.bashrc, even when it puts another opencode first', async () => {
  const server = await withOpencode('echo 1.19.6');
  const agent = await withOpencode('echo 2.5.0');
  const env = await doctorEnv(server, `: > "$HOME/bashrc-ran"; PATH="${agent}:$PATH"`);
  const report = await runDoctor(env);
  assert.equal(agentLine(report.lines), `  warn     agent opencode: opencode on PATH; ${oldOpencodeText({ version: '1.19.6', file: join(server, 'opencode') })}; Mirador starts it without attention or resume`);
  await assert.rejects(readFile(join(env.HOME, 'bashrc-ran')), { code: 'ENOENT' }, '~/.bashrc was not run');
});
