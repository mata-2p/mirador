// File paths in a terminal's output become links to the file editor (public/features/file-links-model.js):
// which text is a path, where it points inside the workspace root, and the cached check that the file exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Loaded by URL: the plain-JS model has no type declarations.
const model = await import(new URL('../public/features/file-links-model.js', import.meta.url).href);
const { fileChecker, findFileLinks, linkRange, splitPath } = model;

// A terminal opened in the folder `web` of the workspace rooted at /home/u/Dev.
const place = { root: '/home/u/Dev', rel: 'web', cwd: '/home/u/Dev/web' };

/** Each candidate as [the linked text, its path relative to the root, line, col]. */
function links(text: string, where = place) {
  return findFileLinks(text, where).map((link: any) => [text.slice(link.start, link.end), link.path, link.line, link.col]);
}

test('an absolute path inside the workspace root is a candidate, relative to the root', () => {
  assert.deepEqual(links('Edited /home/u/Dev/web/src/app.ts'), [['/home/u/Dev/web/src/app.ts', 'web/src/app.ts', null, null]]);
  assert.deepEqual(links('see /home/u/Dev/api/server.ts now'), [['/home/u/Dev/api/server.ts', 'api/server.ts', null, null]]);
  const [link] = findFileLinks('Edited /home/u/Dev/web/src/app.ts', place);
  assert.equal(link.start, 7);
  assert.equal(link.end, 33);
});

test('an absolute path under the root as the terminal sees it (its real path) counts too', () => {
  // The root is a symlink: the terminal's cwd is the real folder, and programs print real paths.
  const linked = { root: '/home/u/Dev', rel: 'web', cwd: '/mnt/data/Dev/web' };
  assert.deepEqual(links('wrote /mnt/data/Dev/web/a.ts', linked), [['/mnt/data/Dev/web/a.ts', 'web/a.ts', null, null]]);
  assert.deepEqual(links('wrote /home/u/Dev/web/a.ts', linked), [['/home/u/Dev/web/a.ts', 'web/a.ts', null, null]]);
});

test('./x, ../x and a/b.ts resolve against the terminal\'s folder', () => {
  assert.deepEqual(links('./x.ts'), [['./x.ts', 'web/x.ts', null, null]]);
  assert.deepEqual(links('../api/y.ts'), [['../api/y.ts', 'api/y.ts', null, null]]);
  assert.deepEqual(links('src/b.ts'), [['src/b.ts', 'web/src/b.ts', null, null]]);
  assert.deepEqual(links('src/./lib/../b.ts'), [['src/./lib/../b.ts', 'web/src/b.ts', null, null]]);
  // A bare file name with an extension, and a dotfile, are files of the terminal's folder.
  assert.deepEqual(links('fill in .env and notes.md'), [['.env', 'web/.env', null, null], ['notes.md', 'web/notes.md', null, null]]);
  // A terminal at the workspace root.
  assert.deepEqual(links('../x.ts src/c.ts', { root: '/home/u/Dev', rel: '', cwd: '/home/u/Dev' }), [['src/c.ts', 'src/c.ts', null, null]]);
});

test('a :line or :line:col suffix is kept aside, not part of the path', () => {
  assert.deepEqual(links('src/a.ts:12'), [['src/a.ts:12', 'web/src/a.ts', 12, null]]);
  assert.deepEqual(links('src/a.ts:12:3'), [['src/a.ts:12:3', 'web/src/a.ts', 12, 3]]);
  assert.deepEqual(links('src/a.ts:12:3: error TS2322'), [['src/a.ts:12:3', 'web/src/a.ts', 12, 3]]);
  assert.deepEqual(links('/home/u/Dev/web/a.ts:7'), [['/home/u/Dev/web/a.ts:7', 'web/a.ts', 7, null]]);
});

test('quotes, backticks, brackets and a trailing period or comma are not part of the path', () => {
  for (const text of ['"src/a.ts"', "'src/a.ts'", '`src/a.ts`', '(src/a.ts)', '[src/a.ts]', '{src/a.ts}', '<src/a.ts>', 'src/a.ts.', 'src/a.ts,', 'see (`src/a.ts`).']) {
    assert.deepEqual(links(text), [['src/a.ts', 'web/src/a.ts', null, null]], text);
  }
  assert.deepEqual(links('look at `src/a.ts:4:2`, then'), [['src/a.ts:4:2', 'web/src/a.ts', 4, 2]]);
  assert.deepEqual(links('Edit .env.'), [['.env', 'web/.env', null, null]]);
});

test('a path outside the workspace root, also through .., gives no candidate', () => {
  assert.deepEqual(links('/etc/passwd'), []);
  assert.deepEqual(links('/home/u/Devx/a.ts'), []);
  assert.deepEqual(links('/home/u/a.ts'), []);
  assert.deepEqual(links('../../outside.ts'), []);
  assert.deepEqual(links('../web/../../x.ts'), []);
  assert.deepEqual(links('/home/u/Dev/../secret.ts'), []);
  assert.deepEqual(links('~/notes.md'), []);
  // The root itself, and a folder (a trailing slash), name no file.
  assert.deepEqual(links('/home/u/Dev /home/u/Dev/ src/'), []);
});

test('a plain word gives no candidate', () => {
  assert.deepEqual(links('hello world Makefile done'), []);
  // A number is no extension: a bare name needs one with a letter, or a leading dot.
  assert.deepEqual(links('Done. Version 1.2.3 is 3.14 times faster.'), []);
  assert.deepEqual(links(''), []);
  assert.deepEqual(links('... -- :: ()'), []);
});

test('an http(s) URL gives no file candidate, and the paths beside it still do', () => {
  assert.deepEqual(links('https://example.com/src/a.ts'), []);
  assert.deepEqual(links('http://localhost:4000/app.js'), []);
  assert.deepEqual(links('<https://github.com/x/y/blob/main/README.md>'), []);
  assert.deepEqual(links('open https://example.com/a.ts or src/a.ts'), [['src/a.ts', 'web/src/a.ts', null, null]]);
});

test('splitPath gives the folder that holds the file and its name', () => {
  assert.deepEqual(splitPath('web/src/a.ts'), { dir: 'web/src', name: 'a.ts' });
  assert.deepEqual(splitPath('a.ts'), { dir: '', name: 'a.ts' });
});

test('linkRange turns a text range into xterm cells, across a wrapped row and a wide character', () => {
  // "日 a.ts" over two rows: 日 takes two cells, "a." ends row 1, "ts" starts row 2.
  const cells = [
    { x: 1, y: 5, width: 2 },
    { x: 3, y: 5, width: 1 },
    { x: 4, y: 5, width: 1 },
    { x: 5, y: 5, width: 1 },
    { x: 1, y: 6, width: 1 },
    { x: 2, y: 6, width: 1 },
  ];
  assert.deepEqual(linkRange(cells, 2, 6), { start: { x: 4, y: 5 }, end: { x: 2, y: 6 } });
  assert.deepEqual(linkRange(cells, 0, 1), { start: { x: 1, y: 5 }, end: { x: 2, y: 5 } });
});

test('fileChecker lists each folder once, says which files exist, and lists again after its time', async () => {
  const calls: string[] = [];
  let clock = 0;
  const listing: Record<string, string[]> = { 'web/src': ['a.ts', 'b.ts'], web: ['.env'] };
  const exists = fileChecker(
    async (ws: string, rel: string) => {
      calls.push(`${ws}:${rel}`);
      if (!(rel in listing)) throw new Error('not a folder');
      return listing[rel];
    },
    { ttl: 1000, now: () => clock },
  );
  assert.equal(await exists('dev', 'web/src/a.ts'), true);
  assert.equal(await exists('dev', 'web/src/b.ts'), true);
  assert.equal(await exists('dev', 'web/src/missing.ts'), false);
  assert.equal(await exists('dev', 'web/.env'), true);
  // A folder that does not exist (or a failed read) is no file, and its answer is kept too.
  assert.equal(await exists('dev', 'nope/x.ts'), false);
  assert.equal(await exists('dev', 'nope/y.ts'), false);
  // Hovering again hits the cache; another workspace is another folder.
  assert.equal(await exists('dev', 'web/src/a.ts'), true);
  assert.equal(await exists('work', 'web/src/a.ts'), true);
  assert.deepEqual(calls, ['dev:web/src', 'dev:web', 'dev:nope', 'work:web/src']);
  // A file created meanwhile shows once the cached listing is older than ttl.
  listing['web/src'] = ['a.ts', 'b.ts', 'new.ts'];
  clock = 500;
  assert.equal(await exists('dev', 'web/src/new.ts'), false);
  clock = 1001;
  assert.equal(await exists('dev', 'web/src/new.ts'), true);
  assert.equal(calls.at(-1), 'dev:web/src');
});
