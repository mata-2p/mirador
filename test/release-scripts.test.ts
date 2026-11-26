// The release workflow's shell helpers under scripts/release/, run with stubs and local files only:
//   check-tag.sh  a release tag must be v<package.json's version>;
//   fetch-node.sh the official Node tarball is unpacked only when it matches the sha256 pinned in release.yml,
//                 whatever the SHASUMS256.txt served beside it says (curl is a stub serving local files, so
//                 nothing reaches nodejs.org);
//   check-glibc.sh a built addon must name glibc 2.28 at most, and name some glibc (objdump is a stub);
//   smoke.sh      an archive is checked in each container given, and the job summary gets its size and timings
//                 (docker is a stub; the containers themselves run in the release workflow).
// Every PATH starts with a folder holding only `node`, a link to the running Node binary, so no script ever
// reaches a node shim (mise's would install a Node over the network in a scratch HOME).
// pins.sh, which prints the lines a promotion PR pins, is tested with the bootstrap script it feeds.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = fileURLToPath(new URL('../scripts/release/', import.meta.url));
const DIST = 'https://nodejs.org/dist';

let scratch: string;
let dirs = 0;
/** The system PATH behind a folder whose only entry is `node`, linked to the running Node binary. */
let PATH: string;

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-release-scripts-')));
  await mkdir(join(scratch, 'node-bin'));
  await symlink(process.execPath, join(scratch, 'node-bin', 'node'));
  PATH = `${join(scratch, 'node-bin')}:/usr/bin:/bin`;
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function fresh(): Promise<string> {
  const dir = join(scratch, `dir-${++dirs}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function sh(script: string, args: string[], env: NodeJS.ProcessEnv = { PATH }, cwd = scratch): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', [join(SCRIPTS, script), ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const exists = (path: string) => access(path).then(() => true, () => false);

test('check-tag.sh prints the version of a tag that matches package.json', async () => {
  const dir = await fresh();
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'mirador', version: '0.2.0' }));
  assert.deepEqual(await sh('check-tag.sh', ['v0.2.0', join(dir, 'package.json')]), { code: 0, stdout: '0.2.0\n', stderr: '' });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'mirador', version: '0.2.0-rc.1' }));
  assert.deepEqual(await sh('check-tag.sh', ['v0.2.0-rc.1', join(dir, 'package.json')]), { code: 0, stdout: '0.2.0-rc.1\n', stderr: '' });
});

test('check-tag.sh refuses a tag that is not v<major>.<minor>.<patch>, or that differs from package.json', async () => {
  const dir = await fresh();
  const pkg = join(dir, 'package.json');
  await writeFile(pkg, JSON.stringify({ name: 'mirador', version: '0.1.0' }));
  for (const tag of ['v1.2', '0.1.0', 'v0.1.0;id', 'v0.1.0 ', '']) {
    assert.deepEqual(await sh('check-tag.sh', [tag, pkg]), { code: 1, stdout: '', stderr: `check-tag.sh: "${tag}" is not a release tag (v<major>.<minor>.<patch>, such as v0.2.0)\n` }, tag);
  }
  assert.deepEqual(await sh('check-tag.sh', ['v0.2.0', pkg]), {
    code: 1,
    stdout: '',
    stderr: "check-tag.sh: tag v0.2.0 does not match package.json's version 0.1.0; bump the version in package.json (and CHANGELOG.md) first\n",
  });
});

interface NodeDist {
  dir: string;
  out: string;
  curlLog: string;
  env: NodeJS.ProcessEnv;
  name: string;
  sha: string;
}

/** A fake nodejs.org: a curl stub serving <dir>/served as https://nodejs.org/dist, with a Node 24.0.0 tarball for x64. */
async function nodeDist(shasums: (name: string, sha: string) => string): Promise<NodeDist> {
  const dir = await fresh();
  const stubs = join(dir, 'stubs');
  const served = join(dir, 'served', 'v24.0.0');
  const curlLog = join(dir, 'curl.log');
  const name = 'node-v24.0.0-linux-x64';
  await mkdir(join(dir, 'tree', name, 'bin'), { recursive: true });
  await writeFile(join(dir, 'tree', name, 'bin', 'node'), '#!/bin/sh\necho fake node\n');
  await writeFile(join(dir, 'tree', name, 'LICENSE'), 'Node.js license\n');
  await mkdir(served, { recursive: true });
  await new Promise<void>((resolve, reject) => execFile('tar', ['-cJf', join(served, `${name}.tar.xz`), '-C', join(dir, 'tree'), name], (error) => (error ? reject(error) : resolve())));
  const sha = createHash('sha256').update(await readFile(join(served, `${name}.tar.xz`))).digest('hex');
  await writeFile(join(served, 'SHASUMS256.txt'), shasums(`${name}.tar.xz`, sha));
  await mkdir(stubs);
  await writeFile(
    join(stubs, 'curl'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${curlLog}'`,
      'out= url=',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    -o | --proto) [ "$1" = -o ] && out="$2"; shift 2 ;;',
      '    -*) shift ;;',
      '    *) url="$1"; shift ;;',
      '  esac',
      'done',
      `file='${join(dir, 'served')}'/"\${url#${DIST}/}"`,
      `if [ "$file" = '${join(dir, 'served')}'/"$url" ] || [ ! -f "$file" ]; then echo 'curl: (22) The requested URL returned error: 404' >&2; exit 22; fi`,
      'cp "$file" "$out"',
      '',
    ].join('\n'),
  );
  await chmod(join(stubs, 'curl'), 0o755);
  return { dir, out: join(dir, 'out'), curlLog, env: { PATH: `${stubs}:${PATH}` }, name, sha };
}

test('fetch-node.sh downloads only the Node tarball from nodejs.org over https, and unpacks it when it matches the pinned sha256', async () => {
  const d = await nodeDist((name, sha) => `${sha}  ${name}\n`);
  const result = await sh('fetch-node.sh', ['24.0.0', 'x64', d.sha, d.out], d.env);
  assert.deepEqual(result, { code: 0, stdout: `fetch-node.sh: ${d.name}.tar.xz matches its pinned sha256 ${d.sha}; unpacked it into ${d.out}/${d.name}\n`, stderr: '' });
  assert.deepEqual((await readFile(d.curlLog, 'utf8')).split('\n').filter(Boolean), [`-fsSL --proto =https --tlsv1.2 -o ${d.out}/${d.name}.tar.xz ${DIST}/v24.0.0/${d.name}.tar.xz`]);
  assert.equal(await readFile(join(d.out, d.name, 'bin', 'node'), 'utf8'), '#!/bin/sh\necho fake node\n');
  assert.deepEqual(await readdir(d.out), [d.name]);
});

test('fetch-node.sh unpacks nothing when the tarball differs from the pinned sha256, even when the SHASUMS256.txt served beside it agrees with the tarball', async () => {
  const pinned = '0'.repeat(64);
  const d = await nodeDist((name, sha) => `${sha}  ${name}\n`);
  const result = await sh('fetch-node.sh', ['24.0.0', 'x64', pinned, d.out], d.env);
  assert.deepEqual(result, {
    code: 1,
    stdout: '',
    stderr: `fetch-node.sh: ${d.name}.tar.xz does not match its pinned sha256 (expected ${pinned}, got ${d.sha}); nothing was unpacked\n`,
  });
  assert.deepEqual(await readdir(d.out), []);
});

test('fetch-node.sh downloads nothing when the pinned sha256 is missing or is not 64 lowercase hex digits', async () => {
  const d = await nodeDist((name, sha) => `${sha}  ${name}\n`);
  for (const pinned of ['', d.sha.slice(1), d.sha.toUpperCase(), `${d.sha};id`, ` ${d.sha}`]) {
    assert.deepEqual(
      await sh('fetch-node.sh', ['24.0.0', 'x64', pinned, d.out], d.env),
      { code: 1, stdout: '', stderr: `fetch-node.sh: no pinned sha256 for ${d.name}.tar.xz ("${pinned}" is not 64 lowercase hex digits); nothing was downloaded\n` },
      pinned,
    );
  }
  assert.equal(await exists(d.curlLog), false);
  assert.equal(await exists(d.out), false);
});

test('fetch-node.sh refuses a version or architecture it does not build', async () => {
  const usage = 'usage: fetch-node.sh <node-version, such as 24.22.3> <x64|arm64> <pinned sha256 of its tarball> <out-dir>\n';
  const sha = 'a'.repeat(64);
  for (const args of [['24.0.0', 'armv7l', sha, '/nowhere'], ['24', 'x64', sha, '/nowhere'], ['24.0.0;id', 'x64', sha, '/nowhere'], ['24.0.0', 'x64', '/nowhere'], ['24.0.0', 'x64', sha]]) {
    assert.deepEqual(await sh('fetch-node.sh', args), { code: 2, stdout: '', stderr: usage }, args.join(' '));
  }
});

/** Runs check-glibc.sh on a file with an objdump stub that prints `dump` (and exits `status`). */
async function checkGlibc(dump: string, status = 0): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const dir = await fresh();
  await mkdir(join(dir, 'stubs'));
  await writeFile(join(dir, 'dump.txt'), dump);
  await writeFile(join(dir, 'stubs', 'objdump'), `#!/bin/sh\n[ "$1" = -T ] || exit 9\ncat '${join(dir, 'dump.txt')}'\nexit ${status}\n`);
  await chmod(join(dir, 'stubs', 'objdump'), 0o755);
  await writeFile(join(dir, 'pty.node'), '');
  return sh('check-glibc.sh', [join(dir, 'pty.node')], { PATH: `${join(dir, 'stubs')}:${PATH}` });
}

const symbol = (version: string, name: string) => `0000000000000000      DF *UND*  0000000000000000 (GLIBC_${version}) ${name}\n`;

test('check-glibc.sh passes an addon whose newest glibc symbol version is 2.28 or older, and names it', async () => {
  const dump = symbol('2.2.5', 'malloc') + symbol('2.17', 'clock_gettime') + symbol('2.28', 'fcntl64') + '0000 g DF .text 0000 Base napi_register_module_v1\n';
  assert.deepEqual(await checkGlibc(dump), { code: 0, stdout: 'check-glibc.sh: pty.node needs glibc 2.28 at most\n', stderr: '' });
  assert.deepEqual(await checkGlibc(symbol('2.17', 'malloc')), { code: 0, stdout: 'check-glibc.sh: pty.node needs glibc 2.17 at most\n', stderr: '' });
});

test('check-glibc.sh stops on an addon that needs a glibc newer than 2.28', async () => {
  for (const version of ['2.29', '2.34', '3.0']) {
    assert.deepEqual(await checkGlibc(symbol('2.17', 'malloc') + symbol(version, 'newer')), { code: 1, stdout: '', stderr: `check-glibc.sh: pty.node needs glibc ${version}, newer than 2.28\n` }, version);
  }
});

test('check-glibc.sh stops with a clear message when the addon names no glibc symbol version, or objdump fails', async () => {
  assert.deepEqual(await checkGlibc('0000 g DF .text 0000 Base napi_register_module_v1\n'), {
    code: 1,
    stdout: '',
    stderr: 'check-glibc.sh: objdump -T lists no GLIBC_ symbol version in pty.node, so its glibc baseline cannot be checked; is it a Linux addon linked against glibc?\n',
  });
  const failed = await checkGlibc('', 1);
  assert.equal(failed.code, 1);
  assert.equal(failed.stdout, '');
  assert.equal(failed.stderr, 'check-glibc.sh: objdump -T could not read pty.node (see above), so its glibc baseline cannot be checked\n');
});

interface Smoke {
  dir: string;
  archive: string;
  dockerLog: string;
  summary: string;
  env: NodeJS.ProcessEnv;
}

/**
 * A 1.5 MiB archive and a docker stub standing in for the containers: it logs its arguments, and writes the
 * result file smoke-in-container.sh writes into the folder mounted on /out. An image whose name has `broken`
 * in it stops after the unpack with exit 3, as a failing doctor would.
 */
async function smokeBox(): Promise<Smoke> {
  const dir = await fresh();
  const stubs = join(dir, 'stubs');
  const dockerLog = join(dir, 'docker.log');
  await mkdir(join(dir, 'dist'));
  const archive = join(dir, 'dist', 'mirador-0.2.0-linux-x64.tar.gz');
  await writeFile(archive, Buffer.alloc(1.5 * 1024 * 1024));
  await mkdir(stubs);
  await writeFile(
    join(stubs, 'docker'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${dockerLog}'`,
      'out= image= prev=',
      'for arg in "$@"; do',
      '  case "$arg" in *:/out) [ "$prev" = -v ] && out="${arg%:/out}" ;; esac',
      '  case "$arg" in *:*@sha256:* | *broken*) image="$arg" ;; esac',
      '  prev="$arg"',
      'done',
      'echo "container output for ${image%@*}"',
      'case "$image" in',
      '  *broken*) printf "glibc=2.28\\nunpack_ms=120\\n" > "$out/result"; exit 3 ;;',
      '  almalinux*) printf "glibc=2.28\\nunpack_ms=120\\ndoctor_ms=800\\nstart_ms=1500\\n" > "$out/result" ;;',
      '  *) printf "glibc=2.41\\nunpack_ms=95\\ndoctor_ms=640\\nstart_ms=1210\\n" > "$out/result" ;;',
      'esac',
      '',
    ].join('\n'),
  );
  await chmod(join(stubs, 'docker'), 0o755);
  const summary = join(dir, 'summary.md');
  return { dir, archive, dockerLog, summary, env: { PATH: `${stubs}:${PATH}`, GITHUB_STEP_SUMMARY: summary } };
}

const OLDEST = `almalinux:8@sha256:${'7'.repeat(64)}`;
const CURRENT = `debian:13-slim@sha256:${'a'.repeat(64)}`;
const TABLE_HEAD = '| Container | glibc | Unpack | Doctor | Server start | Result |\n| --- | --- | --- | --- | --- | --- |\n';

/** The docker log with each run's /out folder, a fresh temporary folder, written as <out>. */
const dockerRuns = async (log: string) => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map((line) => line.replace(/-v \S+:\/out /, '-v <out>:/out '));

test('smoke.sh checks the archive in each container, read-only and offline, and writes its size and timings to the job summary', async () => {
  const s = await smokeBox();
  const result = await sh('smoke.sh', [s.archive, OLDEST, CURRENT], s.env);
  const table =
    '### mirador-0.2.0-linux-x64.tar.gz\n\nSize: 1.5 MiB (1572864 bytes)\n\n' +
    TABLE_HEAD +
    '| almalinux:8 | 2.28 | 120 ms | 800 ms | 1500 ms | ok |\n' +
    '| debian:13-slim | 2.41 | 95 ms | 640 ms | 1210 ms | ok |\n';
  assert.deepEqual(result, { code: 0, stdout: `container output for almalinux:8\ncontainer output for debian:13-slim\n\n${table}`, stderr: '' });
  assert.equal(await readFile(s.summary, 'utf8'), table);
  const user = `${process.getuid!()}:${process.getgid!()}`;
  const mounts = `-v ${s.archive}:/archive/mirador-0.2.0-linux-x64.tar.gz:ro -v ${SCRIPTS.replace(/\/$/, '')}:/release:ro -v <out>:/out`;
  assert.deepEqual(
    await dockerRuns(s.dockerLog),
    [OLDEST, CURRENT].map((image) => `run --rm --init --network none --user ${user} -e HOME=/tmp/home ${mounts} ${image} sh /release/smoke-in-container.sh /archive/mirador-0.2.0-linux-x64.tar.gz`),
  );
});

test('smoke.sh still checks the other containers when one fails, marks it failed in the summary, and exits 1', async () => {
  const s = await smokeBox();
  const result = await sh('smoke.sh', [s.archive, 'broken:1', CURRENT], s.env);
  const table =
    '### mirador-0.2.0-linux-x64.tar.gz\n\nSize: 1.5 MiB (1572864 bytes)\n\n' +
    TABLE_HEAD +
    '| broken:1 | 2.28 | 120 ms | - | - | failed (exit 3) |\n' +
    '| debian:13-slim | 2.41 | 95 ms | 640 ms | 1210 ms | ok |\n';
  assert.deepEqual(result, {
    code: 1,
    stdout: `container output for broken:1\ncontainer output for debian:13-slim\n\n${table}`,
    stderr: 'smoke.sh: mirador-0.2.0-linux-x64.tar.gz failed in broken:1 (exit 3); see its output above\n',
  });
  assert.equal(await readFile(s.summary, 'utf8'), table);
  assert.equal((await dockerRuns(s.dockerLog)).length, 2);
});

test('smoke.sh refuses a missing or misnamed archive, or no container, and runs nothing', async () => {
  const s = await smokeBox();
  const usage = 'usage: smoke.sh <mirador-<version>-linux-<x64|arm64>.tar.gz> <image>...\n';
  assert.deepEqual(await sh('smoke.sh', [s.archive], s.env), { code: 2, stdout: '', stderr: usage });
  assert.deepEqual(await sh('smoke.sh', [], s.env), { code: 2, stdout: '', stderr: usage });
  const misnamed = join(s.dir, 'dist', 'mirador.tar.gz');
  await writeFile(misnamed, '');
  for (const archive of [join(s.dir, 'dist', 'mirador-0.2.0-linux-riscv.tar.gz'), misnamed, join(s.dir, 'nowhere', 'mirador-0.2.0-linux-x64.tar.gz')]) {
    assert.deepEqual(await sh('smoke.sh', [archive, CURRENT], s.env), { code: 2, stdout: '', stderr: `smoke.sh: ${archive} is not a mirador-<version>-linux-<x64|arm64>.tar.gz file\n` }, archive);
  }
  assert.equal(await exists(s.dockerLog), false);
  assert.equal(await exists(s.summary), false);
});

/**
 * A tiny archive of the shape smoke-in-container.sh expects, and the folders it would find mounted
 * in a container: `bin/mirador` and `node/bin/node` are stubs that log their arguments and print a
 * link, and `src/doctor.ts` is empty. `script` overrides one stub's body so a failure path can be run.
 */
async function smokeKit(overrides: Record<string, string> = {}) {
  const dir = await fresh();
  const archive = join(dir, 'mirador-0.2.0-linux-x64.tar.gz');
  const root = join(dir, 'unpack');
  const app = join(root, 'mirador-0.2.0-linux-x64');
  const out = join(dir, 'out');
  const home = join(dir, 'home');
  const work = join(dir, 'work');
  for (const sub of ['bin', 'node/bin', 'src']) await mkdir(join(app, sub), { recursive: true });
  await mkdir(out, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(app, 'src', 'doctor.ts'), '');
  const stubs: Record<string, string> = {
    'bin/mirador': overrides.mirador ?? 'echo "http://127.0.0.1:7878/#launch=NONCE123"\n',
    'node/bin/node': overrides.node ?? 'exit 0\n',
  };
  for (const [rel, body] of Object.entries(stubs)) {
    await writeFile(join(app, rel), `#!/bin/sh\n${body}`);
    await chmod(join(app, rel), 0o755);
  }
  await execFile('tar', ['-czf', archive, '-C', root, 'mirador-0.2.0-linux-x64']);
  return { dir, archive, out, home, work };
}

/**
 * Runs smoke-in-container.sh with the folders a container would mount, without a container.
 *
 * `getconf`, the first thing the script calls, answers the host's glibc in a container; here it is a
 * stub, so the run reaches the paths under test without depending on this machine's libc.
 */
async function runSmoke(kit: { dir: string; archive: string; out: string; home: string; work: string }) {
  const dir = await fresh();
  const bin = join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  for (const tool of ['sh', 'tar', 'mkdir', 'cat', 'tail', 'date', 'uname', 'grep', 'head', 'rm']) {
    // Only link a tool that exists: a dangling symlink makes the PATH entry unusable, which looks
    // exactly like a missing tool and sends the run somewhere else.
    for (const base of ['/usr/bin', '/bin']) {
      const from = join(base, tool);
      if (!existsSync(from)) continue;
      await symlink(from, join(bin, tool));
      break;
    }
  }
  await writeFile(join(bin, 'getconf'), '#!/bin/sh\necho "glibc 2.28"\n');
  await chmod(join(bin, 'getconf'), 0o755);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn('/bin/sh', [join(SCRIPTS, 'smoke-in-container.sh'), kit.archive], {
      cwd: kit.dir,
      env: { PATH: bin, HOME: kit.home, SMOKE_OUT: kit.out, SMOKE_WORK: kit.work },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('smoke-in-container.sh prints the server log tail when a start fails, and says why (#57)', async () => {
  // bin/mirador starts nothing and writes the log a crashed server leaves, as on the oldest glibc.
  const kit = await smokeKit({
    mirador: 'mkdir -p "$HOME/.local/state/mirador" && printf "boot: glibc 2.28 too old\n" > "$HOME/.local/state/mirador/server.log" && exit 1',

  });
  const run = await runSmoke(kit);
  assert.equal(run.code, 1, `stdout=${run.stdout} stderr=${run.stderr}`);
  assert.match(run.stderr, /smoke: bin\/mirador did not start the server/);
  assert.match(run.stderr, /boot: glibc 2.28 too old/, 'the log tail is missing');
});
