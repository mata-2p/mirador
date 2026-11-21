// The terminal turns file paths in its output into links (public/terminals.js): an xterm link
// provider beside WebLinksAddon, which offers a path only once the file is known to exist, and
// whose click opens the file editor through the inbox's `files:open` event.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Loaded by URL: the plain-JS dictionaries have no type declarations.
const { MESSAGES } = await import(new URL('../public/i18n.js', import.meta.url).href);

const js = readFileSync('public/terminals.js', 'utf8');
/** The body of top-level function `name` in terminals.js. */
const body = (name: string) => js.match(new RegExp(`\\n(?:export )?function ${name}\\([^)]*\\) \\{\\n([\\s\\S]*?)\\n\\}\\n`))?.[1] ?? '';

test('the terminal reads paths with the pure model', () => {
  assert.match(js, /\nimport \{ fileChecker, findFileLinks, linkRange, splitPath \} from '\/features\/file-links-model\.js';\n/);
});

test('connectTerminal keeps WebLinksAddon for http(s) and adds the file links', () => {
  const connect = body('connectTerminal');
  assert.match(js, /\nimport \{ WebLinksAddon \} from '\/vendor\/addon-web-links\.mjs';\n/);
  assert.match(connect, /\n\s+term\.loadAddon\(new WebLinksAddon\(\)\);\n/);
  assert.match(connect, /\n\s+term\.loadAddon\(fileLinks\(record, body\)\);\n/);
});

test('the file links register an xterm link provider and drop it with the terminal', () => {
  const addon = body('fileLinks');
  assert.match(addon, /provider = term\.registerLinkProvider\(\{ provideLinks: \(line, callback\) => provideFileLinks\(record, body, line, callback\) \}\);/);
  assert.match(addon, /dispose\(\) \{\n\s+provider\?\.dispose\(\);/);
});

test('a path becomes a link only after the check that its file exists', () => {
  const provide = body('provideFileLinks');
  assert.match(provide, /const found = findFileLinks\(text, \{ root: workspace\.root, rel: info\.rel \?\? '', cwd: info\.cwd \}\);/);
  assert.match(provide, /Promise\.all\(found\.map\(\(link\) => fileExists\(info\.workspaceId, link\.path\)\)\)/);
  assert.match(provide, /found\.filter\(\(link, index\) => exists\[index\]\)/);
  // Nothing is handed to xterm before the answer.
  assert.ok(provide.indexOf('fileExists(') < provide.indexOf('callback(links'), 'the links go to xterm after the check');
  assert.doesNotMatch(provide.slice(0, provide.indexOf('fileExists(')), /callback\(found|callback\(links/);
});

test('the existence check lists the folder through the files API, cached', () => {
  assert.match(js, /\nconst fileExists = fileChecker\(async \(ws, rel\) => \(await api\('GET', `\/api\/files\?\$\{new URLSearchParams\(\{ ws, rel \}\)\}`\)\)\.files\.map\(\(file\) => file\.name\)\);\n/);
});

test('activating a link emits files:open for the folder that holds the file', () => {
  const link = body('fileLink');
  assert.match(link, /const \{ dir, name \} = splitPath\(found\.path\);/);
  assert.match(link, /activate: \(\) => emit\('files:open', \{ ws: info\.workspaceId, rel: dir, path: name \}\),/);
});

test('hovering a link names the file it opens, in English and Spanish', () => {
  const link = body('fileLink');
  assert.match(link, /hover: \(\) => \{\n\s+body\.title = t\('term\.fileLink', \{ path: found\.path \}\);/);
  assert.match(link, /leave: \(\) => body\.removeAttribute\('title'\),/);
  const messages = MESSAGES as Record<string, Record<string, string>>;
  assert.equal(messages.en['term.fileLink'], 'Open {path} in the file editor');
  assert.equal(messages.es['term.fileLink'], 'Abrir {path} en el editor de archivos');
});
