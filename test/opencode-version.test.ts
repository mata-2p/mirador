// Which opencode Mirador's bridge works with (#124): opencode 2.0.0 is the first with `--standalone` and the V2
// plugin API (setup(ctx), session.execution.*, permission.*, form.*); opencode 1.x has neither
// (opencode's v2.0.0 tag). `opencode --version` is read once, without a shell and
// within a bounded time, and `mirador doctor` warns about an older one. Fake `opencode` scripts on a scratch
// PATH stand in for the real one; no real agent binary ever runs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPENCODE_BRIDGE_VERSION, readOpencodeVersion } from '../src/agents/opencode-version.ts';
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

test('opencode 2.0.0 is the version the bridge needs', () => {
  assert.equal(OPENCODE_BRIDGE_VERSION, '2.0.0');
});

test('readOpencodeVersion reads `opencode --version`: absent, older than 2.0.0, 2.0.0 or newer, or unreadable', async () => {
  assert.deepEqual(await readOpencodeVersion({ PATH: join(scratch, 'nowhere') }), { state: 'absent' });
  assert.deepEqual(await readOpencodeVersion({ PATH: await withOpencode('echo 1.19.6') }), { state: 'old', version: '1.19.6' });
  assert.deepEqual(await readOpencodeVersion({ PATH: await withOpencode('echo 1.99.99') }), { state: 'old', version: '1.99.99' });
  assert.deepEqual(await readOpencodeVersion({ PATH: await withOpencode('echo 2.0.0') }), { state: 'ok', version: '2.0.0' });
  assert.deepEqual(await readOpencodeVersion({ PATH: await withOpencode('echo opencode v2.4.2') }), { state: 'ok', version: '2.4.2' });
  assert.deepEqual(await readOpencodeVersion({ PATH: await withOpencode('echo 10.0.1') }), { state: 'ok', version: '10.0.1' });
  assert.deepEqual(await readOpencodeVersion({ PATH: await withOpencode('exit 99') }), { state: 'unreadable', reason: 'opencode --version exited with code 99' });
  assert.deepEqual(await readOpencodeVersion({ PATH: await withOpencode('echo hello') }), { state: 'unreadable', reason: 'opencode --version printed no version' });
  // Only stdout counts: a wrapper's note on stderr is no version.
  assert.deepEqual(await readOpencodeVersion({ PATH: await withOpencode('echo 1.19.6 >&2') }), { state: 'unreadable', reason: 'opencode --version printed no version' });
});

test('readOpencodeVersion runs the program itself with --version, no shell, and gives up on one that hangs, ending it and its children', async () => {
  const marks = join(scratch, 'marks');
  await mkdir(marks, { recursive: true });
  // Started directly, it gets exactly one argument, `--version`.
  const args = await withOpencode(`printf '%s\\n' "$@" > ${marks}/argv; echo 2.1.0`);
  assert.deepEqual(await readOpencodeVersion({ PATH: args }), { state: 'ok', version: '2.1.0' });
  assert.equal(await readFile(join(marks, 'argv'), 'utf8'), '--version\n');

  const hang = await withOpencode(`/bin/sleep 30 & echo $! > ${marks}/child; wait`);
  const began = Date.now();
  assert.deepEqual(await readOpencodeVersion({ PATH: hang }, { timeoutMs: 300 }), { state: 'unreadable', reason: 'opencode --version did not answer within 300 ms' });
  assert.ok(Date.now() - began < 3000, `gave up in ${Date.now() - began} ms`);
  const child = Number((await readFile(join(marks, 'child'), 'utf8')).trim());
  const alive = () => { try { process.kill(child, 0); return true; } catch { return false; } };
  for (let i = 0; i < 40 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(), false, 'its child was ended too');
});

const agentLine = (lines: string[]) => lines.find((line) => / agent opencode: /.test(line));

test('mirador doctor warns about an opencode older than 2.0.0, naming both versions and what Mirador does with it', async () => {
  const env = { PATH: await withOpencode('echo 1.19.6'), HOME: join(scratch, 'home'), GENTLE_AI_HOME: join(scratch, 'gentle-ai'), XDG_CONFIG_HOME: join(scratch, 'cfg') };
  const report = await doctor({ env, loadPty: async () => ({}), probeEngram: async () => false, platform: 'linux', kernelRelease: '6.12.0' });
  assert.equal(agentLine(report.lines), "  warn     agent opencode: opencode 1.19.6 on PATH, older than 2.0.0, the first with --standalone and the plugin API Mirador's bridge needs; Mirador starts it without attention or resume");
});

test('mirador doctor keeps its ok line for opencode 2.0.0 or newer, and for a version it cannot read', async () => {
  for (const body of ['echo 2.0.0', 'echo opencode v2.4.2', 'exit 99']) {
    const env = { PATH: await withOpencode(body), HOME: join(scratch, 'home'), GENTLE_AI_HOME: join(scratch, 'gentle-ai'), XDG_CONFIG_HOME: join(scratch, 'cfg') };
    const report = await doctor({ env, loadPty: async () => ({}), probeEngram: async () => false, platform: 'linux', kernelRelease: '6.12.0' });
    assert.equal(agentLine(report.lines), '  ok       agent opencode: opencode on PATH', body);
  }
});
