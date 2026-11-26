// Public release T1 (S3, L12, L13, L18): scripts/export-scan.ts runs over the extracted export and
// finds the owner's name, home paths, e-mail addresses and the excluded paths outside the allowed places;
// issue and PR numbers are legitimate references in the public repository and are not looked for (L45).
// The matcher cases are synthetic lines; the last test scans a fresh `git archive HEAD`. This file is
// exported and scanned too, so its synthetic hits are put together at run time: the name from escapes
// and the script's letters, paths and addresses from their pieces.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HANDLE, NAME_PARTS, fold, holdsOwnerName, scanText, where, type Entry } from '../scripts/export-scan.ts';
import { listTaskNames, taskNameHits } from '../scripts/export-task-names.ts';
import { ROOT, extractHead, notACheckout } from './helpers/export-archive.ts';

const scratches: string[] = [];
after(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

const cap = (word: string) => word[0].toUpperCase() + word.slice(1);
const FIRST = 'Mat\u00edas';
const LAST = 'Barr\u00eda';
const FULL = `${FIRST} ${LAST}`;
/** Pieces of the synthetic hits: a home folder, an address's @, a reference's #, the repository URL. */
const HOME = '/home';
const USERS = '/Users';
const AT = '@';
const HASH = '#';
const REPO = ['github.com', 'mata-2p', 'mirador'].join('/');
/** The excluded paths (S2), from their pieces: the task folder, the artboards' folder and the informe. */
const TASKS = ['odd', 'tasks'].join('/');
const DESIGN = ['design', ''].join('/');
const INFORME = ['docs', ['informe', '2026-11-11.md'].join('-')].join('/');
/** A task document of this repository by name, from its words, so this file names none itself (L33). */
const REAL = (...words: string[]) => `${words.join('-')}.md`;

/** The hits (not the allowed entries) of `content` as `file`, as `line:kind match`. */
const hits = (file: string, content: string) => scanText(file, content).filter((e) => !e.allowed).map((e) => `${e.line}:${e.kind} ${e.match}`);
/** The allowed entries of `content` as `file`. */
const allowed = (file: string, content: string): Entry[] => scanText(file, content).filter((e) => e.allowed);

test('the name matcher folds accents and case, for the first name and the surname', () => {
  const spellings = [FIRST, 'Mati\u0301as', cap(NAME_PARTS[0]), NAME_PARTS[0].toUpperCase(), 'MAT\u00cdAS', LAST, cap(NAME_PARTS[1]), 'BARR\u00cdA', `isPendingFor${FIRST}`];
  for (const spelling of spellings) assert.ok(holdsOwnerName(spelling), spelling);
  for (const other of ['the user', 'Mathias', 'matiz', 'mat-ias', 'barrio', 'barr']) assert.equal(holdsOwnerName(other), false, other);
  assert.deepEqual(NAME_PARTS.map((part) => part.length), [6, 6]);
  assert.equal(fold(HANDLE), HANDLE);
});

test('the name is allowed only in the L12 places: credits.by.name, the README Author section, package.json author, LICENSE, NOTICE, SPONSORS.md', () => {
  assert.deepEqual(hits('public/i18n/credits.js', `    'credits.by.name': '${FULL}',\n`), []);
  for (const line of [`    'credits.by.text': '${FULL}',`, `    // ${FIRST} wrote this`, `    'credits.by.name': 'ZURAI', // ${FIRST}`]) {
    assert.deepEqual(hits('public/i18n/credits.js', line), [`1:name ${line.trim()}`], line);
  }
  assert.equal(hits('public/features/credits.js', `    'credits.by.name': '${FULL}',`).length, 1, 'only public/i18n/credits.js');

  const readme = `# Mirador\n\n## Author\n\nMirador is created by ${FULL}.\n\n### Contact\n\n${FIRST} again\n\n## License\n\nBy ${FIRST}.\n`;
  assert.deepEqual(hits('README.md', readme), [`13:name By ${FIRST}.`], 'the Author section ends at the next ## heading');
  assert.equal(allowed('README.md', readme).length, 2);

  assert.deepEqual(hits('package.json', `{\n  "author": "${FULL} (https://github.com/mata-2p)",\n  "description": "by ${FIRST}"\n}`), [`3:name "description": "by ${FIRST}"`]);
  for (const file of ['LICENSE', 'NOTICE', 'SPONSORS.md']) assert.deepEqual(hits(file, `Copyright 2026 ${FULL}\n`), [], file);
  for (const file of ['docs/resources.md', 'test/x.test.ts', 'src/a.ts', 'CHANGELOG.md']) assert.equal(hits(file, `see ${LAST}`).length, 1, file);
});

test('the Ko-fi handle is allowed only in .github/FUNDING.yml and the README badge line (L13)', () => {
  assert.deepEqual(hits('.github/FUNDING.yml', `github: mata-2p\nko_fi: ${HANDLE}\n`), []);
  const badges = `[![test](https://x/badge.svg)](https://x) [![Ko-fi](https://img.shields.io/badge/Ko--fi-support-FF5E5B)](https://ko-fi.com/${HANDLE})`;
  assert.deepEqual(hits('README.md', badges), []);
  assert.equal(hits('README.md', `${badges} by ${FIRST}`).length, 1, 'the name beside the handle on the badge line is a hit');
  assert.equal(hits('README.md', `Donate at https://ko-fi.com/${HANDLE}.`).length, 1, 'the handle on another README line is a hit');
  assert.equal(hits('docs/features.md', `ko_fi: ${HANDLE}`).length, 1);
  assert.equal(hits('.github/FUNDING.yml', `custom: ${FIRST}`).length, 1, 'FUNDING.yml allows the handle, not the name');
});

/** README.es.md, the Spanish README (L20): the same badge line and its own author section. */
const ES_BADGES = `[![test](https://x/badge.svg)](https://x) [![Ko-fi](https://img.shields.io/badge/Ko--fi-support-FF5E5B)](https://ko-fi.com/${HANDLE})`;
const ES_README = `# Mirador\n\n## Autor\n\nMirador lo creó ${FULL}.\n\n### Contacto\n\n${FIRST} otra vez\n\n## Licencia\n\nPor ${FIRST}.\n`;

test('README.es.md allows the owner\'s name in its ## Autor section, up to the next ## heading (L20)', () => {
  assert.equal(allowed('README.es.md', ES_README).filter((e) => e.kind === 'name').length, 2);
  assert.equal(allowed('README.es.md', `## Autor\n\n${FULL}\n`)[0]?.allowed, 'the README.es.md ## Autor section (L20)');
});

test('README.es.md allows the Ko-fi handle on its badge line (L20)', () => {
  assert.deepEqual(hits('README.es.md', ES_BADGES), []);
  assert.equal(allowed('README.es.md', ES_BADGES)[0]?.allowed, 'the Ko-fi handle in the README.es.md badge line (L20)');
});

test('README.es.md: the owner\'s name outside ## Autor is still a hit, under ## Author too (L20)', () => {
  assert.deepEqual(hits('README.es.md', ES_README), [`13:name Por ${FIRST}.`]);
  assert.deepEqual(hits('README.es.md', `## Author\n\n${FULL}\n`), [`3:name ${FULL}`], 'only the Spanish heading opens its author section');
  assert.deepEqual(hits('README.md', `## Autor\n\n${FULL}\n`), [`3:name ${FULL}`], 'README.md keeps only its ## Author section');
});

test('README.es.md: the Ko-fi handle off the badge line is still a hit, and so is the name beside it (L20)', () => {
  assert.equal(hits('README.es.md', `Apoyá en https://ko-fi.com/${HANDLE}.`).length, 1);
  assert.equal(hits('README.es.md', `${ES_BADGES} por ${FIRST}`).length, 1, 'the name beside the handle on the badge line is a hit');
});

test('home paths: /home/<user> and /Users/<user> are hits, apart from the placeholder users you, u, m and ana', () => {
  assert.deepEqual(hits('docs/configuration.md', `"root": "${HOME}/you/Dev", "a": "${HOME}/u/x", "b": "${HOME}/m/y", "c": "${HOME}/ana/z"`), []);
  assert.deepEqual(hits('test/x.test.ts', `const a = '${HOME}/someone/Dev'; const b = '${USERS}/someone/Dev';`), [`1:home ${HOME}/someone`, `1:home ${USERS}/someone`]);
  assert.deepEqual(hits('docs/a.md', `${HOME}/mm/Dev ${HOME}/youngster`), [`1:home ${HOME}/mm`, `1:home ${HOME}/youngster`], 'only those exact users');
  assert.deepEqual(hits('src/a.ts', `join(home, '.config') // ~/Dev and ${HOME}/\${user} are not literal paths`), []);
});

test('e-mail: reserved example domains and GitHub noreply are allowed; ZURAI\'s contact only in an author place or its two credits lines; any other address is a hit', () => {
  assert.deepEqual(hits('test/x.test.ts', ['test@example.invalid', 'ana@example.com', 'x@example.org', 'y@sub.example', 'z@host.test'].join(' ')), []);
  assert.deepEqual(hits('scripts/x.sh', `53957759+mata-2p${AT}users.noreply.github.com`), []);
  const contact = ['contacto', 'zurai.cl'].join(AT);
  assert.deepEqual(hits('NOTICE', `Contact: ${contact}`), []);
  assert.deepEqual(hits('README.md', `## Author\n\nWrite to ${contact}.`), []);
  assert.deepEqual(hits('docs/features.md', `Write to ${contact}.`), [`1:email ${contact}`]);
  const model = `export const CREDITS_CONTACTS = [{ href: 'mailto:${contact}', text: '${contact}' }];`;
  assert.deepEqual(hits('public/features/credits-model.js', model), [], 'the credits model line');
  assert.deepEqual(hits('public/features/credits-model.js', `// mail ${contact}`), [`1:email ${contact}`], 'only that line of the model');
  assert.deepEqual(hits('public/features/credits.js', model).length, 2, 'only the model file');
  const check = `  assert.deepEqual(CREDITS_CONTACTS, [{ href: 'mailto:${contact}', text: '${contact}' }]);`;
  assert.deepEqual(hits('test/gentle-deck-state-filter-t5.test.ts', check), [], 'the assertion that checks it');
  assert.deepEqual(hits('test/gentle-deck-state-filter-t5.test.ts', `  assert.equal(mail, '${contact}');`).length, 1, 'only that assertion');
  assert.deepEqual(hits('test/other.test.ts', check).length, 2, 'only the t5 test');
  const report = `Write to [${contact}](mailto:${contact}). Every report is read and answered, and the reporter's identity`;
  assert.deepEqual(hits('CODE_OF_CONDUCT.md', report), [], 'the Code of Conduct reporting line');
  assert.deepEqual(hits('CODE_OF_CONDUCT.md', `Or mail ${contact}.`), [`1:email ${contact}`], 'only that line of the Code of Conduct');
  assert.deepEqual(hits('CODE_OF_CONDUCT.md', `${report} Or ${contact}.`).length, 3, 'only that exact line, nothing added to it');
  assert.deepEqual(hits('CODE_OF_CONDUCT.md', report.replace(`mailto:${contact}`, `mailto:${['x', 'zurai.cl'].join(AT)}`)).length, 2, 'only with the contact as the link target');
  assert.deepEqual(hits('CONTRIBUTING.md', report).length, 2, 'only the Code of Conduct');
  assert.deepEqual(hits('test/x.test.ts', `ssh://git${AT}github.com/o/r.git someone${AT}gmail.com`), [`1:email git${AT}github.com`, `1:email someone${AT}gmail.com`]);
  assert.deepEqual(hits('package.json', '"@xterm/xterm": "^6.0.0", "esbuild@0.28.2"'), [], 'package specs are not addresses');
});

test('issue and PR numbers are not hits: #NN of any size and mata-2p/mirador issues and pull URLs, in README.md, docs and test files (L45)', () => {
  const references = [
    `([${HASH}1](https://${REPO}/issues/1)) and ${HASH}13, ${HASH}14, ${REPO}/issues/14`,
    `([${HASH}111](https://${REPO}/issues/111))`,
    `https://${REPO}/pull/15 (PR ${HASH}15), ${HASH}20, ${HASH}34 and ${HASH}12345.`,
    `see https://${REPO}/issues/999999 and https://${REPO}/pull/40${HASH}issuecomment-1`,
    "'Queued: #3' and (#2)",
  ];
  for (const file of ['README.md', 'docs/a.md', 'docs/features.md', 'CHANGELOG.md', 'test/x.test.ts']) {
    for (const line of references) assert.deepEqual(scanText(file, line), [], `${file}: ${line}`);
  }
  // The other rules still run on a line that holds a reference.
  const mixed = `${HASH}40 by ${FIRST}, ${HOME}/someone, someone${AT}gmail.com, ${TASKS}/x.md`;
  assert.deepEqual(hits('docs/a.md', mixed), [`1:name ${mixed}`, `1:home ${HOME}/someone`, `1:email someone${AT}gmail.com`, `1:path ${TASKS}/x.md`]);
});

test('excluded paths: the task folder, the artboards\' folder and the informe are hits wherever an exported file names them (T2)', () => {
  assert.deepEqual(hits('src/a.ts', `// Night queue (release F12, ${TASKS}/acme-night-queue.md S3, S5).`), [`1:path ${TASKS}/acme-night-queue.md`]);
  assert.deepEqual(hits('public/styles.css', `/* Theme tokens (${DESIGN}mirador-theme/03-papel-y-tinta.html). */`), [`1:path ${DESIGN}mirador-theme/03-papel-y-tinta.html`]);
  assert.deepEqual(hits('docs/a.md', `See \`${INFORME}\`, \`${TASKS}\` and /${TASKS}/x.md.`), [`1:path ${INFORME}`, `1:path ${TASKS}`, `1:path ${TASKS}/x.md`]);
  assert.deepEqual(hits('.github/workflows/test.yml', `# ${TASKS}/acme-stable-tests.md (S4).`), [`1:path ${TASKS}/acme-stable-tests.md`]);
  for (const line of ['test/helpers/design.ts', 'readArtboard(path)', 'my-design/x', 'redesign/x', 'odd/README.md', `${TASKS}ets`, 'the informe of the audit', `src/${DESIGN}x.ts`]) {
    assert.deepEqual(hits('src/a.ts', line), [], line);
  }
});

test('excluded paths are allowed only in the T2 places, each for its own mentions', () => {
  // L26.4, narrowed (L33): invented example paths used as test text, only their exact names.
  const examples: Record<string, string[]> = {
    'test/memory-text.test.ts': [`${TASKS}/x.md`, `${TASKS}/acme-workspaces.md`],
    'test/night-decider.test.ts': [`${TASKS}/x.md`, `${TASKS}/acme-night-rota.md`],
  };
  for (const [file, paths] of Object.entries(examples)) {
    assert.deepEqual(hits(file, `  assert.equal(isSensitiveText('Continue with the next task in ${paths.join(' and ')}'), false);`), [], file);
    for (const path of paths) assert.equal(allowed(file, `'${path}'`)[0].allowed, 'invented example paths used as test text, only these exact names (L26, L33)', `${file}: ${path}`);
    for (const other of [`${TASKS}/${REAL('mirador', 'night', 'shift')}`, `${TASKS}/${REAL('mirador', 'workspaces')}`, `${TASKS}/y.md`, `${paths[1]}.bak`, TASKS]) {
      assert.deepEqual(hits(file, `  message: 'Continue with the next task in ${other}.',`), [`1:path ${other}`], `${file}: ${other} is a hit`);
    }
    assert.deepEqual(hits(file, `// the artboard ${DESIGN}a.html`), [`1:path ${DESIGN}a.html`], `${file}: the artboards' folder is a hit`);
  }
  // L27: the eval missions may name only their three invented task paths, exactly.
  const evals = 'evals/night/dev.jsonl';
  assert.deepEqual(hits(evals, `Follow ${TASKS}/acme-night-plan.md, ${TASKS}/acme-game-save.md. Then ${TASKS}/acme-thresholds-*.md?`), []);
  assert.equal(allowed(evals, `${TASKS}/acme-night-plan.md`)[0].allowed, 'invented task paths in the eval missions, only these exact names (L27)');
  assert.deepEqual(hits(evals, `Follow ${TASKS}/x.md and ${TASKS}/acme-night-plan.md.bak`), [`1:path ${TASKS}/x.md`, `1:path ${TASKS}/acme-night-plan.md.bak`], 'any other task path is a hit');
  assert.deepEqual(hits(evals, `See ${TASKS}/${REAL('mirador', 'night', 'shift')}`), [`1:path ${TASKS}/${REAL('mirador', 'night', 'shift')}`], 'a real document name is a hit');
  assert.deepEqual(hits(evals, `the artboard ${DESIGN}a.html`), [`1:path ${DESIGN}a.html`], 'the artboards\' folder is a hit');
  // L26.1: the artboard pins read the artboards' folder through readArtboard(); untouched, so all of their mentions stand.
  assert.deepEqual(hits('test/icons.test.ts', `// The icon set (${TASKS}/acme-theme.md S2, ${DESIGN}a.html)`), []);
  assert.deepEqual(hits('test/helpers/design.ts', `/** The skip reason where ${DESIGN} is absent. */`), []);
  // The theme contract keeps its artboard; its task-folder citations are gone (L26.3).
  assert.deepEqual(hits('test/gentle-deck-theme-contract.test.ts', `const artboard = readArtboard('${DESIGN}mirador-theme/03-papel-y-tinta.html');`), []);
  assert.deepEqual(hits('test/gentle-deck-theme-contract.test.ts', `// (${TASKS}/acme-brand.md)`), [`1:path ${TASKS}/acme-brand.md`]);
  // L26.2: the archive test names what the export leaves out.
  assert.deepEqual(hits('test/export-archive.test.ts', `leaves out ${TASKS}/, ${DESIGN} and ${INFORME}`), []);
  // The pre-push hook, its installer and its test act on the private folders (L21, L22); so does the gitleaks test's fixture.
  for (const file of ['scripts/hooks/pre-push', 'scripts/install-hooks.sh', 'test/pre-push-hook.test.ts']) {
    assert.deepEqual(hits(file, `git ls-tree -r --name-only "$commit" -- ${TASKS} design # ${DESIGN}a.html`), [], file);
  }
  assert.deepEqual(hits('test/gitleaks-config.test.ts', `    '${TASKS}/x.md': \`verifier \${PAT}\\n\`,`), []);
  assert.deepEqual(hits('test/gitleaks-config.test.ts', `// ${DESIGN}a.html`), [`1:path ${DESIGN}a.html`]);
  // odd/README.md says the task folder is not part of this repository (L22); .gitignore's rules ignore the private folders.
  assert.deepEqual(hits('odd/README.md', `are kept outside this repository, and the \`${TASKS}/\` folder is not part of it.`), []);
  assert.deepEqual(hits('odd/README.md', `see ${DESIGN}a.html`), [`1:path ${DESIGN}a.html`]);
  assert.deepEqual(hits('.gitignore', `${DESIGN}**/.screenshots/\n/${TASKS}`), []);
  assert.deepEqual(hits('.gitignore', `/${INFORME}`), [`1:path ${INFORME}`]);
  // User-facing strings that name the task folder, kept for a decision: only their exact lines.
  assert.deepEqual(hits('public/i18n/summary.js', `    'memory.term.odd': 'The task workflow: each feature has a document in ${TASKS} with its specs',`), []);
  assert.deepEqual(hits('public/i18n/summary.js', `    'memory.term.other': 'see ${TASKS}',`), [`1:path ${TASKS}`]);
  assert.deepEqual(hits('public/i18n/workspaces.js', `    'delegate.example': 'For example: go on with the next task in ${TASKS} and run the focused tests',`), []);
  assert.deepEqual(hits('src/night/decider.ts', '  `- Write one instruction, for example "Continue with the next task in ' + TASKS + '/<file>.md".`,'), []);
  assert.deepEqual(hits('src/night/decider.ts', ` * spec ${TASKS}/acme-night-rota.md S1`), [`1:path ${TASKS}/acme-night-rota.md`]);
  for (const file of ['src/a.ts', 'docs/extending.md', 'test/x.test.ts', 'evals/night/README.md']) assert.equal(hits(file, `(${TASKS}/x.md S1)`).length, 1, file);
});

test('the artboards\' folder after ./, ../ (any number of levels) or a root / is a hit at the start of a line, after a space, a quote or a backtick; inside a longer path or name it is not', () => {
  for (const prefix of ['./', '../', '/', '../../', '../../../', './../', '.././']) {
    const path = `${prefix}${DESIGN}x.html`;
    for (const line of [path, `see ${path}`, `'${path}'`, `"${path}"`, `\`${path}\``]) {
      assert.deepEqual(hits('src/a.ts', line), [`1:path ${DESIGN}x.html`], line);
    }
  }
  for (const line of [`src/${DESIGN}x.ts`, `./src/${DESIGN}x.ts`, `/src/${DESIGN}x.ts`, 'test/helpers/design.ts', 'my-design/x', './my-design/x', 'redesign/x', '/redesign/x', `...${'/'}${DESIGN}x.html`, `../src/${DESIGN}x.ts`, `../../my-design/x`, `..//${DESIGN}x.html`]) {
    assert.deepEqual(hits('src/a.ts', line), [], line);
  }
});

test('the user-facing strings that name the task folder allow only the exact path each one carries; any other excluded path on the same line is a hit', () => {
  const why = 'a user-facing string that names the task folder, kept for a decision (T2)';
  const lines: Record<string, { lines: string[]; path: string }> = {
    'public/i18n/summary.js': {
      lines: [
        `    'memory.term.odd': 'The task workflow: each feature has a document in ${TASKS} with its specs, tasks and log',`,
        `    'memory.term.odd': 'El flujo de tareas: cada funcionalidad tiene un documento en ${TASKS} con sus especificaciones, tareas y registro',`,
      ],
      path: TASKS,
    },
    'public/i18n/workspaces.js': {
      lines: [
        `    'delegate.example': 'For example: go on with the next task in ${TASKS} and run the focused tests',`,
        `    'delegate.example': 'Por ejemplo: sigue con la próxima task de ${TASKS} y corre los tests focales',`,
      ],
      path: TASKS,
    },
    'src/night/decider.ts': {
      lines: ['  `- Write one instruction of at most ${MAX_FOLLOW_UP_CHARS} characters that continues the work the mission and the agent\'s own output already plan, for example "Continue with the next task in ' + TASKS + '/<file>.md" or "Run the focused tests and report the result".`,'],
      path: `${TASKS}/<file>.md`,
    },
  };
  for (const [file, { lines: today, path }] of Object.entries(lines)) {
    for (const line of today) {
      assert.deepEqual(hits(file, line), [], `${file}: the line as it is today`);
      assert.deepEqual(allowed(file, line).map((e) => [e.match, e.allowed]), [[path, why]], `${file}: its exact path is allowed`);
      for (const added of [`${TASKS}/x.md`, `${DESIGN}a.html`, INFORME]) {
        assert.deepEqual(hits(file, `${line} // ${added}`), [`1:path ${added}`], `${file}: ${added} added to the line`);
      }
    }
  }
  assert.deepEqual(hits('src/night/decider.ts', lines['src/night/decider.ts'].lines[0].replace('<file>.md', '<feature>.md')), [`1:path ${TASKS}/<feature>.md`], 'another task path in place of the exact one');
  assert.deepEqual(hits('public/i18n/summary.js', lines['public/i18n/summary.js'].lines[0].replace(` ${TASKS} `, ` ${TASKS}/x.md `)), [`1:path ${TASKS}/x.md`], 'a longer task path in place of the folder');
});

test('the CLI prints each hit as file:line:kind and exits 1; with none it exits 0; --allowed lists the allowed entries', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mirador-export-scan-')));
  scratches.push(dir);
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'NOTICE'), `Copyright 2026 ${FULL}\n`);
  writeFileSync(join(dir, 'docs', 'a.md'), `intro\nsee ${HASH}40, someone${AT}gmail.com and ${USERS}/someone\n`);
  writeFileSync(join(dir, 'logo.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0]), Buffer.from(FIRST)]));
  const run = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'export-scan.ts'), ...args], { encoding: 'utf8' });
  const failing = run(dir);
  assert.equal(failing.status, 1);
  assert.equal(failing.stdout, 'docs/a.md:2:home\ndocs/a.md:2:email\n', 'the issue number is not a hit');
  assert.equal(failing.stderr, 'export scan: 2 text files, 2 hits, 1 allowed\n', 'the binary file is skipped');
  const listed = run(dir, '--allowed');
  assert.equal(listed.status, 1);
  assert.equal(listed.stdout, 'docs/a.md:2:home\ndocs/a.md:2:email\nNOTICE:1:name allowed: NOTICE: the copyright line (L12)\n');
  writeFileSync(join(dir, 'docs', 'a.md'), `intro\nsee ${HASH}40 and https://${REPO}/pull/40\n`);
  const clean = run(dir);
  assert.equal(clean.status, 0);
  assert.equal(clean.stdout, '');
  assert.equal(clean.stderr, 'export scan: 2 text files, 0 hits, 1 allowed\n', 'an issue or PR reference is neither a hit nor an allowed entry');
  const usage = run();
  assert.equal(usage.status, 2);
  assert.equal(usage.stderr, 'usage: node scripts/export-scan.ts <extracted-dir> [--allowed]\n');
  assert.equal(run(dir, '--all').status, 2, 'an unknown option is bad usage');
});

/** A fresh git repository in a scratch folder whose HEAD commits `files` (path to content). */
function checkout(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mirador-task-names-')));
  scratches.push(dir);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@example.invalid',
  };
  const git = (...args: string[]) => assert.equal(spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' }).status, 0, args.join(' '));
  git('init', '-q', '-b', 'main');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', 'c');
  return dir;
}

test('task names: the file names under the task folder at HEAD, at any depth; none when HEAD has no such folder (L33)', () => {
  const repo = checkout({ [`${TASKS}/acme-alpha.md`]: 'a', [`${TASKS}/sub/acme-beta.md`]: 'b', 'docs/acme-gamma.md': 'c', [`src/${TASKS}/acme-delta.md`]: 'd' });
  writeFileSync(join(repo, TASKS, 'acme-draft.md'), 'not committed');
  assert.deepEqual(listTaskNames(repo), ['acme-alpha.md', 'acme-beta.md'], 'only committed files of the root task folder');
  assert.deepEqual(listTaskNames(checkout({ 'README.md': 'x' })), [], 'the public repository has no task folder');
  const plain = realpathSync(mkdtempSync(join(tmpdir(), 'mirador-task-names-')));
  scratches.push(plain);
  assert.throws(() => listTaskNames(plain), /^Error: git ls-tree failed in /, 'not a git checkout');
});

test('task names: a line names a task document by its whole file name, extension included, with or without a path (L33)', () => {
  const names = ['acme-alpha.md', 'acme-alpha-two.md', 'x.y.md'];
  const found = (line: string) => taskNameHits('docs/a.md', line, names).map((h) => `${h.file}:${h.line} ${h.name}`);
  for (const line of ['see acme-alpha.md', `${TASKS}/acme-alpha.md`, `/${TASKS}/acme-alpha.md S2`, 'docs/acme-alpha.md', '(acme-alpha.md)', '`acme-alpha.md`', "'acme-alpha.md'", 'Ends in acme-alpha.md.', 'acme-alpha.md:12', 'acme-alpha.md#L3', 'acme-alpha.md, then']) {
    assert.deepEqual(found(line), ['docs/a.md:1 acme-alpha.md'], line);
  }
  for (const line of ['acme-alpha', 'acme-alpha.mdx', 'acme-alpha.md.bak', 'acme-alpha.md-old', 'xacme-alpha.md', 'my-acme-alpha.md', '.acme-alpha.md', 'acme_alpha.md', 'xay.md', 'ACME-ALPHA.MD']) {
    assert.deepEqual(found(line), [], line);
  }
  assert.deepEqual(found('see acme-alpha-two.md'), ['docs/a.md:1 acme-alpha-two.md'], 'the longer name, not its prefix');
  assert.deepEqual(found('acme-alpha.md and x.y.md\nnothing\nagain acme-alpha-two.md'), ['docs/a.md:1 acme-alpha.md', 'docs/a.md:1 x.y.md', 'docs/a.md:3 acme-alpha-two.md'], 'every name on every line');
  assert.deepEqual(taskNameHits('docs/a.md', 'see acme-alpha.md', []), [], 'no names, nothing to find');
});

test('task names: the CLI lists HEAD\'s task names, prints each line of the export that names one as file:line: name and exits 1; with none it exits 0 (L33)', () => {
  const repo = checkout({ [`${TASKS}/acme-alpha.md`]: 'a', [`${TASKS}/acme-beta.md`]: 'b' });
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mirador-task-names-export-')));
  scratches.push(dir);
  mkdirSync(join(dir, 'docs'));
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'docs', 'a.md'), `intro\nsee ${TASKS}/acme-alpha.md and acme-beta.md\n`);
  writeFileSync(join(dir, 'README.md'), 'acme-beta.md\n');
  writeFileSync(join(dir, 'logo.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0]), Buffer.from('acme-alpha.md')]));
  writeFileSync(join(dir, 'node_modules', 'x.js'), 'acme-alpha.md');
  const run = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'export-task-names.ts'), ...args], { encoding: 'utf8' });
  const failing = run(dir, repo);
  assert.equal(failing.status, 1);
  assert.equal(failing.stdout, 'README.md:1: acme-beta.md\ndocs/a.md:2: acme-alpha.md\ndocs/a.md:2: acme-beta.md\n');
  assert.equal(failing.stderr, `task names: 2 listed from ${TASKS}/ at HEAD, 2 text files, 3 hits\n`, 'the binary file and node_modules are skipped');
  writeFileSync(join(dir, 'docs', 'a.md'), 'intro\nsee acme-alpha\n');
  writeFileSync(join(dir, 'README.md'), 'nothing\n');
  const clean = run(dir, repo);
  assert.equal(clean.status, 0);
  assert.equal(clean.stdout, '');
  assert.equal(clean.stderr, `task names: 2 listed from ${TASKS}/ at HEAD, 2 text files, 0 hits\n`);
  writeFileSync(join(dir, 'README.md'), 'acme-beta.md\n');
  const none = run(dir, checkout({ 'README.md': 'x' }));
  assert.equal(none.status, 0, 'the public repository: nothing to look for');
  assert.equal(none.stdout, '');
  assert.equal(none.stderr, `task names: none listed; HEAD has no ${TASKS}/, so there is nothing to look for\n`);
  const notGit = run(dir, dir);
  assert.equal(notGit.status, 2);
  assert.match(notGit.stderr, /^task names: git ls-tree failed in /);
  const usage = 'usage: node scripts/export-task-names.ts <extracted-dir> <checkout>\n';
  for (const args of [[], [dir], [dir, repo, 'x'], [dir, '--all']]) {
    const bad = run(...args);
    assert.equal(bad.status, 2, args.join(' '));
    assert.equal(bad.stderr, usage, args.join(' '));
  }
});

test('where() is the printed form', () => {
  assert.equal(where({ file: 'a/b.md', line: 3, kind: 'email', match: 'x' }), 'a/b.md:3:email');
});

test('the extracted git archive HEAD has no hit outside the allowed places (L18)', { skip: notACheckout() }, () => {
  const dir = extractHead();
  scratches.push(dir);
  const scan = spawnSync(process.execPath, [join(ROOT, 'scripts', 'export-scan.ts'), dir], { encoding: 'utf8' });
  assert.equal(scan.stdout, '', `hits outside the allowed places:\n${scan.stdout}`);
  assert.equal(scan.status, 0, scan.stderr);
  assert.match(scan.stderr, /^export scan: \d{3,} text files, 0 hits, \d+ allowed\n$/);
});
