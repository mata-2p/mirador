// The card's idle-sleep reason ("Awake: npm is still running", #115) puts the program's name into the page
// as text, never as HTML: public/features/tracking.js builds that line with core.js el() from the i18n
// string, and el() appends a string child as a text node. A name such as `<img src=x>` shows as written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';

const publicDir = new URL('../public/', import.meta.url);
// The browser paths of public/ ('/i18n.js') as Node files.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('/') && context.parentURL?.startsWith(publicDir.href)) return { url: new URL(specifier.slice(1), publicDir).href, shortCircuit: true };
    return next(specifier, context);
  },
});

/** An element that records what is appended and refuses HTML. */
class FakeElement {
  readonly tag: string;
  readonly children: unknown[] = [];
  readonly attributes: Record<string, string> = {};
  className = '';
  constructor(tag: string) {
    this.tag = tag;
  }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener() {}
  append(...nodes: unknown[]) { this.children.push(...nodes); }
  set innerHTML(_html: string) { throw new Error('innerHTML was set'); }
  insertAdjacentHTML() { throw new Error('insertAdjacentHTML was called'); }
}
(globalThis as any).document = { documentElement: { dataset: {} }, createElement: (tag: string) => new FakeElement(tag) };
const { el } = await import(new URL('core.js', publicDir).href);
const { translate } = await import(new URL('i18n.js', publicDir).href);

const NAME = '<img src=x onerror=alert(1)>';

test('the awake line carries the program name as a text node, as written, in both languages', () => {
  for (const [lang, text] of [['en', `Awake: ${NAME} is still running`], ['es', `Despierto: ${NAME} sigue corriendo`]] as const) {
    assert.equal(translate(lang, 'tracking.awake', { name: NAME }), text, 'the i18n string inserts the name unchanged');
    const line = el('span', { class: 'tracking-awake' }, translate(lang, 'tracking.awake', { name: NAME }));
    assert.deepEqual(line.children, [text], 'one string child: the DOM makes it a text node');
    assert.equal(line.className, 'tracking-awake');
  }
});

test('public/features/tracking.js builds the awake line with el() from t(), with no HTML sink in the tracking view', async () => {
  const source = await readFile(new URL('features/tracking.js', publicDir), 'utf8');
  assert.match(source, /el\('span', \{ class: 'tracking-awake' \}, t\('tracking\.awake', \{ name: agent\.awake \}\)\)/);
  for (const file of ['features/tracking.js', 'features/tracking-model.js', 'core.js', 'i18n.js']) {
    const text = await readFile(new URL(file, publicDir), 'utf8');
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML/.test(text), false, `${file} has no HTML sink`);
  }
});
