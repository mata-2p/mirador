// `node src/doctor.ts` says what is present or missing and
// exits 1 only when a required item (Node, node-pty, a browser) is missing. Every run gets a
// scratch HOME, config, GENTLE_AI_HOME and PATH of stubs that are never run, and Engram is a
// port this test owns: never the real home, agents or Engram.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSERS, doctor, MAC_APPS } from '../src/doctor.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

let scratch: string;
let closedPort: number;

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-doctor-')));
  closedPort = await freePort();
});

after(() => rm(scratch, { recursive: true, force: true }));

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return typeof address === 'object' && address ? address.port : 0;
}

/** A PATH directory of executable stubs that exit 99 if anything ever runs them. */
async function binDir(name: string, programs: string[]): Promise<string> {
  const dir = join(scratch, name);
  await mkdir(dir, { recursive: true });
  for (const program of programs) {
    await writeFile(join(dir, program), '#!/bin/sh\nexit 99\n');
    await chmod(join(dir, program), 0o755);
  }
  return dir;
}

/**
 * A scratch environment: nothing from the real home, Engram on `engramPort`, and a display (DISPLAY),
 * since on Linux without one the browser is not required; {@link withoutDisplay} takes it away.
 */
async function scratchEnv(name: string, path: string, engramPort: number, extra: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  const root = join(scratch, name);
  await mkdir(join(root, 'home'), { recursive: true });
  return {
    DISPLAY: ':0',
    PATH: path,
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_RUNTIME_DIR: join(root, 'run'),
    GENTLE_AI_HOME: join(root, 'gentle-ai'),
    ENGRAM_PORT: String(engramPort),
    ...extra,
  };
}

/** Runs `node src/doctor.ts` as a child, without blocking this process (a test Engram may answer). */
function runDoctor(env: NodeJS.ProcessEnv, args: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['src/doctor.ts', ...args], { cwd: APP_DIR, env, timeout: 20_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout, stderr });
    });
  });
}

/**
 * The `node src/doctor.ts` runs below check the PATH stubs on the host's platform. On macOS doctor
 * looks for the browser in /Applications instead (the CI runner has Google Chrome there) and has
 * no systemd line to stub, so these expectations are Linux's; the macOS rules are covered in-process
 * with `platform: 'darwin'` (below and in test/macos-degradation.test.ts).
 */
const CLI_ON_LINUX = process.platform === 'darwin' && 'runs the doctor CLI on the host: on macOS it finds the browser in /Applications, not the PATH stubs; the darwin rules are tested in-process with platform: darwin';

const line = (stdout: string, status: 'ok' | 'missing', label: string): RegExp =>
  new RegExp(`^  ${status} +${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `, 'm');

test('with Node, node-pty and a browser present it exits 0, and a missing Engram only informs', { skip: CLI_ON_LINUX }, async () => {
  const bin = await binDir('bin-ok', ['chromium']);
  const { code, stdout, stderr } = await runDoctor(await scratchEnv('ok', bin, closedPort));
  assert.equal(stderr, '');
  assert.equal(code, 0, stdout);
  assert.match(stdout, new RegExp(`^  ok +Node: v${process.versions.node.replace(/\./g, '\\.')} \\(24 or newer\\)$`, 'm'));
  assert.match(stdout, /^ {2}ok +node-pty: loads$/m);
  assert.match(stdout, /^ {2}ok +browser: app window \(chromium\)$/m);
  assert.match(stdout, /^ {2}missing +systemd: no systemd-run on PATH, no user bus; terminals run without scopes$/m);
  assert.match(stdout, new RegExp(`^  missing +gentle-ai: no ${join(scratch, 'ok', 'gentle-ai', 'state.json')}$`, 'm'));
  assert.match(stdout, /^ {2}missing +agent pi: gentle-shell not on PATH$/m);
  assert.match(stdout, /^ {2}missing +agent claude-code: claude not on PATH$/m);
  assert.match(stdout, new RegExp(`^  missing +Engram: no answer at http://127\\.0\\.0\\.1:${closedPort}; memory views stay empty$`, 'm'));
  assert.match(stdout, /^Mode: plain \(config: auto\)$/m);
  assert.match(stdout, /^All required items are present\.$/m);
});

test('a missing browser is a missing requirement: exit 1, named in the last line', { skip: CLI_ON_LINUX }, async () => {
  const bin = await binDir('bin-none', []);
  const { code, stdout } = await runDoctor(await scratchEnv('no-browser', bin, closedPort));
  assert.equal(code, 1, stdout);
  assert.match(stdout, /^ {2}missing +browser: no Chromium-family browser \(chromium, chromium-browser, brave, brave-browser, google-chrome-stable, google-chrome, microsoft-edge-stable, microsoft-edge, vivaldi-stable, vivaldi\) and no xdg-open on PATH$/m);
  assert.match(stdout, /^Missing required: browser\.$/m);
});

test('optional items found are ok: systemd, gentle-ai, agents on PATH, Engram answering, gentle-deck mode', { skip: CLI_ON_LINUX }, async () => {
  const engram = createHttpServer((_request, response) => response.end('ok'));
  await new Promise<void>((resolve) => engram.listen(0, '127.0.0.1', resolve));
  const address = engram.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const bin = await binDir('bin-full', ['brave', 'systemd-run', 'gentle-shell', 'claude', 'opencode']);
    const env = await scratchEnv('full', bin, port);
    await mkdir(env.GENTLE_AI_HOME!, { recursive: true });
    await writeFile(join(env.GENTLE_AI_HOME!, 'state.json'), JSON.stringify({ installed_agents: ['pi', 'claude-code'] }));
    const { code, stdout } = await runDoctor(env);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /^ {2}ok +browser: app window \(brave\)$/m);
    assert.match(stdout, /^ {2}ok +systemd: systemd-run on PATH, no user bus; terminals run without scopes$/m);
    assert.match(stdout, new RegExp(`^  ok +gentle-ai: ${join(env.GENTLE_AI_HOME!, 'state.json')} \\(installed agents: pi, claude-code\\)$`, 'm'));
    assert.match(stdout, /^ {2}ok +agent pi: gentle-shell on PATH$/m);
    assert.match(stdout, /^ {2}ok +agent claude-code: claude on PATH$/m);
    assert.match(stdout, /^ {2}ok +agent opencode: opencode on PATH \(not in gentle-ai's installed agents\)$/m);
    assert.match(stdout, /^ {2}missing +agent kimi: kimi not on PATH$/m);
    assert.match(stdout, new RegExp(`^  ok +Engram: http://127\\.0\\.0\\.1:${port} answers$`, 'm'));
    assert.match(stdout, /^Mode: full \(config: auto\)$/m);
  } finally {
    await new Promise((resolve) => engram.close(resolve));
  }
});

test('the config file it reads is named, and its mode is the one resolved', async () => {
  const bin = await binDir('bin-config', ['google-chrome-stable', 'gentle-shell']);
  const env = await scratchEnv('config', bin, closedPort);
  const missing = await runDoctor(env);
  assert.match(missing.stdout, new RegExp(`^Config: ${join(env.XDG_CONFIG_HOME!, 'mirador', 'config.json')} \\(not found; defaults apply\\)$`, 'm'));
  await mkdir(join(env.XDG_CONFIG_HOME!, 'mirador'), { recursive: true });
  await writeFile(join(env.XDG_CONFIG_HOME!, 'mirador', 'config.json'), JSON.stringify({ mode: 'plain', idleSleepHours: -1 }));
  const { code, stdout } = await runDoctor(env);
  assert.equal(code, 0, stdout);
  assert.match(stdout, new RegExp(`^Config: ${join(env.XDG_CONFIG_HOME!, 'mirador', 'config.json')}$`, 'm'));
  assert.match(stdout, /^ {2}problem: idleSleepHours must be a number of hours from 0 \(off\) to 168; the default \(4\) applies$/m);
  assert.match(stdout, /^Mode: plain \(config: plain\)$/m);
});

test('#115: a bad idleSleep or idleSleepMinutes is reported as a config problem, in the existing style', async () => {
  const bin = await binDir('bin-idle', ['google-chrome-stable', 'gentle-shell']);
  const env = await scratchEnv('idle', bin, closedPort);
  await mkdir(join(env.XDG_CONFIG_HOME!, 'mirador'), { recursive: true });
  await writeFile(join(env.XDG_CONFIG_HOME!, 'mirador', 'config.json'), JSON.stringify({ idleSleep: 'yes', idleSleepMinutes: 0 }));
  const { code, stdout } = await runDoctor(env);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /^ {2}problem: idleSleepMinutes must be a whole number of minutes from 1 to 10080; idleSleepHours or the default \(240\) applies$/m);
  assert.match(stdout, /^ {2}problem: idleSleep must be true or false; the default \(on\) applies$/m);
});

test('a saved shell that is not bash is reported here too, because doctor is where a failed start is diagnosed (#10)', async () => {
  const bin = await binDir('bin-shell', ['google-chrome-stable', 'gentle-shell']);
  const env = await scratchEnv('shell', bin, closedPort);
  await mkdir(join(env.XDG_CONFIG_HOME!, 'mirador'), { recursive: true });
  const file = join(env.XDG_CONFIG_HOME!, 'mirador', 'config.json');
  await writeFile(file, JSON.stringify({ shell: '/bin/zsh' }));
  const { code, stdout } = await runDoctor(env);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /^ {2}problem: shell is not bash, so agent terminals cannot start \(they run `bash --rcfile`\); other terminals are unaffected$/m);
});

test('an old Node or a node-pty that does not load is a missing requirement', async () => {
  const bin = await binDir('bin-inproc', ['chromium']);
  const env = await scratchEnv('inproc', bin, closedPort);
  const old = await doctor({ env, nodeVersion: '22.11.0', probeEngram: async () => false });
  assert.equal(old.ok, false);
  assert.ok(old.lines.includes('  missing  Node: v22.11.0 (24 or newer needed)'), old.lines.join('\n'));
  assert.equal(old.lines.at(-1), 'Missing required: Node.');
  const noPty = await doctor({ env, loadPty: async () => { throw new Error('Cannot find module \'node-pty\''); }, probeEngram: async () => false });
  assert.equal(noPty.ok, false);
  assert.ok(noPty.lines.includes('  missing  node-pty: does not load (Cannot find module \'node-pty\'); run pnpm install, or pnpm rebuild node-pty after a Node upgrade'), noPty.lines.join('\n'));
  assert.equal(noPty.lines.at(-1), 'Missing required: node-pty.');
});

// `--report` adds one fenced block to paste in a bug report.

/** A stub `pnpm` in `dir` that only answers `--version`. */
async function fakePnpm(dir: string): Promise<void> {
  await writeFile(join(dir, 'pnpm'), '#!/bin/sh\n[ "$1" = --version ] && echo 10.4.1 && exit 0\nexit 99\n');
  await chmod(join(dir, 'pnpm'), 0o755);
}

/** The lines of the fenced report block, fences included; empty when there is none. */
function reportBlock(lines: string[]): string[] {
  const start = lines.indexOf('```text');
  if (start === -1) return [];
  const end = lines.indexOf('```', start + 1);
  return end === -1 ? [] : lines.slice(start, end + 1);
}

const fixed = {
  nodeVersion: '24.1.0',
  loadPty: async () => ({}),
  probeEngram: async () => false,
  system: async () => ({ os: 'Testix 1.2', kernel: '6.1.0-test', arch: 'arm64' }),
  pnpmVersion: async () => '10.4.1',
};

test('--report prints the usual lines, then one fenced block with the bug report fields', async () => {
  const bin = await binDir('bin-report', ['brave', 'systemd-run', 'claude', 'opencode']);
  const env = await scratchEnv('report', bin, closedPort, { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1/bus' });
  // The PATH stubs are Linux's (brave, systemd-run): the expectations hold for linux on any host.
  const usual = await doctor({ env, ...fixed, platform: 'linux' });
  const report = await doctor({ env, ...fixed, platform: 'linux', report: true });
  assert.equal(report.ok, true);
  assert.deepEqual(report.lines, [
    ...usual.lines,
    '',
    '```text',
    'Mirador doctor report',
    'OS: Testix 1.2',
    'kernel: 6.1.0-test',
    'arch: arm64',
    'Node: v24.1.0',
    'pnpm: 10.4.1',
    'node-pty: loads',
    'browser: brave',
    'systemd scopes: yes',
    'mode: plain (config: auto)',
    'agents on PATH: claude-code (claude), opencode (opencode)',
    '```',
  ]);
  const none = await doctor({
    env: await scratchEnv('report-none', await binDir('bin-report-none', []), closedPort),
    ...fixed,
    platform: 'linux',
    loadPty: async () => { throw new Error('Cannot find module \'node-pty\''); },
    pnpmVersion: async () => null,
    report: true,
  });
  assert.deepEqual(reportBlock(none.lines).slice(6, -1), [
    'pnpm: not found',
    'node-pty: does not load (Cannot find module \'node-pty\')',
    'browser: none',
    'systemd scopes: no',
    'mode: plain (config: auto)',
    'agents on PATH: none',
  ]);
});

test('the report holds no path under the home folder, no user name and no host name', { skip: CLI_ON_LINUX }, async () => {
  const bin = await binDir('bin-private', ['chromium']);
  await fakePnpm(bin);
  const env = await scratchEnv('private', bin, closedPort, { USER: 'zqxuser7', LOGNAME: 'zqxuser7' });
  env.HOME = join(scratch, 'private', 'zqxhome7');
  await mkdir(env.HOME, { recursive: true });
  const { code, stdout, stderr } = await runDoctor(env, ['--report']);
  assert.equal(stderr, '');
  assert.equal(code, 0, stdout);
  const block = reportBlock(stdout.split('\n'));
  assert.equal(block.length, 13, stdout);
  assert.match(block.join('\n'), /^OS: \S.*\nkernel: \S+\narch: \S+\nNode: v\d+\.\d+\.\d+\npnpm: 10\.4\.1\nnode-pty: loads\nbrowser: chromium\n/m);
  for (const secret of [env.HOME, scratch, 'zqxuser7', 'zqxhome7', APP_DIR]) assert.ok(!block.join('\n').includes(secret), `${secret} in\n${block.join('\n')}`);
  for (const row of block.slice(2, -1)) assert.ok(!row.slice(row.indexOf(': ') + 2).includes(hostname()), `host name in ${row}`);
  // A node-pty error names files under the home folder: the report keeps the message, not the paths.
  const broken = await doctor({
    env,
    ...fixed,
    loadPty: async () => { throw new Error(`Cannot find module '${env.HOME}/app/node_modules/node-pty/build/Release/pty.node' from ${env.HOME}/app`); },
    report: true,
  });
  assert.ok(reportBlock(broken.lines).includes('node-pty: does not load (Cannot find module <path> from <path>)'), broken.lines.join('\n'));
});

test('the report hides both a home path and a ~/ path in a node-pty error', async () => {
  const env = await scratchEnv('report-tilde', await binDir('bin-report-tilde', ['chromium']), closedPort);
  const report = await doctor({
    env,
    ...fixed,
    loadPty: async () => { throw new Error(`Cannot find module '${env.HOME}/app/node_modules/node-pty/build/Release/pty.node' from ~/app`); },
    report: true,
  });
  const row = reportBlock(report.lines).find((line) => line.startsWith('node-pty: '));
  assert.equal(row, 'node-pty: does not load (Cannot find module <path> from <path>)', report.lines.join('\n'));
  assert.equal(row.split('<path>').length - 1, 2);
  assert.ok(!row.includes(env.HOME!), row);
});

test('from the config the report shows only the mode', async () => {
  const bin = await binDir('bin-report-config', ['chromium', 'gentle-shell']);
  await fakePnpm(bin);
  const env = await scratchEnv('report-config', bin, closedPort);
  await mkdir(join(env.XDG_CONFIG_HOME!, 'mirador'), { recursive: true });
  // The doctor probes the config's Engram URL: a closed local port, so the test never makes a DNS lookup.
  const engram = `127.0.0.1:${closedPort}`;
  const config = { mode: 'gentle-deck', root: '/srv/zq-secret-root', port: 4999, engramUrl: `http://${engram}`, agentCommand: 'zq-agent --flag', timeZone: 'Pacific/Zq', scopes: false };
  await writeFile(join(env.XDG_CONFIG_HOME!, 'mirador', 'config.json'), JSON.stringify(config));
  const { code, stdout } = await runDoctor(env, ['--report']);
  assert.equal(code, 0, stdout);
  const block = reportBlock(stdout.split('\n'));
  // The resolved mode by its visible name; the config value as written.
  assert.ok(block.includes('mode: full (config: gentle-deck)'), stdout);
  assert.deepEqual(block.slice(1, -1).map((row) => row.split(': ')[0]), ['Mirador doctor report', 'OS', 'kernel', 'arch', 'Node', 'pnpm', 'node-pty', 'browser', 'systemd scopes', 'mode', 'agents on PATH']);
  for (const value of ['/srv/zq-secret-root', '4999', engram, 'zq-agent', 'Pacific/Zq', env.XDG_CONFIG_HOME!]) assert.ok(!block.join('\n').includes(value), `${value} in\n${block.join('\n')}`);
});

test('--report leaves the exit code and the usual output as without it', { skip: CLI_ON_LINUX }, async () => {
  for (const [name, programs, expected] of [['report-exit-ok', ['chromium'], 0], ['report-exit-missing', [], 1]] as const) {
    const bin = await binDir(`bin-${name}`, [...programs]);
    await fakePnpm(bin);
    const env = await scratchEnv(name, bin, closedPort);
    const plain = await runDoctor(env);
    const withReport = await runDoctor(env, ['--report']);
    assert.equal(plain.code, expected, plain.stdout);
    assert.equal(withReport.code, expected, withReport.stdout);
    assert.equal(withReport.stderr, '');
    assert.ok(withReport.stdout.startsWith(`${plain.stdout}\n\`\`\`text\n`), withReport.stdout);
    assert.ok(withReport.stdout.endsWith('\n```\n'), withReport.stdout);
  }
});

// One Chromium-family list for doctor and bin/mirador; the
// config's `browser` wins; without one, a tab in the default browser still counts.
const LINUX_BROWSERS = ['chromium', 'chromium-browser', 'brave', 'brave-browser', 'google-chrome-stable', 'google-chrome', 'microsoft-edge-stable', 'microsoft-edge', 'vivaldi-stable', 'vivaldi'];
const MACOS_APPS = ['Google Chrome', 'Brave Browser', 'Microsoft Edge', 'Vivaldi', 'Chromium'];
const LINUX = { platform: 'linux', kernelRelease: '6.12.0-arch1-1' } as const;
const WSL2 = { platform: 'linux', kernelRelease: '5.15.167.4-microsoft-standard-WSL2' } as const;

const browserLine = (lines: string[]): string | undefined => lines.find((row) => /^ {2}(ok|missing) +browser: /.test(row));

test('on Linux each Chromium-family binary on PATH opens the app window, and the list is the shared one', async () => {
  assert.deepEqual([...BROWSERS], LINUX_BROWSERS);
  for (const name of LINUX_BROWSERS) {
    const env = await scratchEnv(`linux-${name}`, await binDir(`bin-linux-${name}`, [name]), closedPort);
    const report = await doctor({ env, ...fixed, ...LINUX });
    assert.equal(report.ok, true, report.lines.join('\n'));
    assert.equal(browserLine(report.lines), `  ok       browser: app window (${name})`);
  }
  // Earlier in the list wins.
  const both = await scratchEnv('linux-both', await binDir('bin-linux-both', ['vivaldi', 'brave-browser']), closedPort);
  assert.equal(browserLine((await doctor({ env: both, ...fixed, ...LINUX })).lines), '  ok       browser: app window (brave-browser)');
});

test("the config's browser wins over the list; an unknown one falls back to the list and says so; a non-string is a problem", async () => {
  const env = await scratchEnv('config-browser', await binDir('bin-config-browser', ['chromium', 'my-browser']), closedPort);
  const configFile = join(env.XDG_CONFIG_HOME!, 'mirador', 'config.json');
  await mkdir(join(env.XDG_CONFIG_HOME!, 'mirador'), { recursive: true });

  await writeFile(configFile, JSON.stringify({ browser: 'my-browser' }));
  const chosen = await doctor({ env, ...fixed, ...LINUX, report: true });
  assert.equal(browserLine(chosen.lines), '  ok       browser: app window (my-browser)');
  assert.ok(reportBlock(chosen.lines).includes('browser: my-browser'), chosen.lines.join('\n'));

  await writeFile(configFile, JSON.stringify({ browser: 'not-installed' }));
  const unknown = await doctor({ env, ...fixed, ...LINUX });
  assert.equal(browserLine(unknown.lines), '  ok       browser: app window (chromium); the config\'s browser "not-installed" was not found');

  await writeFile(configFile, JSON.stringify({ browser: 42 }));
  const invalid = await doctor({ env, ...fixed, ...LINUX });
  assert.equal(browserLine(invalid.lines), '  ok       browser: app window (chromium)');
  assert.ok(invalid.lines.includes('  problem: browser must be a command on PATH or a macOS app name; the Chromium-family list applies'), invalid.lines.join('\n'));
});

test('on macOS it probes the shared app list in order, then falls back to a tab through open', async () => {
  assert.deepEqual([...MAC_APPS], MACOS_APPS);
  const env = await scratchEnv('macos', await binDir('bin-macos', []), closedPort);
  const asked: string[] = [];
  const installed = new Set(['Vivaldi', 'Chromium']);
  const macAppInstalled = async (name: string) => (asked.push(name), installed.has(name));
  const app = await doctor({ env, ...fixed, platform: 'darwin', macAppInstalled });
  assert.equal(app.ok, true, app.lines.join('\n'));
  assert.equal(browserLine(app.lines), '  ok       browser: app window (Vivaldi)');
  assert.deepEqual(asked, ['Google Chrome', 'Brave Browser', 'Microsoft Edge', 'Vivaldi']);

  // A config browser on macOS may be an app name.
  await mkdir(join(env.XDG_CONFIG_HOME!, 'mirador'), { recursive: true });
  await writeFile(join(env.XDG_CONFIG_HOME!, 'mirador', 'config.json'), JSON.stringify({ browser: 'Arc' }));
  installed.add('Arc');
  assert.equal(browserLine((await doctor({ env, ...fixed, platform: 'darwin', macAppInstalled })).lines), '  ok       browser: app window (Arc)');
  await rm(join(env.XDG_CONFIG_HOME!, 'mirador', 'config.json'));

  installed.clear();
  const tabEnv = await scratchEnv('macos-tab', await binDir('bin-macos-tab', ['open']), closedPort);
  const tab = await doctor({ env: tabEnv, ...fixed, platform: 'darwin', macAppInstalled });
  assert.equal(tab.ok, true, tab.lines.join('\n'));
  assert.equal(browserLine(tab.lines), '  ok       browser: tab in the default browser (open)');

  const none = await doctor({ env, ...fixed, platform: 'darwin', macAppInstalled });
  assert.equal(none.ok, false);
  assert.equal(browserLine(none.lines), '  missing  browser: no Chromium-family app (Google Chrome, Brave Browser, Microsoft Edge, Vivaldi, Chromium) and no open on PATH');
});

test('on WSL2 without a Linux Chromium browser wslview, then powershell.exe with Edge, count as openers', async () => {
  const viewEnv = await scratchEnv('wsl-view', await binDir('bin-wsl-view', ['wslview', 'powershell.exe', 'xdg-open']), closedPort);
  const view = await doctor({ env: viewEnv, ...fixed, ...WSL2 });
  assert.equal(view.ok, true, view.lines.join('\n'));
  assert.equal(browserLine(view.lines), '  ok       browser: tab in the default browser (wslview)');

  const edgeEnv = await scratchEnv('wsl-edge', await binDir('bin-wsl-edge', ['powershell.exe']), closedPort);
  const edge = await doctor({ env: edgeEnv, ...fixed, ...WSL2 });
  assert.equal(edge.ok, true, edge.lines.join('\n'));
  assert.equal(browserLine(edge.lines), '  ok       browser: app window (Microsoft Edge via powershell.exe)');

  const noneEnv = await scratchEnv('wsl-none', await binDir('bin-wsl-none', []), closedPort);
  const none = await doctor({ env: noneEnv, ...fixed, ...WSL2 });
  assert.equal(none.ok, false);
  assert.equal(browserLine(none.lines), `  missing  browser: no Chromium-family browser (${LINUX_BROWSERS.join(', ')}), wslview, powershell.exe or xdg-open on PATH`);
});

test('on Linux with no Chromium-family browser, xdg-open passes as a tab in the default browser', async () => {
  const env = await scratchEnv('xdg-open', await binDir('bin-xdg-open', ['xdg-open']), closedPort);
  const report = await doctor({ env, ...fixed, ...LINUX, report: true });
  assert.equal(report.ok, true, report.lines.join('\n'));
  assert.equal(browserLine(report.lines), '  ok       browser: tab in the default browser (xdg-open)');
  assert.ok(reportBlock(report.lines).includes('browser: xdg-open'), report.lines.join('\n'));
  assert.equal(report.lines.at(-1 - reportBlock(report.lines).length - 1), 'All required items are present.');
});

test('the Required and Optional sections keep their items and order on every platform', async () => {
  const env = await scratchEnv('sections', await binDir('bin-sections', []), closedPort);
  const labels = (lines: string[]) => lines.filter((row) => /^ {2}(ok|missing) /.test(row)).map((row) => row.trim().split(/ +/).slice(1).join(' ').split(':')[0]);
  const linux = await doctor({ env, ...fixed, ...LINUX });
  for (const platform of [{ platform: 'darwin', macAppInstalled: async () => false } as const, WSL2]) {
    const other = await doctor({ env, ...fixed, ...platform });
    assert.deepEqual(labels(other.lines), labels(linux.lines));
  }
  assert.deepEqual(labels(linux.lines).slice(0, 4), ['Node', 'node-pty', 'browser', 'systemd']);
  assert.deepEqual(labels(linux.lines).slice(-1), ['Engram']);
  assert.equal(linux.lines.slice(0, 3).join('|'), 'Mirador doctor||Required');
  assert.equal(linux.lines.at(-1), 'Missing required: browser.');
});

// A missing gentle-shell, pi or Engram gets one line that
// says what Mirador does without it and how to get it, under its own heading; it never changes the
// exit code, and with all three present the output is as before.
const GENTLE_SHELL_LINK = 'https://github.com/Gentleman-Programming/gentle-shell';
const NOT_FOUND = 'Not found (optional; Mirador runs without them)';
const NO_GENTLE_SHELL_PLAIN = `  gentle-shell: Mirador runs in plain mode: one bash per folder, no memory views, night shift or MCP servers per project; install it from ${GENTLE_SHELL_LINK}`;
const NO_GENTLE_SHELL_DECK = `  gentle-shell: Mirador runs in full mode, but a gentle-shell agent cannot start; install it from ${GENTLE_SHELL_LINK}`;
const NO_PI = `  pi: no pi agent and no session restore for it; gentle-shell starts pi, install it from ${GENTLE_SHELL_LINK}`;
const NO_ENGRAM = '  Engram: memory views such as "where it left off" stay empty; start it with: engram serve (see docs/configuration.md#use)';

const AGENT_LINES_WITH_GENTLE_SHELL = [
  '  ok       agent pi: gentle-shell on PATH',
  '  missing  agent claude-code: claude not on PATH',
  '  missing  agent opencode: opencode not on PATH',
  '  missing  agent antigravity: agy not on PATH',
  '  missing  agent codex: codex not on PATH',
  '  missing  agent gemini-cli: gemini not on PATH',
  '  missing  agent kimi: kimi not on PATH',
];

/** The lines under the not-found heading, up to the blank line that ends them; null without the heading. */
function notFound(lines: string[]): string[] | null {
  const start = lines.indexOf(NOT_FOUND);
  if (start === -1) return null;
  const end = lines.indexOf('', start);
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

test('without gentle-shell, pi and Engram it exits 0 and says what each one costs and how to get it', async () => {
  const bin = await binDir('bin-no-gentle', ['chromium']);
  const { code, stdout, stderr } = await runDoctor(await scratchEnv('no-gentle', bin, closedPort));
  assert.equal(stderr, '');
  assert.equal(code, 0, stdout);
  const lines = stdout.split('\n');
  assert.deepEqual(notFound(lines), [NO_GENTLE_SHELL_PLAIN, NO_PI, NO_ENGRAM], stdout);
  // After the optional items, before the config: the last line still sums up the required ones.
  assert.ok(lines.indexOf(NOT_FOUND) > lines.findIndex((row) => /^ {2}missing +Engram: /.test(row)), stdout);
  assert.ok(lines.indexOf(NOT_FOUND) < lines.findIndex((row) => row.startsWith('Config: ')), stdout);
  assert.equal(lines.at(-2), 'All required items are present.');
});

test('each notice shows only for what is missing: pi alone counts as pi, gentle-shell counts as pi too', async () => {
  const piOnly = await scratchEnv('pi-only', await binDir('bin-pi-only', ['chromium', 'pi']), closedPort);
  const pi = await doctor({ env: piOnly, ...fixed, ...LINUX, probeEngram: async () => true });
  assert.equal(pi.ok, true);
  assert.deepEqual(notFound(pi.lines), [NO_GENTLE_SHELL_PLAIN]);

  const shellOnly = await scratchEnv('shell-only', await binDir('bin-shell-only', ['chromium', 'gentle-shell']), closedPort);
  const shell = await doctor({ env: shellOnly, ...fixed, ...LINUX });
  assert.equal(shell.ok, true);
  assert.deepEqual(notFound(shell.lines), [NO_ENGRAM]);

  // A missing required item keeps exit 1, and the notices still show.
  const none = await scratchEnv('notices-no-browser', await binDir('bin-notices-no-browser', []), closedPort);
  const broken = await doctor({ env: none, ...fixed, ...LINUX });
  assert.equal(broken.ok, false);
  assert.deepEqual(notFound(broken.lines), [NO_GENTLE_SHELL_PLAIN, NO_PI, NO_ENGRAM]);
  assert.equal(broken.lines.at(-1), 'Missing required: browser.');
});

test("without gentle-shell but with gentle-ai's state.json the mode stays full (gentle-deck), and the notice says so", async () => {
  const env = await scratchEnv('deck-no-shell', await binDir('bin-deck-no-shell', ['chromium', 'pi']), closedPort);
  await mkdir(env.GENTLE_AI_HOME!, { recursive: true });
  await writeFile(join(env.GENTLE_AI_HOME!, 'state.json'), JSON.stringify({ installed_agents: ['pi'] }));
  const report = await doctor({ env, ...fixed, ...LINUX, probeEngram: async () => true });
  assert.equal(report.ok, true);
  assert.deepEqual(notFound(report.lines), [NO_GENTLE_SHELL_DECK]);
  assert.ok(report.lines.includes('Mode: full (config: auto)'), report.lines.join('\n'));
});

test('with gentle-shell, pi and Engram present there is no notice and the output is as before', async () => {
  const env = await scratchEnv('all-gentle', await binDir('bin-all-gentle', ['chromium', 'gentle-shell', 'pi']), closedPort);
  const report = await doctor({ env, ...fixed, ...LINUX, probeEngram: async () => true });
  assert.equal(report.ok, true);
  assert.deepEqual(report.lines, [
    'Mirador doctor',
    '',
    'Required',
    '  ok       Node: v24.1.0 (24 or newer)',
    '  ok       node-pty: loads',
    '  ok       browser: app window (chromium)',
    '',
    'Optional',
    '  missing  systemd: no systemd-run on PATH, no user bus; terminals run without scopes',
    `  missing  gentle-ai: no ${join(env.GENTLE_AI_HOME!, 'state.json')}`,
    ...AGENT_LINES_WITH_GENTLE_SHELL,
    `  ok       Engram: http://127.0.0.1:${closedPort} answers`,
    '',
    `Config: ${join(env.XDG_CONFIG_HOME!, 'mirador', 'config.json')} (not found; defaults apply)`,
    'Mode: full (config: auto)',
    '',
    'All required items are present.',
  ]);
});

// install.sh and doctor check Engram the same way.
// `node src/doctor.ts --engram` runs only doctor's Engram check: it prints the URL the Engram line
// probes (the config's engramUrl, 127.0.0.1 by default) and exits 0 when Engram answers there and 1
// when it does not, whatever else the machine lacks.
async function withEngram(run: (port: number) => Promise<void>): Promise<void> {
  const engram = createHttpServer((_request, response) => response.end('ok'));
  await new Promise<void>((resolve) => engram.listen(0, '127.0.0.1', resolve));
  const address = engram.address();
  try {
    await run(typeof address === 'object' && address ? address.port : 0);
  } finally {
    await new Promise((resolve) => engram.close(resolve));
  }
}

test('--engram exits 0 with the URL when Engram answers and 1 when it does not, in step with the Engram line', async () => {
  await withEngram(async (port) => {
    const up = await scratchEnv('engram-flag-up', await binDir('bin-engram-flag-up', []), port);
    assert.deepEqual(await runDoctor(up, ['--engram']), { code: 0, stdout: `http://127.0.0.1:${port}\n`, stderr: '' });
    assert.match((await runDoctor(up)).stdout, new RegExp(`^  ok +Engram: http://127\\.0\\.0\\.1:${port} answers$`, 'm'));
  });
  const down = await scratchEnv('engram-flag-down', await binDir('bin-engram-flag-down', []), closedPort);
  assert.deepEqual(await runDoctor(down, ['--engram']), { code: 1, stdout: `http://127.0.0.1:${closedPort}\n`, stderr: '' });
  assert.match((await runDoctor(down)).stdout, new RegExp(`^  missing +Engram: no answer at http://127\\.0\\.0\\.1:${closedPort}; memory views stay empty$`, 'm'));
});

test("--engram probes the config's engramUrl, as the Engram line does", async () => {
  await withEngram(async (port) => {
    const env = await scratchEnv('engram-flag-config', await binDir('bin-engram-flag-config', []), closedPort);
    await mkdir(join(env.XDG_CONFIG_HOME!, 'mirador'), { recursive: true });
    await writeFile(join(env.XDG_CONFIG_HOME!, 'mirador', 'config.json'), JSON.stringify({ engramUrl: `http://127.0.0.1:${port}` }));
    assert.deepEqual(await runDoctor(env, ['--engram']), { code: 0, stdout: `http://127.0.0.1:${port}\n`, stderr: '' });
    assert.match((await runDoctor(env)).stdout, new RegExp(`^  ok +Engram: http://127\\.0\\.0\\.1:${port} answers$`, 'm'));
  });
});

// install.sh checks the browser before installing, the same way doctor does.
// `node src/doctor.ts --browser` runs only doctor's browser check: it prints what bin/mirador would open
// Mirador with and exits 0, or what it found missing and exits 1, whatever else the machine lacks.
test('--browser exits 0 naming the opener, or 1 naming what is missing, in step with the browser line', { skip: CLI_ON_LINUX }, async () => {
  const found = await scratchEnv('browser-flag-found', await binDir('bin-browser-flag-found', ['brave']), closedPort);
  assert.deepEqual(await runDoctor(found, ['--browser']), { code: 0, stdout: 'app window (brave)\n', stderr: '' });
  assert.ok((await runDoctor(found)).stdout.includes('  ok       browser: app window (brave)\n'));

  const none = await scratchEnv('browser-flag-none', await binDir('bin-browser-flag-none', []), closedPort);
  const missing = `no Chromium-family browser (${BROWSERS.join(', ')}) and no xdg-open on PATH`;
  assert.deepEqual(await runDoctor(none, ['--browser']), { code: 1, stdout: `${missing}\n`, stderr: '' });
  assert.ok((await runDoctor(none)).stdout.includes(`  missing  browser: ${missing}\n`));

  // The config's browser wins, as on the browser line.
  const configured = await scratchEnv('browser-flag-config', await binDir('bin-browser-flag-config', ['brave', 'my-browser']), closedPort);
  await mkdir(join(configured.XDG_CONFIG_HOME!, 'mirador'), { recursive: true });
  await writeFile(join(configured.XDG_CONFIG_HOME!, 'mirador', 'config.json'), JSON.stringify({ browser: 'my-browser' }));
  assert.deepEqual(await runDoctor(configured, ['--browser']), { code: 0, stdout: 'app window (my-browser)\n', stderr: '' });
});

// On Linux without a display (not WSL2, DISPLAY and WAYLAND_DISPLAY unset or empty) bin/mirador prints a
// one-time link to open in a browser elsewhere instead of opening a window: the browser line moves to the
// optional items, names that reason and no longer decides the exit code. `--browser` still says whether
// an opener is found; install.sh decides by itself that a missing one is only a warning there.
const NOT_REQUIRED = 'not required without a display (DISPLAY and WAYLAND_DISPLAY are unset): mirador prints a one-time link to open in a browser instead';

function withoutDisplay(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { DISPLAY: _display, WAYLAND_DISPLAY: _wayland, ...rest } = env;
  return rest;
}

/** The labels of the item lines under `heading` (Required or Optional), up to the blank line that ends them. */
function section(lines: string[], heading: string): string[] {
  const start = lines.indexOf(heading);
  const end = lines.indexOf('', start);
  return lines.slice(start + 1, end).map((row) => row.trim().split(/ +/).slice(1).join(' ').split(':')[0]);
}

test('on Linux without a display a missing browser only informs: exit 0, among the optional items, naming the reason', { skip: CLI_ON_LINUX }, async () => {
  const env = withoutDisplay(await scratchEnv('no-display', await binDir('bin-no-display', []), closedPort));
  const detail = `no Chromium-family browser (${BROWSERS.join(', ')}) and no xdg-open on PATH`;
  const { code, stdout, stderr } = await runDoctor(env);
  assert.equal(stderr, '');
  assert.equal(code, 0, stdout);
  const lines = stdout.split('\n');
  assert.ok(lines.includes(`  missing  browser: ${detail}; ${NOT_REQUIRED}`), stdout);
  assert.deepEqual(section(lines, 'Required'), ['Node', 'node-pty']);
  assert.deepEqual(section(lines, 'Optional').slice(0, 2), ['browser', 'systemd']);
  assert.equal(lines.at(-2), 'All required items are present.');
  // The report names no browser, as for any optional item it lacks.
  assert.ok((await runDoctor(env, ['--report'])).stdout.includes('\nbrowser: none\n'));
  // --browser still answers whether an opener is found.
  assert.deepEqual(await runDoctor(env, ['--browser']), { code: 1, stdout: `${detail}\n`, stderr: '' });
});

test('without a display, empty DISPLAY and WAYLAND_DISPLAY count as unset, and a browser found is an optional ok with the same reason', async () => {
  const none = { ...withoutDisplay(await scratchEnv('empty-display', await binDir('bin-empty-display', []), closedPort)), DISPLAY: '', WAYLAND_DISPLAY: '' };
  const empty = await doctor({ env: none, ...fixed, ...LINUX });
  assert.equal(empty.ok, true, empty.lines.join('\n'));
  assert.equal(browserLine(empty.lines), `  missing  browser: no Chromium-family browser (${BROWSERS.join(', ')}) and no xdg-open on PATH; ${NOT_REQUIRED}`);
  assert.equal(empty.lines.at(-1), 'All required items are present.');

  const found = withoutDisplay(await scratchEnv('no-display-found', await binDir('bin-no-display-found', ['chromium']), closedPort));
  const report = await doctor({ env: found, ...fixed, ...LINUX });
  assert.equal(report.ok, true);
  assert.equal(browserLine(report.lines), `  ok       browser: app window (chromium); ${NOT_REQUIRED}`);
  assert.deepEqual(section(report.lines, 'Required'), ['Node', 'node-pty']);
  assert.equal(section(report.lines, 'Optional')[0], 'browser');
});

test('with a display, or on WSL2 or macOS without one, a missing browser is still required', async () => {
  const bin = await binDir('bin-display-required', []);
  const base = withoutDisplay(await scratchEnv('display-required', bin, closedPort));
  for (const [what, env, platform] of [
    ['DISPLAY', { ...base, DISPLAY: ':0' }, LINUX],
    ['WAYLAND_DISPLAY', { ...base, WAYLAND_DISPLAY: 'wayland-0' }, LINUX],
    ['WSL2', base, WSL2],
    ['macOS', base, { platform: 'darwin', macAppInstalled: async () => false }],
  ] as const) {
    const report = await doctor({ env, ...fixed, ...platform });
    assert.equal(report.ok, false, what);
    assert.match(browserLine(report.lines) ?? '', /^ {2}missing +browser: no Chromium-family (browser|app) .* on PATH$/, what);
    assert.deepEqual(section(report.lines, 'Required'), ['Node', 'node-pty', 'browser'], what);
    assert.equal(report.lines.at(-1), 'Missing required: browser.', what);
  }
});
