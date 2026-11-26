// The phone layout of the inbox (#41, option A): pure rules in public/features/phone-model.js
// (public/features/phone.js wires them). Screen width alone picks the layout; the inbox opens
// first, a card opens its terminal full-screen with a key bar that types what a keyboard types.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The browser modules have no declaration files: imported by URL, typed here.
type View = 'inbox' | 'deck' | 'terminal' | null;
type Translate = (key: string, vars?: Record<string, unknown>) => string;
type PhoneModel = {
  PHONE_MAX_WIDTH: number;
  PHONE_QUERY: string;
  KEY_BAR: Array<{ key: string; caption: string; labelKey: string }>;
  isNarrow: (width: number) => boolean;
  nextView: (view: View, change: { action: string; narrow: boolean }) => View;
  showsActiveTerminal: (view: View) => boolean;
  scrollTerminalByTouch: (view: View) => boolean;
  inboxHeader: (items: Array<{ terminalId: string; kind: string }>, stream: string | undefined, t: Translate) => { title: string; state: string; live: boolean };
  keyBytes: (key: string, mode: { applicationCursor: boolean }) => string | null;
  dragLines: (dy: number, cellHeight: number, rest?: number) => { lines: number; rest: number };
};
const { KEY_BAR, PHONE_MAX_WIDTH, PHONE_QUERY, dragLines, inboxHeader, isNarrow, keyBytes, nextView, scrollTerminalByTouch, showsActiveTerminal }: PhoneModel = await import(new URL('../public/features/phone-model.js', import.meta.url).href);
const { translate }: { translate: (language: string, key: string, vars?: Record<string, unknown>) => string } = await import(new URL('../public/i18n.js', import.meta.url).href);

const ESC = '\x1b';

test('S2: under the narrow width the page opens on the inbox; a wider screen keeps the desktop layout', () => {
  assert.equal(PHONE_MAX_WIDTH, 600);
  assert.equal(PHONE_QUERY, '(max-width: 600px)');
  for (const width of [320, 390, 412, 600]) assert.equal(isNarrow(width), true, `${width}px`);
  for (const width of [601, 720, 1280, 1440]) assert.equal(isNarrow(width), false, `${width}px`);
  assert.equal(nextView(null, { action: 'start', narrow: true }), 'inbox');
  assert.equal(nextView(null, { action: 'start', narrow: false }), null);
});

test('S2: the width alone decides: growing past it leaves any phone view, narrowing again opens on the inbox', () => {
  for (const view of ['inbox', 'deck', 'terminal', null] as const) assert.equal(nextView(view, { action: 'resize', narrow: false }), null, String(view));
  assert.equal(nextView(null, { action: 'resize', narrow: true }), 'inbox');
  for (const view of ['inbox', 'deck', 'terminal'] as const) assert.equal(nextView(view, { action: 'resize', narrow: true }), view, `${view} stays`);
  // Nothing a wide window does opens a phone view.
  for (const action of ['back', 'inbox', 'full', 'open', 'gone']) assert.equal(nextView(null, { action, narrow: false }), null, action);
});

test('S2, S9: the inbox back control returns to the deck, the full-UI link opens it, and the deck\'s inbox button comes back', () => {
  assert.equal(nextView('inbox', { action: 'back', narrow: true }), 'deck');
  assert.equal(nextView('inbox', { action: 'full', narrow: true }), 'deck');
  assert.equal(nextView('deck', { action: 'inbox', narrow: true }), 'inbox');
  assert.equal(nextView('deck', { action: 'back', narrow: true }), 'deck', 'the deck has no back');
});

test('S6: tapping a card opens its terminal full-screen; its back control, or the terminal closing, returns to the inbox', () => {
  assert.equal(nextView('inbox', { action: 'open', narrow: true }), 'terminal');
  assert.equal(nextView('deck', { action: 'open', narrow: true }), 'terminal', 'a card in the deck\'s panel drawer too');
  assert.equal(nextView('terminal', { action: 'back', narrow: true }), 'inbox');
  assert.equal(nextView('terminal', { action: 'gone', narrow: true }), 'inbox');
  assert.equal(nextView('inbox', { action: 'gone', narrow: true }), 'inbox');
});

test('S3: the header shows the count and "live" while the stream reads, "reconnecting" otherwise', () => {
  const item = (terminalId: string, kind: string) => ({ terminalId, kind });
  const items = [item('a', 'blocked'), item('b', 'error'), item('c', 'finished'), item('d', 'prompt')];
  const es = (key: string, vars?: Record<string, unknown>) => translate('es', key, vars);
  const en = (key: string, vars?: Record<string, unknown>) => translate('en', key, vars);
  assert.deepEqual(inboxHeader(items, 'live', es), { title: 'Te esperan (3)', state: 'En vivo', live: true });
  assert.deepEqual(inboxHeader(items, 'reconnecting', es), { title: 'Te esperan (3)', state: 'Reconectando…', live: false });
  assert.deepEqual(inboxHeader(items, 'live', en), { title: 'Waiting for you (3)', state: 'Live', live: true });
  assert.deepEqual(inboxHeader([], 'reconnecting', en), { title: 'Waiting for you (0)', state: 'Reconnecting…', live: false });
  // Before the stream first answers it is not live either.
  assert.equal(inboxHeader(items, undefined, en).live, false);
});

// #90: the full interface is the deck view, and a finger dragged over a terminal there must scroll the
// terminal, not the page. Everywhere a terminal is not the thing under the finger, the page keeps panning.
test('a finger scrolls a terminal in the phone terminal view and in the full interface, nowhere else', () => {
  assert.equal(scrollTerminalByTouch('terminal'), true);
  assert.equal(scrollTerminalByTouch('deck'), true, 'the full interface is the deck view');
  assert.equal(scrollTerminalByTouch('inbox'), false, 'the inbox has no terminal on screen');
  assert.equal(scrollTerminalByTouch(null), false, 'a wide window keeps the page panning');
});

test('S6: the key bar holds Enter, Esc, the four arrows and Tab, and no digit keys', () => {
  assert.deepEqual(KEY_BAR.map(({ key }) => key), ['Escape', 'Tab', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight', 'Enter']);
  assert.ok(KEY_BAR.every(({ caption }) => !/\d/.test(caption)), 'no digit captions');
  for (const { labelKey } of KEY_BAR) for (const lang of ['en', 'es']) assert.notEqual(translate(lang, labelKey), labelKey, `${lang} ${labelKey}`);
});

test('S6: each key sends the bytes xterm.js sends for it from a keyboard (src/common/input/Keyboard.ts)', () => {
  const normal = { applicationCursor: false };
  assert.equal(keyBytes('Enter', normal), '\r');
  assert.equal(keyBytes('Escape', normal), ESC);
  assert.equal(keyBytes('Tab', normal), '\t');
  assert.equal(keyBytes('ArrowUp', normal), `${ESC}[A`);
  assert.equal(keyBytes('ArrowDown', normal), `${ESC}[B`);
  assert.equal(keyBytes('ArrowRight', normal), `${ESC}[C`);
  assert.equal(keyBytes('ArrowLeft', normal), `${ESC}[D`);
  assert.equal(keyBytes('1', normal), null, 'a key the bar does not have sends nothing');
});

test('S6: in application cursor mode (DECCKM) the arrows send SS3 sequences, as xterm.js does; the other keys do not change', () => {
  const app = { applicationCursor: true };
  assert.equal(keyBytes('ArrowUp', app), `${ESC}OA`);
  assert.equal(keyBytes('ArrowDown', app), `${ESC}OB`);
  assert.equal(keyBytes('ArrowRight', app), `${ESC}OC`);
  assert.equal(keyBytes('ArrowLeft', app), `${ESC}OD`);
  assert.equal(keyBytes('Enter', app), '\r');
  assert.equal(keyBytes('Escape', app), ESC);
  assert.equal(keyBytes('Tab', app), '\t');
});

test('the inbox leaves out the active terminal\'s card only where that terminal can be on screen', () => {
  // Desktop, as before: the terminal you look at is not listed.
  assert.equal(showsActiveTerminal(null), true);
  assert.equal(showsActiveTerminal('deck'), true);
  assert.equal(showsActiveTerminal('terminal'), true);
  // The phone's inbox covers the deck: every waiting terminal is listed, the active one too.
  assert.equal(showsActiveTerminal('inbox'), false);
});

test('#67 S2, S5: a finger moving down shows older lines (the history scrolls up), moving up newer ones', () => {
  assert.deepEqual(dragLines(40, 10, 0), { lines: -4, rest: 0 });
  assert.deepEqual(dragLines(-40, 10, 0), { lines: 4, rest: 0 });
  assert.deepEqual(dragLines(25, 10), { lines: -2, rest: 5 }, 'rest defaults to 0; what is short of a line stays');
  assert.deepEqual(dragLines(-25, 10), { lines: 2, rest: -5 });
});

test('#67 S5: the pixels short of a line add up across moves; a move under one line scrolls nothing yet', () => {
  let rest = 0;
  const lines: number[] = [];
  for (const dy of [6, 6, 6, 6, 6, 6]) {
    const step = dragLines(dy, 17, rest);
    lines.push(step.lines);
    rest = step.rest;
  }
  assert.deepEqual(lines, [0, 0, -1, 0, 0, -1], '36 px over 17 px lines: a line at 18 px, the next at 36 px');
  assert.equal(rest, 2, 'what is short of the next line stays for the next move');
  assert.deepEqual(dragLines(3, 17, 0), { lines: 0, rest: 3 });
  assert.deepEqual(dragLines(-3, 17, 2), { lines: 0, rest: -1 });
  // Back the other way: the rest of the earlier direction counts against it.
  assert.deepEqual(dragLines(-20, 10, 5), { lines: 1, rest: -5 });
});

test('#67 S5: no move scrolls nothing, and neither does a cell height that is zero, negative or not a number', () => {
  assert.deepEqual(dragLines(0, 17, 0), { lines: 0, rest: 0 });
  assert.deepEqual(dragLines(0, 17, 5), { lines: 0, rest: 5 });
  for (const cellHeight of [0, -17, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(dragLines(120, cellHeight, 4), { lines: 0, rest: 0 }, String(cellHeight));
  }
  assert.deepEqual(dragLines(Number.NaN, 17, 4), { lines: 0, rest: 0 }, 'a move that is not a number');
});
