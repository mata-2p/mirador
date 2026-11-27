// The web UI bundled at boot: the real server, once on the repo's public/
// and once on a scratch copy of it (MIRADOR_PUBLIC_DIR) that the tests break, fix and edit.
// Minified, gzip and brotli copies per Accept-Encoding,
// content-hashed names cached for a year, and `/` (index.html) never cached.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { SECURITY_HEADERS } from '../src/http/respond.ts';
import { bundledPage } from '../src/http/bundle.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(APP_DIR, 'public');
const CSP = "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

type Running = { child: ChildProcess; base: string; port: number; output: () => string };
let scratch: string;
let copy: string;
let real: Running;
let copied: Running;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return typeof address === 'object' && address ? address.port : 0;
}

async function waitFor<T>(check: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out');
}

async function start(name: string, env: Record<string, string> = {}): Promise<Running> {
  const dir = join(scratch, name);
  await mkdir(join(dir, 'cfg', 'mirador'), { recursive: true });
  await mkdir(join(dir, 'root'), { recursive: true });
  await writeFile(join(dir, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root: join(dir, 'root'), engramUrl: 'http://127.0.0.1:1' }));
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: { ...process.env, HOME: join(dir, 'home'), XDG_RUNTIME_DIR: join(dir, 'run'), XDG_STATE_HOME: join(dir, 'state'), XDG_CONFIG_HOME: join(dir, 'cfg'), MIRADOR_PORT: String(port), MIRADOR_SCOPES: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (d) => (output += d));
  child.stderr?.on('data', (d) => (output += d));
  try {
    await waitFor(async () => JSON.parse(await readFile(join(dir, 'run', 'mirador', 'state.json'), 'utf8')));
  } catch {
    // A server that never started is stopped here: left running, it would keep this test file alive for ever.
    await stop(child);
    throw new Error(`the ${name} server did not start (exit ${child.exitCode ?? child.signalCode}):\n${output}`);
  }
  return { child, base: `http://127.0.0.1:${port}`, port, output: () => output };
}

/** Stops a server and waits for it to exit; one that already exited resolves at once. */
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
}

async function text(base: string, path: string): Promise<string> {
  const response = await fetch(`${base}${path}`);
  assert.equal(response.status, 200, path);
  return response.text();
}

/** How often the server logged a failed bundle, once its output has arrived through the pipe. */
async function failures(running: Running, expected: number): Promise<number> {
  const count = () => running.output().match(/mirador: bundling public\/ failed/g)?.length ?? 0;
  await waitFor(async () => (count() >= expected ? true : undefined), 3000).catch(() => undefined);
  return count();
}

/** The static assets a page loads: every src and href except in-page fragments (the icon sprite's #i-…). */
function assets(html: string): string[] {
  return [...html.matchAll(/\s(?:src|href)="([^"#][^"]*)"/g)].map((m) => m[1]);
}

type Raw = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };

/** A GET through node:http with exactly `headers`: no default Accept-Encoding and no decoding of the body. */
function raw(port: number, path: string, headers: Record<string, string> = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const HASHED_JS = /^\/bundle\/app\.[0-9a-f]{12}\.js$/;
const HASHED_CSS = /^\/bundle\/app\.[0-9a-f]{12}\.css$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** The hashed JS and CSS URLs the current `/` references. */
async function bundleUrls(running: Running): Promise<{ js: string; css: string }> {
  const loaded = assets(await text(running.base, '/'));
  const js = loaded.find((url) => HASHED_JS.test(url));
  const css = loaded.find((url) => HASHED_CSS.test(url));
  assert.ok(js && css, `hashed bundle URLs in ${loaded.join(' ')}`);
  return { js, css };
}

/** A GET through node:http, which (unlike fetch) lets the test send a foreign Host header. */
function rawGet(port: number, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-bundle-')));
  copy = join(scratch, 'public');
  await cp(PUBLIC, copy, { recursive: true });
  // At boot: the copy starts with a module esbuild cannot parse.
  await writeFile(join(copy, 'drawer-model.js'), (await readFile(join(PUBLIC, 'drawer-model.js'), 'utf8')) + '\nexport const broken = ;\n');
  // Both start before either failure is thrown, so after() stops the one that did start.
  const [first, second] = await Promise.allSettled([start('real'), start('copied', { MIRADOR_PUBLIC_DIR: copy })]);
  if (first.status === 'fulfilled') real = first.value;
  if (second.status === 'fulfilled') copied = second.value;
  for (const result of [first, second]) if (result.status === 'rejected') throw result.reason;
});

after(async () => {
  for (const running of [real, copied]) if (running) await stop(running.child);
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

test('S1: / loads the two boot scripts first, then one JS bundle, one CSS bundle and the icon', async () => {
  const html = await text(real.base, '/');
  const loaded = assets(html);
  assert.deepEqual(loaded.slice(0, 3), ['/launch-boot.js', '/icon.svg', '/theme-boot.js']);
  assert.equal(loaded.length, 5);
  assert.match(loaded[3], HASHED_CSS);
  assert.match(loaded[4], HASHED_JS);
  assert.ok(loaded.length + 1 <= 10, 'about 10 static requests or fewer, with the HTML');
  assert.match(html, /<script src="\/launch-boot\.js"><\/script>/);
  assert.match(html, /<script src="\/theme-boot\.js"><\/script>/);
  assert.match(html, /<script type="module" src="\/bundle\/app\.[0-9a-f]{12}\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/bundle\/app\.[0-9a-f]{12}\.css">/);
  assert.doesNotMatch(html, /<script>|<style>/, 'no inline script or style');
});

test('B1 minify: the JS and CSS bundles are minified (no source comments, a few long lines)', async () => {
  const { js, css } = await bundleUrls(real);
  const code = await text(real.base, js);
  assert.doesNotMatch(code, /Entry point: signs in, loads the config/, "public/app.js's first comment is gone");
  assert.ok(code.split('\n').length < 200, `${code.split('\n').length} lines; unminified it is ~25 000`);
  const sheet = await text(real.base, css);
  assert.doesNotMatch(sheet, /One stylesheet per feature|\/\*(?!!)/, 'no CSS comments except legal ones');
  assert.match(sheet, /\.topbar\{/, 'rules without the source spacing');
});

test('B1 encoding: br, gzip or identity per Accept-Encoding, each the same bytes, always with vary', async () => {
  const { js } = await bundleUrls(real);
  for (const path of ['/', js]) {
    const identity = await raw(real.port, path);
    assert.equal(identity.status, 200, path);
    assert.equal(identity.headers['content-encoding'], undefined, `${path} without Accept-Encoding is identity`);
    assert.equal(identity.headers.vary, 'accept-encoding', `${path} identity`);
    assert.equal(identity.headers['content-length'], String(identity.body.length), path);
    for (const [accept, encoding] of [
      ['br, gzip', 'br'],
      ['gzip, deflate, br, zstd', 'br'],
      ['gzip', 'gzip'],
      ['br;q=0, gzip', 'gzip'],
      ['GZIP;q=0.5', 'gzip'],
      ['*', 'br'],
      ['identity', undefined],
      ['gzip;q=0, br;q=0', undefined],
      ['deflate, zstd', undefined],
    ] as const) {
      const response = await raw(real.port, path, { 'accept-encoding': accept });
      assert.equal(response.status, 200, `${path} ${accept}`);
      assert.equal(response.headers['content-encoding'], encoding, `${path} ${accept}`);
      assert.equal(response.headers.vary, 'accept-encoding', `${path} ${accept}`);
      assert.equal(response.headers['content-length'], String(response.body.length), `${path} ${accept}`);
      const decoded = encoding === 'br' ? brotliDecompressSync(response.body) : encoding === 'gzip' ? gunzipSync(response.body) : response.body;
      assert.ok(decoded.equals(identity.body), `${path} ${accept} decodes to the identity body`);
      if (encoding) assert.ok(response.body.length < identity.body.length / 2, `${path} ${accept} is compressed`);
    }
  }
});

test('B1 acceptance: the JS bundle transferred with brotli stays under 200 kB', async () => {
  const { js } = await bundleUrls(real);
  // The build compresses at a fast quality; a better copy replaces it in the background within seconds.
  const size = await waitFor(async () => {
    const { body } = await raw(real.port, js, { 'accept-encoding': 'br' });
    return body.length < 200_000 ? body.length : undefined;
  }, 8000);
  assert.ok(size < 200_000, `${size} bytes`);
  const gzip = await raw(real.port, js, { 'accept-encoding': 'gzip' });
  assert.ok(gzip.body.length < 260_000, `gzip ${gzip.body.length} bytes`);
});

test('B1 caching: hashed bundles are immutable for a year, / and the fixed bundle URLs revalidate', async () => {
  const { js, css } = await bundleUrls(real);
  for (const path of [js, css]) assert.equal((await raw(real.port, path)).headers['cache-control'], IMMUTABLE, path);
  for (const path of ['/', '/bundle/app.js', '/bundle/app.css']) assert.equal((await raw(real.port, path)).headers['cache-control'], 'no-cache', path);
  // The fixed URLs (/bundle/app.js, /bundle/app.css) still answer the current build, compressed alike.
  assert.ok((await raw(real.port, '/bundle/app.js')).body.equals((await raw(real.port, js)).body));
  assert.ok((await raw(real.port, '/bundle/app.css', { 'accept-encoding': 'gzip' })).body.equals((await raw(real.port, css, { 'accept-encoding': 'gzip' })).body));
  assert.equal((await raw(real.port, '/bundle/app.000000000000.js')).status, 404, 'a hash that was never built');
});

test('S1: the JS bundle is self-contained and includes the xterm vendor modules', async () => {
  const response = await fetch(`${real.base}${(await bundleUrls(real)).js}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
  const js = await response.text();
  assert.doesNotMatch(js, /(?:^|[;\n}])\s*(?:import|export)\s[^;\n]*?\bfrom\s*["'](?:\.|\/)/, 'no relative or absolute import ... from left');
  assert.doesNotMatch(js, /(?:^|[;\n}])\s*import\s*["'](?:\.|\/)/, 'no side-effect import left');
  assert.doesNotMatch(js, /\bimport\s*\(\s*["']/, 'no dynamic import left');
  assert.doesNotMatch(js, /["']\/vendor\//, 'no /vendor URL left');
  assert.match(js, /xterm-helper-textarea/, 'xterm');
  assert.match(js, /getPropertyValue\("padding-right"\)/, 'the fit addon');
  assert.match(js, /registerLinkProvider/, 'the web-links addon');
  // Minified names change; string literals stay: the session key of public/core.js, the start-up call of public/app.js.
  assert.match(js, /["']mirador\.token["']/, 'public/core.js');
  assert.match(js, /["']\/api\/bootstrap["']/, 'public/app.js');
});

test('S1: the CSS bundle holds every stylesheet, xterm.css first', async () => {
  const response = await fetch(`${real.base}${(await bundleUrls(real)).css}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/css; charset=utf-8');
  const css = await response.text();
  const xterm = css.indexOf('.xterm .xterm-helper-textarea');
  const topbar = css.search(/\}\.topbar\{/);
  assert.ok(xterm >= 0, 'a rule from xterm.css');
  assert.ok(topbar > xterm, 'a rule from styles.css, after xterm.css');
  assert.doesNotMatch(css, /@import/);
});

test('S4: the bundle URLs answer with the same security headers, CSP and Host check as every page', async () => {
  const { js, css } = await bundleUrls(real);
  for (const path of ['/', '/bundle/app.js', '/bundle/app.css', js, css]) {
    const response = await fetch(`${real.base}${path}`);
    assert.equal(response.status, 200, path);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(response.headers.get(name), value, `${path} ${name}`);
    assert.equal(response.headers.get('content-security-policy'), CSP, path);
    assert.equal(response.headers.get('cache-control'), path === js || path === css ? IMMUTABLE : 'no-cache', path);
    assert.equal(response.headers.get('set-cookie'), null, path);
    assert.equal(await rawGet(real.port, path, `evil.example:${real.port}`), 421, `${path} with a foreign Host`);
    assert.equal((await fetch(`${real.base}${path}`, { method: 'POST', headers: { origin: 'https://evil.example' } })).status, 405, `${path} POST`);
  }
});

test('S4: the unbundled files stay at their URLs, byte for byte', async () => {
  for (const [path, file] of [
    ['/index.html', 'public/index.html'],
    ['/app.js', 'public/app.js'],
    ['/core.js', 'public/core.js'],
    ['/styles.css', 'public/styles.css'],
    ['/styles/dialog.css', 'public/styles/dialog.css'],
    ['/launch-boot.js', 'public/launch-boot.js'],
    ['/vendor/xterm.mjs', 'node_modules/@xterm/xterm/lib/xterm.mjs'],
    ['/vendor/xterm.css', 'node_modules/@xterm/xterm/css/xterm.css'],
  ]) {
    assert.equal(await text(real.base, path), await readFile(join(APP_DIR, file), 'utf8'), path);
  }
  assert.equal((await fetch(`${real.base}/bundle/missing.js`)).status, 404);
  assert.equal((await fetch(`${real.base}/../package.json`)).status, 404);
});

test('S3 and S2: a public/ esbuild cannot bundle starts unbundled, logs once, and the fix bundles on the next reload', async () => {
  // Boot failure: the server started (before) and serves today's page and modules.
  for (let i = 0; i < 3; i++) assert.equal(await text(copied.base, '/'), await readFile(join(copy, 'index.html'), 'utf8'));
  assert.equal((await fetch(`${copied.base}/app.js`)).status, 200);
  assert.equal((await fetch(`${copied.base}/drawer-model.js`)).status, 200);
  assert.equal((await fetch(`${copied.base}/vendor/xterm.mjs`)).status, 200);
  assert.equal((await fetch(`${copied.base}/bundle/app.js`)).status, 404, 'no bundle while bundling fails');
  assert.equal(await failures(copied, 1), 1, copied.output());
  // The fallback is served as before: from disk, uncompressed, revalidated.
  const fallback = await raw(copied.port, '/', { 'accept-encoding': 'br, gzip' });
  assert.equal(fallback.headers['content-encoding'], undefined);
  assert.equal(fallback.headers['cache-control'], 'no-cache');
  assert.equal(fallback.body.toString('utf8'), await readFile(join(copy, 'index.html'), 'utf8'));

  // The fix is served on the next reload, without a restart.
  await writeFile(join(copy, 'drawer-model.js'), await readFile(join(PUBLIC, 'drawer-model.js'), 'utf8'));
  const fixed = assets(await text(copied.base, '/')).slice(-2);
  assert.match(fixed[0], HASHED_CSS);
  assert.match(fixed[1], HASHED_JS);
  assert.doesNotMatch(await text(copied.base, fixed[1]), /export const broken/);

  // An edit to a module and to a stylesheet reaches the next request.
  await writeFile(join(copy, 'core.js'), (await readFile(join(copy, 'core.js'), 'utf8')) + '\nconsole.info("edited-core-marker");\n');
  await writeFile(join(copy, 'styles', 'credits.css'), (await readFile(join(copy, 'styles', 'credits.css'), 'utf8')) + '\n.edited-css-marker { color: red; }\n');
  assert.match(await text(copied.base, '/bundle/app.js'), /edited-core-marker/);
  assert.match(await text(copied.base, '/bundle/app.css'), /\.edited-css-marker/);

  // On a rebuild: a new break falls back to the unbundled page again, logged once more.
  await writeFile(join(copy, 'core.js'), (await readFile(join(copy, 'core.js'), 'utf8')) + '\nexport const broken = ;\n');
  for (let i = 0; i < 3; i++) assert.equal(await text(copied.base, '/'), await readFile(join(copy, 'index.html'), 'utf8'));
  assert.equal(await failures(copied, 2), 2, copied.output());
  assert.equal((await fetch(`${copied.base}/core.js`)).status, 200);
});

test('B1 hot reload: an edit in public/ changes the hash on the next /, and the old hash answers 404', async () => {
  await writeFile(join(copy, 'core.js'), await readFile(join(PUBLIC, 'core.js'), 'utf8'));
  await writeFile(join(copy, 'styles', 'credits.css'), await readFile(join(PUBLIC, 'styles', 'credits.css'), 'utf8'));
  const first = await bundleUrls(copied);
  assert.equal((await raw(copied.port, first.js)).status, 200);
  assert.deepEqual(await bundleUrls(copied), first, 'no edit, same hashes');

  await writeFile(join(copy, 'core.js'), (await readFile(join(PUBLIC, 'core.js'), 'utf8')) + '\nconsole.info("hash-marker");\n');
  const second = await bundleUrls(copied);
  assert.notEqual(second.js, first.js, 'the JS hash changed');
  assert.equal(second.css, first.css, 'the CSS did not change, nor its hash');
  assert.match(await text(copied.base, second.js), /hash-marker/);
  const old = await raw(copied.port, first.js, { 'accept-encoding': 'br' });
  assert.equal(old.status, 404, 'an old hash is gone: the page reloads / first (no-cache) and gets the new one');
  assert.equal(old.headers['cache-control'], 'no-store', 'the 404 is not cached');

  await writeFile(join(copy, 'styles', 'credits.css'), (await readFile(join(PUBLIC, 'styles', 'credits.css'), 'utf8')) + '\n.hash-css-marker { color: red; }\n');
  const third = await bundleUrls(copied);
  assert.notEqual(third.css, second.css, 'the CSS hash changed');
  assert.equal(third.js, second.js);
  assert.match(await text(copied.base, third.css), /\.hash-css-marker/);
});

test('S2: 20 parallel bundle requests after an edit share one rebuild and all get the edit', async () => {
  const builds = () => copied.output().match(/bundled public\//g)?.length ?? 0;
  await writeFile(join(copy, 'core.js'), (await readFile(join(PUBLIC, 'core.js'), 'utf8')) + '\nconsole.info("parallel-marker");\n');
  const before = builds();
  const bodies = await Promise.all(Array.from({ length: 20 }, () => text(copied.base, '/bundle/app.js')));
  for (const body of bodies) assert.match(body, /parallel-marker/);
  await waitFor(async () => (builds() > before ? true : undefined), 3000);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(builds() - before, 1, copied.output());
});

test('S4: traversal under /bundle/ and /vendor/ stays 404', async () => {
  for (const path of ['/bundle/..%2fpackage.json', '/bundle/%2e%2e/package.json', '/vendor/../package.json', '/bundle/../src/server.ts']) {
    assert.equal((await fetch(`${real.base}${path}`)).status, 404, path);
  }
});

test('B1: a hashed URL answers the build its page named until / or a fixed URL rebuilds', async () => {
  const first = await bundleUrls(copied);
  await new Promise((r) => setTimeout(r, 1100));
  await writeFile(join(copy, 'core.js'), (await readFile(join(PUBLIC, 'core.js'), 'utf8')) + '\nconsole.info("stale-marker");\n');
  const stale = await raw(copied.port, first.js);
  assert.equal(stale.status, 200, 'no rebuild until / or a fixed URL asks');
  assert.doesNotMatch(stale.body.toString(), /stale-marker/);
  assert.match(await text(copied.base, '/bundle/app.js'), /stale-marker/, 'the fixed URL rebuilds');
  assert.equal((await raw(copied.port, first.js)).status, 404);
  assert.equal((await raw(real.port, (await bundleUrls(real)).js.replace(/\.js$/, '.css'))).status, 404, 'a JS hash with the CSS extension');
});

test('B1: the bundled page differs from the fixed-name page only in its two asset URLs', async () => {
  const html = await text(real.base, '/');
  const { js, css } = await bundleUrls(real);
  const fixed = html.replace(js, '/bundle/app.js').replace(css, '/bundle/app.css');
  assert.equal(fixed, bundledPage(await readFile(join(PUBLIC, 'index.html'), 'utf8')).html);
});
