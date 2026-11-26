// Public release T8: the community files a new contributor expects (code of conduct, issue and pull request
// templates), GitHub Actions pinned by commit SHA and kept up to date by dependabot (L25), and a section on
// the Gentle names a reader meets in the code: gentle-ai, Engram, gentle-deck and bin/herdr-shim, in
// CONTRIBUTING.md since S30, linked from the README.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const TEMPLATES = '.github/ISSUE_TEMPLATE';
const WORKFLOWS = '.github/workflows';
// Joined from pieces, as in scripts/export-scan.ts.
const CONTACT = ['contacto', 'zurai.cl'].join('@');

/** The lines of a Markdown file under the `## <title>` heading, up to the next heading of level 1 or 2. */
function section(text: string, title: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && /^#{1,2} /.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

test('CODE_OF_CONDUCT.md exists, gives the contact address for reports, and CONTRIBUTING.md links it', () => {
  assert.ok(existsSync(join(ROOT, 'CODE_OF_CONDUCT.md')), 'CODE_OF_CONDUCT.md is missing');
  assert.ok(read('CODE_OF_CONDUCT.md').includes(CONTACT), 'the code of conduct names the address that takes reports');
  assert.match(read('CONTRIBUTING.md'), /\]\(CODE_OF_CONDUCT\.md\)/);
});

test('issue templates for a bug and a feature request, and a pull request template, exist under .github/', () => {
  const issues = existsSync(join(ROOT, TEMPLATES)) ? readdirSync(join(ROOT, TEMPLATES)) : [];
  assert.ok(issues.some((name) => /^bug/.test(name) && /\.(md|ya?ml)$/.test(name)), `no bug template in ${TEMPLATES}: ${issues.join(', ')}`);
  assert.ok(issues.some((name) => /^feature/.test(name) && /\.(md|ya?ml)$/.test(name)), `no feature template in ${TEMPLATES}: ${issues.join(', ')}`);
  assert.ok(existsSync(join(ROOT, '.github/pull_request_template.md')), '.github/pull_request_template.md is missing');
});

test('the bug template asks for the doctor report', () => {
  assert.ok(existsSync(join(ROOT, TEMPLATES)), `${TEMPLATES} is missing`);
  const bug = readdirSync(join(ROOT, TEMPLATES)).find((name) => /^bug/.test(name));
  assert.ok(bug, 'no bug template');
  assert.ok(read(`${TEMPLATES}/${bug}`).includes('pnpm run doctor --report'));
});

test('.github/dependabot.yml updates the github-actions ecosystem from the repository root', () => {
  const path = '.github/dependabot.yml';
  assert.ok(existsSync(join(ROOT, path)), `${path} is missing`);
  const config = read(path);
  assert.match(config, /^version: 2$/m);
  assert.match(config, /^\s*- package-ecosystem: "?github-actions"?$/m);
  assert.match(config, /^\s*directory: "?\/"?$/m);
  assert.match(config, /^\s*interval: "?(daily|weekly|monthly)"?$/m);
});

test('every uses: in .github/workflows/*.yml is pinned to a 40-hex commit SHA with a trailing # vX.Y.Z comment', () => {
  const files = readdirSync(join(ROOT, WORKFLOWS)).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(files.length > 0, 'no workflow files');
  const uses: string[] = [];
  const unpinned: string[] = [];
  for (const file of files) {
    read(`${WORKFLOWS}/${file}`).split('\n').forEach((line, index) => {
      if (!/^\s*(?:-\s+)?uses:/.test(line)) return;
      uses.push(line);
      if (!/^\s*(?:-\s+)?uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+\s*$/.test(line)) unpinned.push(`${WORKFLOWS}/${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.ok(uses.length > 0, 'no uses: lines found');
  assert.deepEqual(unpinned, []);
});

test('CONTRIBUTING.md has a section that explains gentle-ai, Engram, gentle-deck and bin/herdr-shim, and the README links it', () => {
  const body = section(read('CONTRIBUTING.md'), 'Gentle names in the code');
  assert.ok(body, 'no "## Gentle names in the code" section in CONTRIBUTING.md');
  for (const name of ['gentle-ai', 'Engram', 'gentle-deck', 'bin/herdr-shim']) assert.ok(body.includes(name), `the section does not name ${name}`);
  const readme = read('README.md');
  assert.equal(section(readme, 'Gentle names in the code'), '', 'the section left the README');
  assert.ok(section(readme, 'Development').includes('[Gentle names](CONTRIBUTING.md#gentle-names-in-the-code)'), 'Development does not link the section');
  assert.ok(section(readme, 'How Mirador compares').includes('[`bin/herdr-shim`](CONTRIBUTING.md#gentle-names-in-the-code)'), 'the Herdr paragraph does not link the section');
});

test('the README says what Mirador focuses on, not what other dashboards lack, and points to the ssh -L tunnel and its risks', () => {
  const readme = read('README.md');
  const why = section(readme, 'Why Mirador');
  assert.ok(why.includes('What Mirador focuses on'), 'the Why Mirador lead-in is "What Mirador focuses on"');
  assert.ok(!/other agent dashboards do not/.test(readme), 'no claim of what other dashboards do not do');
  assert.ok(readme.includes('(docs/security.md#opening-mirador-from-another-machine)'), 'the README points to the tunnel section');
  const tunnel = section(read('docs/security.md'), 'Opening Mirador from another machine');
  assert.ok(tunnel, 'no "## Opening Mirador from another machine" section in docs/security.md');
  assert.ok(tunnel.includes('ssh -N -L 127.0.0.1:4545:127.0.0.1:4545'), 'the forward is bound to 127.0.0.1 on the client');
  for (const risk of ['-g', '0.0.0.0', 'reverse proxy', 'full terminal access', 'Close the tunnel']) assert.ok(tunnel.includes(risk), `the section does not cover ${risk}`);
});

test('the README compares Mirador with other tools without stars, prices or exclusivity claims', () => {
  const table = section(read('README.md'), 'How Mirador compares');
  assert.ok(table, 'no "## How Mirador compares" section in README.md');
  assert.ok(!/[★⭐]|\$\d|\bstars\b|\bonly one\b|\bthe only\b|\bunique\b/i.test(table), 'stars, prices or an exclusivity claim in the comparison');
  // The data table has the tools as columns, Mirador first, inside <details>.
  const details = table.slice(table.indexOf('<details>'), table.indexOf('</details>'));
  assert.ok(table.indexOf('<details>') >= 0 && table.indexOf('</details>') > table.indexOf('<details>'), 'the data table is inside <details>');
  assert.match(details, /^\| \| \*\*Mirador\*\* \| \[Herdr\]/m, 'the tools are the columns, Mirador first');
  assert.match(details, /^\| License \| Apache-2\.0 \|/m, 'Mirador says Apache-2.0');
  assert.match(details, /^\| Agents in git worktrees \| No \|/m, 'Mirador says no worktrees');
  for (const row of ['Form', 'Platforms', 'License', 'Agents in git worktrees', 'Remote machines and phone']) assert.match(details, new RegExp(`^\\| ${row} \\|`, 'm'), row);
  assert.ok(details.includes('A dash means its official pages do not say, and "No" means they say so'), 'what a dash and "No" mean');
  // The "You want… | Look at" table comes first, with Mirador's rows on top.
  const want = table.split('\n').filter((line) => line.startsWith('| ') && table.indexOf(line) < table.indexOf('<details>'));
  assert.equal(want[0], '| You want… | Look at |');
  const looks = want.slice(1).map((line) => line.split('|').at(-2)?.trim());
  const firstOther = looks.findIndex((look) => look !== 'Mirador');
  assert.ok(firstOther > 0 && looks.slice(firstOther).every((look) => look !== 'Mirador'), `Mirador's rows first: ${looks.join(', ')}`);
  // L21: SSH and a phone app are separate rows, each from the verified cells (Paradev states no SSH, Emdash no phone app).
  const look = (row: string) => table.split('\n').find((line) => line.startsWith(`| ${row} |`))?.split('|').at(-2) ?? '';
  const ssh = look('Remote machines over SSH');
  for (const tool of ['Herdr', 'cmux', 'Emdash', 'Claude Code Desktop']) assert.ok(ssh.includes(tool), `SSH: ${tool}`);
  assert.ok(!ssh.includes('Paradev'), 'SSH: no Paradev');
  const phone = look('A phone app');
  for (const tool of ['Herdr', 'Paradev', 'Claude Code Desktop', 'cmux (iPhone beta)']) assert.ok(phone.includes(tool), `phone: ${tool}`);
  assert.ok(!phone.includes('Emdash'), 'phone: no Emdash');
  assert.ok(!look('A desktop app on Linux').includes('cmux') && !look('A desktop app on Windows').includes('cmux'), 'cmux is macOS only');
  assert.ok(!look('A desktop app on Windows').includes('Paradev'), 'Paradev: Windows is not yet available');
  // L22: Herdr's FAQ: "macOS (Apple silicon), Linux (x86_64 and arm64) and Windows (x86_64)."
  assert.ok(look('A desktop app on macOS').includes('Herdr (Apple silicon)'), 'Herdr on macOS: Apple silicon');
  for (const os of ['Linux', 'Windows']) assert.equal(tools(look(`A desktop app on ${os}`))[0], 'Herdr', `Herdr on ${os}`);
  // L22: Mirador's rows say the need, in this order.
  assert.deepEqual(wantRows(read('README.md')).filter((row) => row.look === 'Mirador').map((row) => row.want), [
    'To see which agent is waiting for you, and where each project left off',
    'Several agents on one machine without filling its memory: a launch gate, idle agents that sleep and, on Linux, one systemd scope per agent',
    'Agents back in their folder and session after a reboot',
    'A tool with no account and no telemetry, listening on 127.0.0.1 only',
    'Any terminal agent or a plain shell, with native gentle-shell, pi and Engram integration',
    'No desktop app to install: a browser window, also inside WSL2',
  ]);
  assert.ok(read('README.md').includes('- **Resource control:** a launch gate for memory, idle agents that sleep and, on Linux, one systemd scope per agent.\n'), 'the second benefit (L22)');
  assert.ok(table.includes('[Herdr](https://herdr.dev) (Apache-2.0) does those today and Mirador does not'), 'the Herdr recommendation sits in the comparison');
});

/** The tool names of a "Look at" cell: top-level comma-separated, without parenthesised notes or backticks. */
function tools(cell: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of `${cell},`) {
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (depth > 0) continue;
    else if (char === ',') {
      const name = current.replaceAll('`', '').trim();
      if (name) names.push(name);
      current = '';
    } else current += char;
  }
  return names;
}

/** The body rows of the first table of the comparison section (the "You want… / Look at" one, before <details>). */
function wantRows(readme: string): { want: string; look: string }[] {
  const lines = readme.split('\n');
  const start = lines.findIndex((line) => line === '## How Mirador compares' || line === '## Cómo se compara Mirador');
  const header = lines.findIndex((line, index) => index > start && line.startsWith('| '));
  const details = lines.findIndex((line, index) => index > start && line.startsWith('<details>'));
  assert.ok(start >= 0 && header > start && header < details, 'the comparison section opens with a table before <details>');
  const end = lines.findIndex((line, index) => index > header && line.trim() === '');
  return lines.slice(header + 2, end).map((line) => {
    const cells = line.split('|');
    return { want: cells[1].trim(), look: cells.at(-2)?.trim() ?? '' };
  });
}

test('README.md and README.es.md name the same tools in the "You want… / Look at" table, row by row (L22)', () => {
  assert.deepEqual(tools('Herdr (iPhone, iPad, Android), cmux (`cmux ssh`)'), ['Herdr', 'cmux']);
  const en = wantRows(read('README.md'));
  const es = wantRows(read('README.es.md'));
  assert.ok(en.length > 0, 'no rows in the English table');
  assert.equal(es.length, en.length, 'the same number of rows');
  en.forEach((row, index) => {
    assert.deepEqual([...tools(es[index].look)].sort(), [...tools(row.look)].sort(), `row ${index + 1}: "${row.want}" / "${es[index].want}"`);
  });
});
