// File paths in a terminal's output, as links to the file editor (public/terminals.js). Pure: which
// text in a line is a path, where it points inside the terminal's workspace, and a cached check that
// the file exists. No DOM, no fetch: tested in test/file-links-model.test.ts.
//
// A path is a run of non-space text. Quotes, backticks and brackets around it, and trailing
// punctuation (a period, a comma, a colon…), are not part of it; a `:line` or `:line:col` suffix is
// kept aside. It is absolute, or relative to the terminal's folder (`./x`, `../x`, `a/b.ts`). A bare
// name needs an extension with a letter (`notes.md`) or a leading dot (`.env`), so a plain word or a
// number is never a path. Anything with `://` is a URL, left to xterm's WebLinksAddon. After `..` and
// `.` are resolved the path must stay below the workspace root, never be the root itself, and not
// end in `/` (a folder).

const LEADING = new Set(['"', "'", '`', '(', '[', '{', '<']);
const TRAILING = new Set(['"', "'", '`', ')', ']', '}', '>', '.', ',', ';', ':', '!', '?']);
const SUFFIX = /:(\d+)(?::(\d+))?$/;
// Characters a printed path does not hold: shell syntax, a colon left after the suffix, controls.
const NOT_IN_PATH = /["'`<>|*?$\\(){};:\u0000-\u001f]/;
const EXTENSION = /\.[\w-]*[A-Za-z][\w-]*$/;

/** The segments of `path` with `.` and empty ones dropped and `..` applied; null when `..` climbs above the first one. */
function segments(parts) {
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part !== '..') out.push(part);
    else if (!out.length) return null;
    else out.pop();
  }
  return out;
}

const startsWith = (path, prefix) => path.length > prefix.length && prefix.every((part, index) => path[index] === part);

/**
 * The workspace roots an absolute path may sit under, as segments: the configured root, and the
 * real one the terminal sees (its cwd without its folder `rel`), when they differ.
 */
function roots({ root, rel, cwd }) {
  const configured = segments(String(root ?? '').split('/')) ?? [];
  const list = [configured];
  const folder = segments(String(rel ?? '').split('/')) ?? [];
  const seen = segments(String(cwd ?? '').split('/'));
  if (seen && seen.length >= folder.length && folder.every((part, index) => seen[seen.length - folder.length + index] === part)) {
    const real = seen.slice(0, seen.length - folder.length);
    if (real.join('/') !== configured.join('/')) list.push(real);
  }
  return list;
}

/** Where `path` points, relative to the workspace root ('web/src/a.ts'), or null outside it. */
function resolve(path, place) {
  if (path.endsWith('/') || path.startsWith('~')) return null;
  if (path.startsWith('/')) {
    const parts = segments(path.split('/'));
    if (!parts) return null;
    const root = roots(place).find((prefix) => startsWith(parts, prefix));
    return root ? parts.slice(root.length).join('/') : null;
  }
  const folder = segments(String(place.rel ?? '').split('/')) ?? [];
  const parts = segments([...folder, ...path.split('/')]);
  return parts?.length ? parts.join('/') : null;
}

/** One run of non-space text at `index` as a candidate, or null. */
function candidate(token, index, place) {
  if (token.includes('://')) return null;
  let start = 0;
  let end = token.length;
  while (start < end && LEADING.has(token[start])) start += 1;
  while (end > start && TRAILING.has(token[end - 1])) end -= 1;
  const core = token.slice(start, end);
  const suffix = SUFFIX.exec(core);
  const path = suffix ? core.slice(0, suffix.index) : core;
  if (!path || NOT_IN_PATH.test(path)) return null;
  if (!path.includes('/') && !EXTENSION.test(path)) return null;
  const resolved = resolve(path, place);
  if (!resolved) return null;
  return {
    start: index + start,
    end: index + end,
    path: resolved,
    line: suffix ? Number(suffix[1]) : null,
    col: suffix?.[2] ? Number(suffix[2]) : null,
  };
}

/**
 * The paths in one line of terminal text, in order: `{ start, end, path, line, col }`, where
 * `text.slice(start, end)` is the linked text (the path and its suffix), `path` is relative to the
 * workspace root, and `line`/`col` come from the suffix (null without one). `place` is the
 * terminal's `{ root, rel, cwd }`: the workspace root, its folder below it and its real cwd.
 */
export function findFileLinks(text, place) {
  if (!place?.root) return [];
  const found = [];
  for (const match of String(text ?? '').matchAll(/\S+/g)) {
    const link = candidate(match[0], match.index, place);
    if (link) found.push(link);
  }
  return found;
}

/** The folder that holds `path` (relative to the root, '' for the root) and the file's name. */
export function splitPath(path) {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? { dir: '', name: path } : { dir: path.slice(0, cut), name: path.slice(cut + 1) };
}

/**
 * The xterm range (1-based cells, end inclusive) of text `start`..`end`, given each character's
 * cell `{ x, y, width }` (1-based; a wide character takes two cells).
 */
export function linkRange(cells, start, end) {
  const first = cells[start];
  const last = cells[end - 1];
  return { start: { x: first.x, y: first.y }, end: { x: last.x + last.width - 1, y: last.y } };
}

/**
 * `exists(ws, path)` → Promise<boolean>: whether `path` (relative to the root of workspace `ws`)
 * names a file. `listFolder(ws, rel)` resolves to the names of the files in folder `rel`; each
 * folder is listed once per `ttl` ms, so hovering over and over asks nothing new. A failed listing
 * (no such folder) counts as no files, kept as long. At most `max` folders are kept.
 */
export function fileChecker(listFolder, { ttl = 30_000, now = Date.now, max = 200 } = {}) {
  const cache = new Map();
  return (ws, path) => {
    const { dir, name } = splitPath(path);
    const key = `${ws}\n${dir}`;
    let entry = cache.get(key);
    if (!entry || now() - entry.at > ttl) {
      const names = Promise.resolve()
        .then(() => listFolder(ws, dir))
        .then((list) => new Set(list), () => new Set());
      entry = { at: now(), names };
      cache.delete(key);
      cache.set(key, entry);
      while (cache.size > max) cache.delete(cache.keys().next().value);
    }
    return entry.names.then((names) => names.has(name));
  };
}
