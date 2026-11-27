// The release workflow (.github/workflows/release.yml) builds the prebuilt Linux archives of a tag and attaches
// them to a draft GitHub release; a person publishes it. These checks read the file as text: the trigger, the
// environment the publishing job waits behind, least-privilege permissions, a draft and never a published
// release, the provenance attestation, the glibc 2.28 build container, the Node tarball's sha256 pinned per
// architecture, the smoke job that publish waits for, and the actions test.yml also uses pinned to the same
// commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const WORKFLOW = read('.github/workflows/release.yml');
const TEST_WORKFLOW = read('.github/workflows/test.yml');

/** The file without its comment lines, so that a comment never satisfies a check. */
const code = (text: string) =>
  text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

/** The top-level section `name:` (its lines up to the next top-level key). */
function section(text: string, name: string): string {
  const match = new RegExp(`^${name}:.*\\n((?:(?:[ \\t].*)?\\n)*)`, 'm').exec(code(text));
  assert.ok(match, `no top-level ${name}:`);
  return match[0];
}

/** Each job's id and text, from the jobs: section. */
function jobs(text: string): Map<string, string> {
  const body = section(text, 'jobs');
  const found = new Map<string, string>();
  for (const match of body.matchAll(/^ {2}([\w-]+):\n((?: {3,}.*\n|\s*\n)*)/gm)) found.set(match[1], match[2]);
  return found;
}

/** The `uses:` references of a workflow, as `owner/repo@ref # comment`. */
const uses = (text: string) => [...code(text).matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm)].map((m) => ({ ref: m[1], comment: m[2].trim() }));

/** Every line of a `run:` step, single-line or block. */
function runLines(text: string): string[] {
  const out: string[] = [];
  const lines = code(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)(?:- )?run: ?(.*)$/.exec(lines[i]);
    if (!match) continue;
    if (!/^[|>]/.test(match[2])) {
      out.push(match[2]);
      continue;
    }
    const indent = match[1].length;
    while (i + 1 < lines.length && (lines[i + 1].trim() === '' || /^\s*/.exec(lines[i + 1])![0].length > indent)) out.push(lines[++i]);
  }
  return out;
}

const JOBS = jobs(WORKFLOW);
const releaseJobs = [...JOBS].filter(([, body]) => /^ {4}environment: release$/m.test(body));

/** A job's text, which must exist. */
function job(id: string): string {
  const body = JOBS.get(id);
  assert.ok(body !== undefined, `no job ${id} (jobs: ${[...JOBS.keys()].join(', ')})`);
  return body;
}

/** The `needs:` of a job, as a list of job ids. */
function needs(body: string): string[] {
  const match = /^ {4}needs: (?:\[(.*)\]|(\S+))$/m.exec(body);
  return match ? (match[1] ?? match[2]).split(',').map((id) => id.trim()) : [];
}

/** The architectures and runners of a job's matrix, as `arch runner` lines. */
const matrix = (body: string) => [...body.matchAll(/- arch: (\S+)\n {12}runner: (\S+)\n/g)].map((m) => `${m[1]} ${m[2]}`);

test('it runs on a pushed v* tag, or by hand for a tag given as input', () => {
  const on = section(WORKFLOW, 'on');
  assert.match(on, /^ {2}push:\n {4}tags:\n {6}- 'v\*'\n/m);
  assert.match(on, /^ {2}workflow_dispatch:\n {4}inputs:\n {6}tag:\n(?: {8}.*\n)*? {8}required: true\n/m);
  assert.doesNotMatch(on, /pull_request|branches:/);
});

test('one job publishes, behind the release environment, and only it can write', () => {
  assert.match(code(WORKFLOW), /^permissions: \{\}$/m, 'the workflow grants nothing by default');
  assert.equal(releaseJobs.length, 1, `jobs behind environment: release: ${releaseJobs.map(([id]) => id).join(', ')}`);
  const [id, body] = releaseJobs[0];
  assert.match(body, /^ {4}permissions:\n {6}contents: write\n {6}id-token: write\n {6}attestations: write\n(?! {6})/m);
  assert.match(body, /gh release create/);
  for (const [other, text] of JOBS) {
    if (other === id) continue;
    assert.match(text, /^ {4}permissions:\n {6}contents: read\n(?! {6})/m, `${other} must read only`);
    assert.doesNotMatch(text, /gh release|environment:/, other);
  }
});

test('the publishing job waits for every build and creates a draft release, and nothing ever publishes one', () => {
  const [, body] = releaseJobs[0];
  const builds = [...JOBS.keys()].filter((id) => id !== releaseJobs[0][0]);
  assert.ok(builds.length > 0);
  assert.match(body, new RegExp(`^ {4}needs: (?:${builds.join('|')}|\\[${builds.join(', ')}\\])$`, 'm'));
  const creates = runLines(WORKFLOW).filter((line) => /gh release create/.test(line));
  assert.equal(creates.length, 1, creates.join('\n'));
  assert.match(creates[0], /--draft\b/);
  assert.match(creates[0], /--verify-tag\b/);
  assert.doesNotMatch(code(WORKFLOW), /gh release (?:edit|delete|upload)|--draft=false|draft: false|make_latest|gh api/);
});

/** The `run:` script of the step named `name`, without its block indentation. */
function stepScript(text: string, name: string): string {
  const lines = code(text).split('\n');
  const at = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.ok(at >= 0, `no step ${name}`);
  const runAt = lines.findIndex((line, i) => i > at && /^\s*run: \|$/.test(line));
  assert.ok(runAt > at, `step ${name} has no run block`);
  const indent = /^\s*/.exec(lines[runAt])![0].length;
  const body: string[] = [];
  for (let i = runAt + 1; i < lines.length && (lines[i].trim() === '' || /^\s*/.exec(lines[i])![0].length > indent); i++) body.push(lines[i]);
  const margin = Math.min(...body.filter((line) => line.trim()).map((line) => /^\s*/.exec(line)![0].length));
  return body.map((line) => line.slice(margin)).join('\n') + '\n';
}

/** Runs the "Create the draft release" step for `tag` with a stand-in gh, and returns the arguments gh got and the notes body. */
function runDraftRelease(tag: string): { args: string[]; notes: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mirador-release-step-'));
  try {
    mkdirSync(join(dir, 'dist'));
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(dir, 'scripts', 'release'), { recursive: true });
    cpSync(fileURLToPath(new URL('../scripts/release/pins.sh', import.meta.url)), join(dir, 'scripts', 'release', 'pins.sh'));
    const version = tag.slice(1);
    writeFileSync(join(dir, 'dist', 'SHA256SUMS'), `${'a'.repeat(64)}  mirador-${version}-linux-x64.tar.gz\n${'b'.repeat(64)}  mirador-${version}-linux-arm64.tar.gz\n`);
    writeFileSync(join(dir, 'bin', 'gh'), '#!/bin/sh\nfor arg in "$@"; do printf \'%s\\n\' "$arg"; done > "$GH_ARGS"\n');
    chmodSync(join(dir, 'bin', 'gh'), 0o755);
    writeFileSync(join(dir, 'step.sh'), stepScript(WORKFLOW, 'Create the draft release'));
    execFileSync('sh', ['-eu', 'step.sh'], {
      cwd: dir,
      env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, TAG: tag, GITHUB_SHA: 'f'.repeat(40), GITHUB_REPOSITORY: 'owner/mirador', GH_ARGS: join(dir, 'gh-args') },
      stdio: 'pipe',
    });
    return {
      args: readFileSync(join(dir, 'gh-args'), 'utf8').split('\n').slice(0, -1),
      notes: readFileSync(join(dir, 'notes.md'), 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The arguments gh got, for the tests that only look at the flags. */
function draftReleaseArgs(tag: string): string[] {
  return runDraftRelease(tag).args;
}

test('a tag with a pre-release suffix makes a draft pre-release, so a candidate never becomes the latest release', () => {
  for (const tag of ['v0.2.0-rc.2', 'v1.0.0-beta.1']) {
    const args = draftReleaseArgs(tag);
    assert.deepEqual(args.slice(0, 2), ['release', 'create'], args.join(' '));
    assert.equal(args[2], tag);
    assert.ok(args.includes('--draft'), `${tag}: ${args.join(' ')}`);
    assert.ok(args.includes('--prerelease'), `${tag}: ${args.join(' ')}`);
    assert.ok(args.includes('--verify-tag'), `${tag}: ${args.join(' ')}`);
  }
});

test('a plain vX.Y.Z tag makes a normal draft release, not a pre-release', () => {
  const args = draftReleaseArgs('v0.2.0');
  assert.deepEqual(args, ['release', 'create', 'v0.2.0', '--draft', '--verify-tag', '--title', 'Mirador v0.2.0', '--notes-file', 'notes.md', 'dist/mirador-*.tar.gz', 'dist/SHA256SUMS']);
});

// A published release keeps the draft's notes verbatim, so the first line reaches the people who
// download the archive. "Review it before publishing it" is addressed to the maintainer and reads as
// a leftover instruction once the release is public (#98).
test('the notes open with a line addressed to the reader, not to the maintainer reviewing the draft', () => {
  for (const tag of ['v0.2.0', 'v0.3.0-rc.1']) {
    const first = runDraftRelease(tag).notes.split('\n')[0];
    assert.ok(first, `${tag}: empty notes`);
    assert.doesNotMatch(first, /review it before publishing/i, `${tag}: ${first}`);
    assert.doesNotMatch(first, /\(docs\/releasing\.md\)/, `${tag}: ${first}`);
    assert.match(first, /built by the release workflow/i, `${tag}: ${first}`);
  }
});

test('any pre-release suffix check-tag.sh accepts makes a pre-release; a plain version with large numbers does not', () => {
  for (const tag of ['v0.2.0-rc.10', 'v2.0.0-alpha', 'v1.0.0-0']) assert.ok(draftReleaseArgs(tag).includes('--prerelease'), tag);
  assert.ok(!draftReleaseArgs('v10.20.30').includes('--prerelease'), 'v10.20.30');
});

test('every archive gets a build-provenance attestation, and SHA256SUMS lists them all', () => {
  const [, body] = releaseJobs[0];
  assert.match(body, /- uses: actions\/attest-build-provenance@\S+.*\n {8}with:\n {10}subject-path: '?dist\/mirador-\*\.tar\.gz'?\n/);
  assert.ok(runLines(body).some((line) => /sha256sum mirador-\*\.tar\.gz > SHA256SUMS/.test(line)), 'no SHA256SUMS step');
  const create = runLines(body).find((line) => /gh release create/.test(line))!;
  assert.match(create, /dist\/mirador-\*\.tar\.gz dist\/SHA256SUMS/);
});

test('the builds make linux-x64 and linux-arm64 on GitHub-hosted runners inside a glibc 2.28 container, from the official Node checked against its pinned sha256', () => {
  const body = job('build');
  assert.deepEqual(matrix(body), ['x64 ubuntu-24.04', 'arm64 ubuntu-24.04-arm']);
  assert.match(body, /- arch: x64\n {12}runner: ubuntu-24\.04\n/);
  assert.match(body, /- arch: arm64\n {12}runner: ubuntu-24\.04-arm\n/);
  assert.match(body, /^ {4}runs-on: \$\{\{ matrix\.runner \}\}$/m);
  assert.match(section(WORKFLOW, 'env'), /^ {2}BUILD_IMAGE: almalinux:8(?:@sha256:[0-9a-f]{64})?$/m);
  assert.match(section(WORKFLOW, 'env'), /^ {2}NODE_VERSION: 24\.\d+\.\d+$/m);
  const steps = runLines(body).join('\n');
  assert.match(steps, /sh scripts\/release\/check-tag\.sh "\$TAG" package\.json/);
  assert.match(steps, /sh scripts\/release\/fetch-node\.sh "\$NODE_VERSION" "\$ARCH" /);
  assert.match(steps, /sh scripts\/release\/build-linux\.sh /);
});

test('NODE_VERSION sits beside the pinned sha256 of the Node tarball of each built architecture, and the build passes its own to fetch-node.sh', () => {
  const env = section(WORKFLOW, 'env');
  const pins = /^ {2}NODE_VERSION: 24\.\d+\.\d+\n {2}NODE_SHA256_LINUX_X64: ([0-9a-f]{64})\n {2}NODE_SHA256_LINUX_ARM64: ([0-9a-f]{64})$/m.exec(env);
  assert.ok(pins, `NODE_VERSION, NODE_SHA256_LINUX_X64 and NODE_SHA256_LINUX_ARM64 must be consecutive lines of env:\n${env}`);
  assert.notEqual(pins[1], pins[2], 'each architecture has its own tarball and sum');
  const body = job('build');
  const archs = matrix(body).map((line) => line.split(' ')[0]);
  assert.deepEqual(archs, ['x64', 'arm64']);
  const steps = runLines(body).map((line) => line.trim());
  for (const arch of archs) assert.ok(steps.includes(`${arch}) pinned="$NODE_SHA256_LINUX_${arch.toUpperCase()}" ;;`), `the ${arch} build picks NODE_SHA256_LINUX_${arch.toUpperCase()}:\n${steps.join('\n')}`);
  assert.ok(steps.includes('sh scripts/release/fetch-node.sh "$NODE_VERSION" "$ARCH" "$pinned" "$RUNNER_TEMP/node"'), steps.join('\n'));
});

test('a smoke job checks each archive in clean containers after build and before publish, reading only the repository and using no secrets', () => {
  const smoke = job('smoke');
  assert.deepEqual(needs(smoke), ['build']);
  assert.ok(needs(releaseJobs[0][1]).includes('smoke'), `publish needs: ${needs(releaseJobs[0][1]).join(', ')}`);
  assert.match(smoke, /^ {4}permissions:\n {6}contents: read\n(?! {6})/m);
  assert.doesNotMatch(smoke, /secrets\.|github\.token|GH_TOKEN|environment:/);
  // An arm64 archive is checked on an arm64 runner, as it was built.
  assert.deepEqual(matrix(smoke), matrix(job('build')));
  assert.match(smoke, /^ {4}runs-on: \$\{\{ matrix\.runner \}\}$/m);
  assert.match(smoke, /- uses: actions\/download-artifact@\S+.*\n {8}with:\n {10}name: mirador-linux-\$\{\{ matrix\.arch \}\}\n/);
  // The oldest glibc supported is the build's own glibc 2.28 base image, bare; the current distribution is pinned by digest.
  assert.match(section(WORKFLOW, 'env'), /^ {2}CURRENT_IMAGE: [\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/m);
  const steps = runLines(smoke).map((line) => line.trim());
  assert.ok(steps.includes('sh scripts/release/smoke.sh "$RUNNER_TEMP/dist/mirador-${TAG#v}-linux-$ARCH.tar.gz" "$BUILD_IMAGE" "$CURRENT_IMAGE"'), steps.join('\n'));
});

test('no run step expands an expression, so a tag name never becomes shell code', () => {
  for (const line of runLines(WORKFLOW)) assert.doesNotMatch(line, /\$\{\{/, line);
});

test('every job has a timeout and every checkout keeps no credentials', () => {
  for (const [id, body] of JOBS) {
    assert.match(body, /^ {4}timeout-minutes: \d+$/m, id);
    for (const match of body.matchAll(/- uses: actions\/checkout@.*\n((?: {8}.*\n)*)/g)) assert.match(match[1], /persist-credentials: false/, id);
  }
});

test('the actions test.yml also uses are pinned to the same commit SHA and version', () => {
  const pinned = new Map(uses(TEST_WORKFLOW).map(({ ref, comment }) => [ref.split('@')[0], `${ref} ${comment}`]));
  const shared = uses(WORKFLOW).filter(({ ref }) => pinned.has(ref.split('@')[0]));
  assert.ok(shared.length >= 3, shared.map(({ ref }) => ref).join(', '));
  for (const { ref, comment } of shared) assert.equal(`${ref} ${comment}`, pinned.get(ref.split('@')[0]));
});

// That every action of every workflow is pinned to a full commit SHA with its release tag in a comment is
// checked for all workflows at once in test/community-docs.test.ts.
