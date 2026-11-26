// Public release T1 (S3, L12, L13, L18): scans an extracted export (`git archive HEAD | tar -x`) for
// what must not travel in it: the owner's name, home paths, e-mail addresses and (T2, S2) the paths
// the export leaves out. Each kind has its allowed places, listed below; anything else is a hit.
// Issue and PR numbers are not looked for: in the public repository they are legitimate references (L45).
//   node scripts/export-scan.ts <extracted-dir> [--allowed]
// Prints each hit as `file:line:kind` and exits 1 when there is any, 0 when there is none (2 on bad
// usage). --allowed also prints the allowed entries, each with the reason it is allowed.
// scripts/export-task-names.ts looks for the task documents' file names (L33).
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Kind = 'name' | 'home' | 'email' | 'path';

export interface Entry {
  file: string;
  line: number;
  kind: Kind;
  match: string;
  /** Why the entry is allowed; absent for a hit. */
  allowed?: string;
}

/** A line folded for the name match: canonical decomposition, combining marks dropped, lower case. */
export function fold(line: string): string {
  return line.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * The owner's first name and surname, folded. Spelled from letters so that this file, which is
 * exported too, never holds them.
 */
export const NAME_PARTS: readonly string[] = [['m', 'a', 't', 'i', 'a', 's'], ['b', 'a', 'r', 'r', 'i', 'a']].map((letters) => letters.join(''));

/** The Ko-fi handle: the first name, j, the surname and h. */
export const HANDLE = `${NAME_PARTS[0]}j${NAME_PARTS[1]}h`;

/** Whether `line` holds the owner's first name or surname, with or without accents, in any case. */
export function holdsOwnerName(line: string): boolean {
  const folded = fold(line);
  return NAME_PARTS.some((part) => folded.includes(part));
}

/** The whole file may name the owner (L12). */
const NAME_FILES: Record<string, string> = {
  LICENSE: 'LICENSE: the copyright line (L12)',
  NOTICE: 'NOTICE: the copyright line (L12)',
  'SPONSORS.md': 'SPONSORS.md names the owner (L12)',
};

/** The author credit, once per language: exactly `'credits.by.name': '<plain string>'` (L12). */
const CREDIT_FILE = 'public/i18n/credits.js';
const CREDIT_LINE = /^\s*'credits\.by\.name': '[^'\\]*',?\s*$/;

/** package.json's `author` field (L12). */
const AUTHOR_LINE = /^\s*"author":\s*"[^"]*",?\s*$/;

/** The README's badge line: the Ko-fi badge links the handle (L13). */
const BADGE_LINE = /^\[!\[.*\]\(https:\/\/ko-fi\.com\/[^)]*\)/;
const KOFI_BADGE = /\[!\[[^\]]*\]\([^)]*\)\]\(https:\/\/ko-fi\.com\/[^)]*\)/;

/**
 * Home paths: `/home/<user>` or `/Users/<user>`. Allowed only the invented placeholder users, each
 * listed with where it is used; the real user name is the owner's, which the name check also catches.
 */
const HOME_PATH = /\/(?:home|Users)\/([A-Za-z0-9._-]+)/g;
export const PLACEHOLDER_HOMES: Record<string, string> = {
  you: 'placeholder user in README, docs/configuration.md, config.example.json, public/i18n and test fixtures',
  u: 'placeholder user in docs/resources.md and test fixtures',
  m: 'placeholder user in test fixtures',
  ana: 'placeholder user in test fixtures (the invented Ana)',
};

/** E-mail addresses. Allowed: reserved example domains, GitHub noreply, and ZURAI's contact in the author places and the credits. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const EXAMPLE_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net)|[a-z0-9-]+\.(?:example|invalid|test|localhost)|example|invalid|test|localhost)$/i;
const NOREPLY = /@users\.noreply\.github\.com$/i;
const CONTACT = ['contacto', 'zurai.cl'].join('@');
/**
 * ZURAI's contact outside the author places (L13, L19, L30): the CREDITS_CONTACTS line of the credits
 * model, the assertion that checks it, and the reporting line of the Code of Conduct.
 */
const CONTACT_LINES: Record<string, RegExp> = {
  'public/features/credits-model.js': /^export const CREDITS_CONTACTS = \[/,
  'test/gentle-deck-state-filter-t5.test.ts': /^\s*assert\.deepEqual\(CREDITS_CONTACTS, \[/,
  'CODE_OF_CONDUCT.md': new RegExp(`^Write to \\[${CONTACT.replace(/\./g, '\\.')}\\]\\(mailto:${CONTACT.replace(/\./g, '\\.')}\\)\\. Every report is read and answered, and the reporter's identity$`),
};
/** Why ZURAI's contact may stand on a CONTACT_LINES line of `file`. */
const contactWhy = (file: string) => file === 'CODE_OF_CONDUCT.md'
  ? 'ZURAI\'s contact on the Code of Conduct reporting line (L30)'
  : 'ZURAI\'s contact in the credits (L13, L19)';

/**
 * The paths the export leaves out (S2, T2): the task folder, the artboards' folder and the informe.
 * Each is matched as a path, not inside a longer name: the task folder and the informe not after a
 * word character, `.` or `-`; the artboards' folder not after `/` either (`test/helpers/design.ts`,
 * `src/design/` and `redesign/` are not it), unless that `/` starts the path, alone or after any
 * run of `./` and `../` (the folder anchored at the root or relative to any folder above is it). The
 * match runs on to the end of the path, without a closing `.`.
 */
const SEGMENT = String.raw`\.?[\w*<>-]+(?:\.[\w*<>-]+)*`;
const EXCLUDED_PATH = new RegExp(
  [
    String.raw`(?<![\w.-])odd\/tasks(?![\w-])(?:\/${SEGMENT})*\/?`,
    String.raw`(?:(?<![\w./-])|(?<=(?:^|[^\w./-])(?:(?:\.{1,2}\/)+|\/)))design\/(?:${SEGMENT}(?:\/${SEGMENT})*\/?)?`,
    String.raw`(?<![\w.-])(?:docs\/)?informe-\d{4}-\d{2}-\d{2}(?:\.md)?`,
  ].join('|'),
  'g',
);
type Excluded = 'tasks' | 'design' | 'informe';
const excludedOf = (path: string): Excluded => (path.startsWith('design') ? 'design' : path.includes('informe') ? 'informe' : 'tasks');

/** The artboard pins read the artboards' folder through readArtboard() and are left as they are (L26.1). */
const ARTBOARD_PIN = 'reads an artboard through readArtboard() and skips where the folder is absent; left as it is (L26.1)';
/** The pre-push hook keeps the private folders out of the public clone (L21, L22). */
const PRIVATE_FOLDERS = 'the pre-push hook, its installer or its test: they act on the private folders (L21, L22)';

/** Where an exported file may name an excluded path, which ones, and why (T2, L25, L26). */
const PATH_FILES: Record<string, { paths: readonly Excluded[]; exact?: readonly string[]; why: string }> = {
  'test/helpers/design.ts': { paths: ['design'], why: ARTBOARD_PIN },
  'test/gentle-deck-fidelity-contract.test.ts': { paths: ['tasks', 'design'], why: ARTBOARD_PIN },
  'test/gentle-deck-state-filter-t1.test.ts': { paths: ['tasks', 'design'], why: ARTBOARD_PIN },
  'test/gentle-deck-state-filter-t2.test.ts': { paths: ['tasks', 'design'], why: ARTBOARD_PIN },
  'test/gentle-deck-state-filter-t3.test.ts': { paths: ['tasks', 'design'], why: ARTBOARD_PIN },
  'test/gentle-deck-state-filter-t4.test.ts': { paths: ['tasks', 'design'], why: ARTBOARD_PIN },
  'test/gentle-deck-state-filter-t5.test.ts': { paths: ['tasks', 'design'], why: ARTBOARD_PIN },
  'test/gentle-deck-state-filter-t6.test.ts': { paths: ['tasks', 'design'], why: ARTBOARD_PIN },
  'test/icons.test.ts': { paths: ['tasks', 'design'], why: ARTBOARD_PIN },
  'test/sereno-owl.test.ts': { paths: ['design'], why: ARTBOARD_PIN },
  'test/gentle-deck-theme-contract.test.ts': { paths: ['design'], why: 'reads its artboard through readArtboard(); only the task-folder citations went (L26.1, L26.3)' },
  'test/export-archive.test.ts': { paths: ['tasks', 'design', 'informe'], why: 'checks that the export leaves these paths out; left as it is (L26.2)' },
  'test/memory-text.test.ts': {
    paths: ['tasks'],
    // Joined from pieces so this file names no task path itself.
    exact: ['x.md', 'acme-workspaces.md'].map((name) => ['odd', 'tasks', name].join('/')),
    why: 'invented example paths used as test text, only these exact names (L26, L33)',
  },
  'test/night-decider.test.ts': {
    paths: ['tasks'],
    exact: ['x.md', 'acme-night-rota.md'].map((name) => ['odd', 'tasks', name].join('/')),
    why: 'invented example paths used as test text, only these exact names (L26, L33)',
  },
  'evals/night/dev.jsonl': {
    paths: ['tasks'],
    // Joined from pieces so this file names no task path itself.
    exact: ['acme-night-plan.md', 'acme-game-save.md', 'acme-thresholds-*.md'].map((name) => ['odd', 'tasks', name].join('/')),
    why: 'invented task paths in the eval missions, only these exact names (L27)',
  },
  'scripts/hooks/pre-push': { paths: ['tasks', 'design'], why: PRIVATE_FOLDERS },
  'scripts/install-hooks.sh': { paths: ['tasks', 'design'], why: PRIVATE_FOLDERS },
  'test/pre-push-hook.test.ts': { paths: ['tasks', 'design'], why: PRIVATE_FOLDERS },
  'test/gitleaks-config.test.ts': { paths: ['tasks'], why: 'fixture paths a gitleaks scan must still check, like any other path (T7)' },
  'odd/README.md': { paths: ['tasks'], why: 'says the task folder is not part of this repository (L22)' },
  '.gitignore': { paths: ['tasks', 'design'], why: 'ignore rules for the private folders (phase 4, L20, L22)' },
};

/**
 * User-facing strings that name the task folder, kept for a decision (T2): only these exact lines, and
 * on each only the exact paths it carries. Joined from pieces so this file names no task path itself.
 */
const TASK_FOLDER = ['odd', 'tasks'].join('/');
const PATH_LINES: Record<string, { line: RegExp; paths: readonly string[] }> = {
  'public/i18n/summary.js': { line: /^\s*'memory\.term\.odd': '/, paths: [TASK_FOLDER] },
  'public/i18n/workspaces.js': { line: /^\s*'delegate\.example': '/, paths: [TASK_FOLDER] },
  'src/night/decider.ts': {
    line: /^\s*`- Write one instruction\b.*for example "Continue with the next task in /,
    paths: [[TASK_FOLDER, '<file>.md'].join('/')],
  },
};

/** Why `path`, named on `text` of `file`, may stand there, or undefined. */
function pathAllowed(file: string, text: string, path: string): string | undefined {
  const place = PATH_FILES[file];
  if (place?.paths.includes(excludedOf(path)) && (!place.exact || place.exact.includes(path))) return place.why;
  const strings = PATH_LINES[file];
  if (strings?.line.test(text) && strings.paths.includes(path)) return 'a user-facing string that names the task folder, kept for a decision (T2)';
  return undefined;
}

/** The author section of each README: the English one (L12) and the Spanish one (L20). */
const AUTHOR_HEADINGS: Record<string, string> = { 'README.md': '## Author', 'README.es.md': '## Autor' };

/** The line numbers (1-based) of a README's author section, its heading included. */
function sectionLines(lines: string[], heading: string): Set<number> {
  const inside = new Set<number>();
  let open = false;
  lines.forEach((line, index) => {
    if (/^#{1,2} /.test(line)) open = line.trim() === heading;
    if (open) inside.add(index + 1);
  });
  return inside;
}

/** Every file under `dir`, depth first, in a stable order, without node_modules or .git. */
export function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** Why the owner's name may stand on `line` of `file`, or undefined. */
function nameAllowed(file: string, text: string, lineNo: number, author: Set<number>): string | undefined {
  if (NAME_FILES[file]) return NAME_FILES[file];
  if (file === CREDIT_FILE && CREDIT_LINE.test(text)) return 'credits.by.name, the author credit (L12)';
  if (file === 'README.md' && author.has(lineNo)) return 'the README ## Author section (L12)';
  if (file === 'README.es.md' && author.has(lineNo)) return 'the README.es.md ## Autor section (L20)';
  if (file === 'package.json' && AUTHOR_LINE.test(text)) return 'the package.json author field (L12)';
  return undefined;
}

/** Whether the Ko-fi handle may stand on `line` of `file` (L13): FUNDING.yml and the README badge line. */
function handlePlace(file: string, text: string): string | undefined {
  if (file === '.github/FUNDING.yml') return 'the Ko-fi handle in .github/FUNDING.yml (L13)';
  if (file === 'README.md' && BADGE_LINE.test(text) && KOFI_BADGE.test(text)) return 'the Ko-fi handle in the README badge line (L13)';
  if (file === 'README.es.md' && BADGE_LINE.test(text) && KOFI_BADGE.test(text)) return 'the Ko-fi handle in the README.es.md badge line (L20)';
  return undefined;
}

/** The entries of one text file, `file` relative to the export root. */
export function scanText(file: string, content: string): Entry[] {
  const entries: Entry[] = [];
  const lines = content.split('\n');
  const heading = AUTHOR_HEADINGS[file];
  const author = heading ? sectionLines(lines, heading) : new Set<number>();
  lines.forEach((text, index) => {
    const line = index + 1;
    const add = (kind: Kind, match: string, allowed?: string) => entries.push(allowed ? { file, line, kind, match, allowed } : { file, line, kind, match });

    if (holdsOwnerName(text)) {
      const placed = nameAllowed(file, text, line, author);
      const handle = handlePlace(file, text);
      const rest = handle ? fold(text).replaceAll(HANDLE, '') : fold(text);
      if (placed) add('name', text.trim(), placed);
      else if (handle && !NAME_PARTS.some((part) => rest.includes(part))) add('name', HANDLE, handle);
      else add('name', text.trim());
    }

    for (const m of text.matchAll(HOME_PATH)) add('home', m[0], PLACEHOLDER_HOMES[m[1]] && `${m[0]}: ${PLACEHOLDER_HOMES[m[1]]}`);

    for (const m of text.matchAll(EMAIL)) {
      const address = m[0];
      const domain = address.slice(address.lastIndexOf('@') + 1);
      if (EXAMPLE_DOMAIN.test(domain)) add('email', address, 'a reserved example domain (RFC 2606/6761)');
      else if (NOREPLY.test(address)) add('email', address, 'a GitHub noreply address');
      else if (address.toLowerCase() === CONTACT && nameAllowed(file, text, line, author)) add('email', address, 'ZURAI\'s contact in an author place (L13)');
      else if (address.toLowerCase() === CONTACT && CONTACT_LINES[file]?.test(text)) add('email', address, contactWhy(file));
      else add('email', address);
    }

    for (const m of text.matchAll(EXCLUDED_PATH)) add('path', m[0], pathAllowed(file, text, m[0]));
  });
  return entries;
}

/** Every entry of the export extracted in `dir`; a file with a NUL byte is binary and skipped. */
export function scanExport(dir: string): { files: number; hits: Entry[]; allowed: Entry[] } {
  let files = 0;
  const hits: Entry[] = [];
  const allowed: Entry[] = [];
  for (const path of walk(dir)) {
    const bytes = readFileSync(path);
    if (bytes.includes(0)) continue;
    files += 1;
    for (const entry of scanText(relative(dir, path).split('\\').join('/'), bytes.toString('utf8'))) (entry.allowed ? allowed : hits).push(entry);
  }
  return { files, hits, allowed };
}

/** `file:line:kind`, the form a hit is printed in. */
export const where = (entry: Entry): string => `${entry.file}:${entry.line}:${entry.kind}`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dir = args.find((arg) => !arg.startsWith('--'));
  if (!dir || args.some((arg) => arg.startsWith('--') && arg !== '--allowed')) {
    process.stderr.write('usage: node scripts/export-scan.ts <extracted-dir> [--allowed]\n');
    process.exit(2);
  }
  const { files, hits, allowed } = scanExport(dir);
  for (const hit of hits) process.stdout.write(`${where(hit)}\n`);
  if (args.includes('--allowed')) for (const entry of allowed) process.stdout.write(`${where(entry)} allowed: ${entry.allowed}\n`);
  process.stderr.write(`export scan: ${files} text files, ${hits.length} hits, ${allowed.length} allowed\n`);
  process.exit(hits.length > 0 ? 1 : 0);
}
