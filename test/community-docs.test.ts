// Public release T8: the community files a new contributor expects (code of conduct, issue and pull request
// templates), GitHub Actions pinned by commit SHA and kept up to date by dependabot (L25), and a section on
// the Gentle names a reader meets in the code: gentle-ai, Engram, gentle-deck and bin/herdr-shim, in
// CONTRIBUTING.md since S30, linked from the README.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS } from '../src/agents/catalog.ts';

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
  // Herdr TUI (herdrdev/herdr) and Herdr app (herdr.dev, herdrdev/herdr-app) are two columns (S4).
  assert.match(details, /^\| \| \*\*Mirador\*\* \| \[Herdr TUI\]\(https:\/\/github\.com\/herdrdev\/herdr\) \| \[Herdr app\]\(https:\/\/herdr\.dev\) \| \[Paradev\]/m, 'the tools are the columns, Mirador first, then Herdr TUI and Herdr app');
  assert.match(details, /^\| License \| Apache-2\.0 \| Apache-2\.0 \| Apache-2\.0 \|/m, 'Mirador, Herdr TUI and Herdr app say Apache-2.0');
  assert.match(details, /^\| Agents in git worktrees \| No \|/m, 'Mirador says no worktrees');
  for (const row of ['Form', 'Platforms', 'License', 'Agents in git worktrees', 'Remote machines and phone', 'Agent sessions after a restart', 'Idle agents put to sleep']) {
    const line = details.split('\n').find((text) => text.startsWith(`| ${row} |`));
    assert.ok(line, row);
    assert.equal(line.split('|').length - 2, 8, `${row}: one cell per tool`);
  }
  // L3: Herdr TUI restores agent sessions by default, the Herdr app FAQ says it does not, cmux resumes with hooks.
  const cells = (row: string) => details.split('\n').find((text) => text.startsWith(`| ${row} |`))?.split('|').slice(2, -1).map((cell) => cell.trim()) ?? [];
  const restart = cells('Agent sessions after a restart');
  assert.match(restart[1], /^On by default/, 'Herdr TUI: on by default');
  assert.match(restart[2], /^No/, 'Herdr app: no');
  const idle = cells('Idle agents put to sleep');
  assert.match(idle[1], /^Plugins/, 'Herdr TUI: community plugins');
  assert.match(idle[5], /^Opt-in/, 'cmux: terminal.agentHibernation, opt-in');
  assert.ok(details.includes('A dash means its official pages do not say, and "No" means they say so'), 'what a dash and "No" mean');
  // The "You want… | Look at" table comes first, with Mirador's rows on top.
  const want = table.split('\n').filter((line) => line.startsWith('| ') && table.indexOf(line) < table.indexOf('<details>'));
  assert.equal(want[0], '| You want… | Look at |');
  const looks = want.slice(1).map((line) => tools(line.split('|').at(-2) ?? ''));
  const firstOther = looks.findIndex((look) => !look.includes('Mirador'));
  assert.ok(firstOther > 0 && looks.slice(0, firstOther).every((look) => look[0] === 'Mirador') && looks.slice(firstOther).every((look) => !look.includes('Mirador')), `Mirador's rows first: ${looks.join(' / ')}`);
  // L21: SSH and a phone app are separate rows, each from the verified cells (Paradev states no SSH, Emdash no phone app).
  const look = (row: string) => table.split('\n').find((line) => line.startsWith(`| ${row} |`))?.split('|').at(-2) ?? '';
  const ssh = look('Remote machines over SSH');
  for (const tool of ['Herdr', 'cmux', 'Emdash', 'Claude Code Desktop']) assert.ok(ssh.includes(tool), `SSH: ${tool}`);
  assert.ok(!ssh.includes('Paradev'), 'SSH: no Paradev');
  assert.deepEqual(tools(ssh).slice(0, 2), ['Herdr TUI', 'Herdr app'], 'SSH: Herdr TUI and Herdr app');
  const phone = look('A phone app');
  for (const tool of ['Herdr app', 'Paradev', 'Claude Code Desktop', 'cmux (iPhone beta)']) assert.ok(phone.includes(tool), `phone: ${tool}`);
  assert.ok(!phone.includes('Emdash') && !phone.includes('Herdr TUI'), 'phone: no Emdash, no Herdr TUI');
  assert.ok(!look('A desktop app on Linux').includes('cmux') && !look('A desktop app on Windows').includes('cmux'), 'cmux is macOS only');
  assert.ok(!look('A desktop app on Windows').includes('Paradev'), 'Paradev: Windows is not yet available');
  // L22: Herdr's FAQ: "macOS (Apple silicon), Linux (x86_64 and arm64) and Windows (x86_64)."
  assert.ok(look('A desktop app on macOS').includes('Herdr app (Apple silicon)'), 'Herdr app on macOS: Apple silicon');
  for (const os of ['Linux', 'Windows']) assert.equal(tools(look(`A desktop app on ${os}`))[0], 'Herdr app', `Herdr app on ${os}`);
  // S4, L3, L5: Mirador's rows say the need, in this order, with the tools whose own docs state it.
  assert.deepEqual(wantRows(read('README.md')).filter((row) => tools(row.look).includes('Mirador')).map((row) => [row.want, tools(row.look)]), [
    ['To see which agent is waiting for you', ['Mirador', 'Herdr', 'Paradev', 'cmux', 'Emdash']],
    ['Where each project left off', ['Mirador']],
    ['Agents back in their session after a restart', ['Mirador', 'Herdr TUI', 'cmux']],
    ['Agents opened in a row that wait for free memory, one systemd scope per agent, and, after a restart, only the agents that had not finished reopened', ['Mirador']],
    ['Idle agents put to sleep to free memory', ['Mirador', 'cmux', 'Herdr TUI']],
    ['A night shift and MCP servers per project for gentle-shell', ['Mirador']],
  ]);
  assert.ok(look('Agents back in their session after a restart').includes('Herdr TUI (on by default)'), 'Herdr TUI restores by default (L3)');
  assert.ok(look('Idle agents put to sleep to free memory').includes('cmux (`terminal.agentHibernation`, opt-in)'), 'cmux hibernation is opt-in (L3)');
  assert.ok(!/18 agents/.test(table), 'no "18 agents" figure (L3)');
  // S5: when each one fits, with herdrdev/herdr#6152 and its date.
  assert.ok(table.includes('Herdr fits if you work across several machines, from your phone, or on macOS or Windows; Mirador fits if everything runs on one Linux or WSL2 machine and memory is the limit.'), 'when each one fits');
  assert.ok(table.includes('[herdrdev/herdr#6152](https://github.com/herdrdev/herdr/issues/6152) ("Add confirmation and a cap for large agent restores")') && table.includes('as not planned on 2026-11-23'), 'the Herdr issue and its date');
  assert.ok(table.includes('Mirador has no relation to Herdr'), 'no relation to Herdr');
});

// S1, S2, L4: the opening says the memory message, the three top bullets come in order, and one exact phrase says
// what sleeps (Pi agents while Mirador runs, every finished agent after a restart) in the top bullet, the memory point
// of "Why Mirador" and the memory row of the comparison, in each README.
const IDLE_SLEEP = {
  'README.md': 'Pi agents finished for 4 h go to sleep ([`idleSleepHours`](docs/resources.md#idle-sleep), configurable), and after a restart every finished agent stays asleep',
  'README.es.md': 'los agentes Pi que llevan 4 h con su turno terminado se duermen ([`idleSleepHours`](docs/resources.md#idle-sleep), configurable), y tras un reinicio todo agente que había terminado sigue dormido',
} as const;

test('the opening and the top bullets put memory first, and one exact idle-sleep phrase appears in its three places (S1, S2)', () => {
  const en = read('README.md');
  assert.ok(en.includes('\nMirador is a local web dashboard for running many coding agents on one Linux or WSL2 machine without filling its memory. It holds back agents opened in a row until there is free memory, leaves finished ones asleep after a restart, and shows where each project left off.\n'), 'the opening');
  const es = read('README.es.md');
  assert.ok(es.includes('\nMirador es un dashboard web local para correr muchos agentes de programación en una máquina Linux o WSL2 sin llenar su memoria.'), 'la apertura');
  assert.equal(JSON.parse(read('package.json')).description, 'Local web dashboard for running many coding agents on one Linux or WSL2 machine without filling its memory.', 'package.json says the same (S7)');
  for (const [file, [memory, leftOff, machine], why, compare] of [
    ['README.md', ['**Memory:**', '**Where it left off:**', '**Stays on the machine:**'], 'Why Mirador', 'How Mirador compares'],
    ['README.es.md', ['**Memoria:**', '**Dónde quedó:**', '**Se queda en la máquina:**'], 'Por qué Mirador', 'Cómo se compara Mirador'],
  ] as const) {
    const text = read(file);
    const phrase = IDLE_SLEEP[file];
    const bullets = text.split('\n').filter((line, index, lines) => line.startsWith('- **') && index < lines.findIndex((l) => l.startsWith('[![test]')));
    assert.deepEqual(bullets.map((line) => line.slice(2, line.indexOf(':**') + 3)), [memory, leftOff, machine], `${file}: the three top bullets`);
    const capital = phrase[0].toUpperCase() + phrase.slice(1);
    assert.ok(bullets[0].includes(phrase) || bullets[0].includes(capital), `${file}: the memory bullet`);
    const points = section(text, why).split('\n').filter((line) => line.startsWith('- **'));
    assert.equal(points.length, 3, `${file}: three points in ${why}`);
    assert.ok(points[0].includes(phrase) || points[0].includes(capital), `${file}: the memory point`);
    assert.ok(points[0].includes('(docs/agents.md#opening-many-agents-without-filling-the-memory)') && points[0].includes('(docs/agents.md#one-systemd-scope-per-terminal)') && /11 \w+/.test(points[0]) && points[0].includes('24 GB') && points[0].includes('systemd-oomd'), `${file}: the gate, the scopes and the measured fact`);
    assert.ok(points[1].includes('(docs/attention.md#where-it-left-off)'), `${file}: where it left off`);
    assert.ok(points[2].includes('(docs/extending.md#night-shift)') && points[2].includes('(docs/agents.md#mcp-servers-per-project)'), `${file}: the night shift and MCP per project`);
    const memoryRow = wantRows(text)[4];
    assert.ok(memoryRow.look.includes(`Mirador (${phrase})`), `${file}: the memory row`);
    const count = (part: string) => text.split(part).length - 1;
    assert.equal(phrase === capital ? count(phrase) : count(phrase) + count(capital), 3, `${file}: the phrase appears exactly in its three places`);
    assert.ok(!section(text, compare).includes('18 agent'), `${file}: no 18 agents`);
  }
  for (const old of ['idle agents that sleep', 'agentes inactivos que se duermen']) {
    for (const file of ['README.md', 'README.es.md']) assert.ok(!read(file).includes(old), `${file}: no "${old}"`);
  }
  assert.ok(read('README.md').includes('| [Night shift](docs/extending.md#night-shift) |'), 'the Night shift row links docs/extending.md#night-shift');
  assert.ok(read('README.es.md').includes('| [Turno de noche](docs/extending.md#night-shift) |'), 'la fila Turno de noche enlaza docs/extending.md#night-shift');
});

/** The body rows of the first table under `## <title>`, as trimmed cells. */
function tableRows(text: string, title: string): string[][] {
  const lines = section(text, title).split('\n');
  const header = lines.findIndex((line) => line.startsWith('| '));
  if (header < 0) return [];
  const end = lines.findIndex((line, index) => index > header && !line.startsWith('|'));
  return lines.slice(header + 2, end < 0 ? undefined : end).map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
}

// S6: "What Mirador does with each agent" is built from src/agents/catalog.ts: one row per entry, in catalog order.
test('README.md and README.es.md list every catalog agent in order, with its binary, attention and resume flag (S6)', () => {
  for (const [file, title, yes, no] of [
    ['README.md', 'What Mirador does with each agent', 'Yes', 'No'],
    ['README.es.md', 'Qué hace Mirador con cada agente', 'Sí', 'No'],
  ] as const) {
    const rows = tableRows(read(file), title);
    assert.deepEqual(rows.map(([label, binary]) => [label, binary]), AGENTS.map((agent) => [agent.label, `\`${agent.binary}\``]), `${file}: one row per catalog agent, in order`);
    rows.forEach(([label, , reports, resumes, sleeps], index) => {
      const agent = AGENTS[index];
      assert.equal(reports, agent.attention === 'hooks' ? yes : no, `${file}: ${label} reports its state`);
      assert.equal(resumes.startsWith('No'), agent.resume === null, `${file}: ${label} resumes exactly when the catalog has a resume argv`);
      if (agent.resume) assert.ok(resumes.startsWith(`\`${agent.resume[0]} <${agent.resumeKey}>\``), `${file}: ${label} names ${agent.resume[0]}`);
      if (agent.attention === 'none') assert.equal(sleeps, no, `${file}: ${label} never reports finished, so it never sleeps`);
      else assert.notEqual(sleeps, no, `${file}: ${label} sleeps at least after a restart`);
    });
  }
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
