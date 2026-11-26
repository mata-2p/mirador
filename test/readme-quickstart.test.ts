// The README's Quickstart against the app and the installer it describes (the stranger test, L33): it says
// which language the interface starts in and where to switch it, with the labels the app shows. The README
// quotes interface text in English only and README.es.md in Spanish only (S30), each with the app's own
// strings; the install detail moved to docs/install.md, which quotes the English too, and its Requirements
// give the build tools' install commands that install.sh prints (test/install-script.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The public/ modules have no type declarations; a URL import keeps them typed here.
const { MESSAGES, pickLanguage }: { MESSAGES: Record<string, Record<string, string>>; pickLanguage: (saved: unknown, browser: unknown) => string } = await import(new URL('../public/i18n.js', import.meta.url).href);
const { LANGUAGE_CHOICES }: { LANGUAGE_CHOICES: { value: string; text: string }[] } = await import(new URL('../public/settings-model.js', import.meta.url).href);

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const README = read('README.md');
const README_ES = read('README.es.md');
const INSTALL = read('docs/install.md');

/** The text under `## <title>`, up to the next `## ` heading. */
function section(text: string, title: string): string {
  const start = text.indexOf(`\n## ${title}\n`);
  if (start < 0) return '';
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}
const QUICKSTART = section(README, 'Quickstart');
const INICIO = section(README_ES, 'Inicio rápido');
const en = (key: string) => MESSAGES.en[key];
const es = (key: string) => MESSAGES.es[key];
const choices = (or: string) => LANGUAGE_CHOICES.map((choice) => `**${choice.text}**`).join(` ${or} `);

test('the Quickstart says the interface follows the browser\'s language until one is chosen, and names where to choose it', () => {
  assert.ok(QUICKSTART, 'README has a Quickstart');
  // What the sentence claims is what the app does with no saved choice.
  for (const tag of ['es', 'es-CL', 'es-419']) assert.equal(pickLanguage(null, { languages: [tag] }), 'es', tag);
  for (const tag of ['en-US', 'pt-BR', '']) assert.equal(pickLanguage(null, { languages: [tag] }), 'en', tag);
  const sentence =
    "The interface follows the browser's language (Spanish for `es-*`, English otherwise) until you choose one in " +
    `**${en('settings.label')}** (the sliders button at the top right) → **${en('settings.language')}**, with ${choices('or')}.`;
  assert.ok(QUICKSTART.includes(sentence), sentence);
  assert.ok(!QUICKSTART.includes('starts in Spanish'), 'no fixed starting language');
  assert.ok(!README.includes('quoted as Spanish / English'), 'the README no longer quotes the interface in both languages');
});

test('README.es.md says the same in Spanish, with the Spanish labels', () => {
  assert.ok(INICIO, 'README.es.md has an Inicio rápido');
  const sentence =
    'La interfaz sigue el idioma del navegador (español para `es-*`, inglés en otro caso) hasta que eliges uno en ' +
    `**${es('settings.label')}** (el botón de los controles deslizantes, arriba a la derecha) → **${es('settings.language')}**, con ${choices('o')}.`;
  assert.ok(INICIO.includes(sentence), sentence);
  assert.ok(README_ES.includes('[English](README.md) · Español'), 'the language switch line');
  assert.ok(README.includes('English · [Español](README.es.md)'), 'the language switch line');
});

test('the README quotes the interface in English and README.es.md in Spanish, with the app\'s own strings', () => {
  const keys = ['overview.leftOff', 'tracking.title', 'changes.view', 'inbox.notify.turnOn', 'night.title', 'files.action'];
  for (const key of keys) {
    assert.ok(README.includes(`**${en(key)}**`), `README quotes ${key} as **${en(key)}**`);
    assert.ok(!README.includes(`**${es(key)}`), `README does not quote ${key} in Spanish`);
    assert.ok(README_ES.includes(`**${es(key)}**`), `README.es.md quotes ${key} as **${es(key)}**`);
  }
  const inbox = (lang: string) => MESSAGES[lang]['panel.view.inbox'].replace('{count}', 'N');
  assert.ok(README.includes(`**${inbox('en')}**`) && !README.includes(`**${inbox('es')}**`), inbox('en'));
  assert.ok(README_ES.includes(`**${inbox('es')}**`), inbox('es'));
  assert.ok(README.includes(`"${en('sleeping.wake')}"`) && README_ES.includes(`"${es('sleeping.wake')}"`), 'the Wake edge of the restart diagram');
});

test('the interface text docs/install.md quotes is the English alone', () => {
  const quoted = (lang: string, key: string, end: string) => { const text = MESSAGES[lang][key]; return text.slice(0, text.indexOf(end)); };
  for (const [key, end] of [['error.workspace_root_missing', '.'], ['resources.limits.macos', ':']]) {
    assert.ok(INSTALL.includes(`*${quoted('en', key, end)}*`), quoted('en', key, end));
    assert.ok(!INSTALL.includes(quoted('es', key, end)), `the Spanish of ${key} is not quoted`);
  }
  assert.ok(INSTALL.includes(`**${en('resources.pane')}** pane`));
  assert.ok(!INSTALL.includes(`**${es('resources.pane')}`), 'the Spanish pane name is not quoted');
});

test('the README names the "where it left off" panel as the app does, in the capability table and How it works', () => {
  const lines = (text: string, start: string) => text.split('\n').find((line) => line.startsWith(start));
  const capability = lines(README, '| [Where it left off](docs/attention.md#where-it-left-off) |');
  assert.ok(capability?.includes(`**${en('overview.leftOff')}**`), capability);
  const howItWorks = lines(README, 'One local server, started by `mirador`');
  assert.ok(howItWorks?.includes(`**${en('overview.leftOff')}**`), howItWorks);
  const capacidad = lines(README_ES, '| [Dónde quedó](docs/attention.md#where-it-left-off) |');
  assert.ok(capacidad?.includes(`**${es('overview.leftOff')}**`), capacidad);
  const comoFunciona = lines(README_ES, 'Un servidor local, que arranca `mirador`');
  assert.ok(comoFunciona?.includes(`**${es('overview.leftOff')}**`), comoFunciona);
});

test('the Quickstart puts the one-line install first, then starting it and the workspace folder, and points to docs/install.md', () => {
  const line = 'curl -fsSL https://raw.githubusercontent.com/mata-2p/mirador/main/scripts/bootstrap.sh | sh';
  const at = (text: string) => QUICKSTART.indexOf(text);
  assert.ok(at(line) > 0, 'the one-line install');
  assert.ok(at(line) < at('**Starting it.**') && at('**Starting it.**') < at('**The workspace folder.**'), 'install, start, folder');
  assert.ok(QUICKSTART.includes('](docs/install.md)'), 'the link to the install guide');
  assert.ok(INSTALL.includes('](../README.md#quickstart)'), 'the install guide links back to the Quickstart');
});

// L21: the prebuilt install takes no options, so the Quickstart names none; it says what the first start shows
// (src/config.ts defaults(): a Dev workspace on ~/Dev, or on the home folder) and how to add a workspace from the
// app, with the labels public/index.html and public/features/workspaces.js show.
test('the Quickstart names no installer option, says what the first start shows and how to add a workspace from the app', () => {
  for (const [text, name] of [[QUICKSTART, 'README.md'], [INICIO, 'README.es.md']] as const) assert.ok(!text.includes('--root'), `${name} names no --root`);
  assert.ok(
    QUICKSTART.includes('On the first start, with no config file yet, it shows one workspace, Dev, on `~/Dev`, or on your home folder when `~/Dev` does not exist.'),
    'the first start, in English',
  );
  assert.ok(
    INICIO.includes('En el primer arranque, sin archivo de configuración todavía, muestra un workspace, Dev, sobre `~/Dev`, o sobre tu carpeta personal cuando `~/Dev` no existe.'),
    'the first start, in Spanish',
  );
  const steps = (lang: (key: string) => string, click: string, beside: string, sidebar: string, inside: string) =>
    `${click} **${lang('ws.addShort')}** ${beside} **${lang('ws.heading')}** ${sidebar}; ${inside} **${lang('ws.addTitle')}**`;
  assert.ok(QUICKSTART.includes(steps(en, 'click', 'next to', 'in the sidebar', 'in')), 'the English steps');
  assert.ok(INICIO.includes(steps(es, 'haz clic en', 'junto a', 'en la barra lateral', 'en')), 'the Spanish steps');
  for (const key of ['ws.addRootLabel', 'ws.addNameLabel', 'ws.addSubmit']) {
    assert.ok(QUICKSTART.includes(`**${en(key)}**`), `README quotes ${key} as **${en(key)}**`);
    assert.ok(INICIO.includes(`**${es(key)}**`), `README.es.md quotes ${key} as **${es(key)}**`);
  }
  assert.ok(INSTALL.includes('The prebuilt release writes no config: with none, Mirador shows one workspace, Dev, on `~/Dev`'), 'docs/install.md says it too');
});

test('the Requirements give the commands install.sh prints for python3, make and a C++ compiler', () => {
  const requirements = section(INSTALL, 'Requirements');
  assert.ok(requirements, 'docs/install.md has a Requirements section');
  for (const command of ['sudo apt install python3 make g++', 'sudo dnf install python3 make gcc-c++', 'sudo pacman -S python make gcc', 'xcode-select --install']) {
    assert.ok(requirements.includes(`\`${command}\``), command);
  }
});
