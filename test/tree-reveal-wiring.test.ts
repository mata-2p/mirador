// The wiring of the tree reveal (tree-reveal-model.js): only a tab click, or a press on a grid tile
// that makes a different terminal active, asks the sidebar to reveal the terminal's place, and the
// reveal opens and closes rows without saving the user's layout.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const terminalsJs = readFileSync('public/terminals.js', 'utf8');
const workspacesJs = readFileSync('public/features/workspaces.js', 'utf8');

/** The source of `function name(…) { … }` in `source`, up to the next top-level closing brace. */
function fn(source: string, name: string): string {
  const start = source.search(new RegExp(`(export )?(async )?function ${name}\\(`));
  assert.ok(start >= 0, `function ${name}`);
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
}

/** The source of the nested `function name(…) { … }` in `source`, up to its two-space closing brace. */
function nested(source: string, name: string): string {
  const start = source.search(new RegExp(`\\n  (async )?function ${name}\\(`));
  assert.ok(start >= 0, `nested function ${name}`);
  return source.slice(start, source.indexOf('\n  }\n', start) + 4);
}

const count = (source: string, needle: string) => source.split(needle).length - 1;

test('S2 When: a tab click reveals the terminal\'s place, beside its activation', () => {
  const mount = fn(terminalsJs, 'mountTerminal');
  assert.match(mount, /onclick: \(\) => activateTerminal\(info\.id\) \}/);
  assert.match(mount, /\n  tab\.addEventListener\('click', \(\) => revealTerminal\(info\.id\)\);/);
  const reveal = fn(terminalsJs, 'revealTerminal');
  assert.match(reveal, /const info = terminals\.get\(id\)\?\.info;/);
  assert.match(reveal, /if \(info\) emit\('reveal', \{ workspaceId: info\.workspaceId, rel: info\.rel \?\? '' \}\);/);
});

test('S2 When / does not trigger: a tile press reveals only when its terminal was not the active one', () => {
  const mount = fn(terminalsJs, 'mountTerminal');
  assert.match(mount, /onmousedown: \(event\) => pressTile\(info\.id, event\)/);
  assert.doesNotMatch(mount, /onmousedown: \(\) => activateTerminal/);
  const press = fn(terminalsJs, 'pressTile');
  const switching = press.indexOf("const switching = id !== activeId && !event.target.closest?.('.close');");
  const activate = press.indexOf('activateTerminal(id, false);');
  const reveal = press.indexOf('if (switching) revealTerminal(id);');
  assert.ok(switching >= 0 && activate > switching && reveal > activate, 'it reads the active terminal before activating, then reveals');
});

test('S2 does not trigger: activation from any other path never reveals', () => {
  // One emitter, called from the tab click and the tile press only.
  assert.equal(count(terminalsJs, "emit('reveal'"), 1);
  assert.equal(count(terminalsJs, 'revealTerminal('), 3, 'its definition, the tab click and the tile press');
  assert.equal(count(fn(terminalsJs, 'mountTerminal'), 'revealTerminal('), 1);
  assert.equal(count(fn(terminalsJs, 'pressTile'), 'revealTerminal('), 1);
  for (const name of ['activateTerminal', 'tabKeys', 'initTerminals']) assert.doesNotMatch(fn(terminalsJs, name), /reveal/i, name);
  // The sidebar reveals on 'reveal' only; 'activate' (a new terminal, a restore, a shortcut, the inbox) only marks.
  assert.match(fn(workspacesJs, 'init'), /\n  on\('reveal', revealPlace\);/);
  assert.equal(count(workspacesJs, 'revealPlace('), 1, 'its definition only');
  assert.equal(count(workspacesJs, 'revealPlace'), 2, 'its definition and the reveal listener');
  const activate = workspacesJs.match(/on\('activate', \(\) => \{([\s\S]*?)\n  \}\);/)?.[1] ?? '';
  assert.match(activate, /markActive\(\);/);
  assert.doesNotMatch(activate, /reveal/i);
});

test('S2 What opens: the workspace, then each folder down to the project in order, awaiting each load, then its row scrolls into view', () => {
  const reveal = fn(workspacesJs, 'revealPlace');
  assert.match(reveal, /^async function revealPlace\(place\) \{/);
  assert.match(reveal, /const plan = revealPlan\(place, treeShown\(\)\);/);
  assert.match(reveal, /await rowToggles\.get\(rows\[0\]\)\?\.show\(true\);/);
  assert.match(reveal, /for \(const rel of plan\.openFolders\) \{[\s\S]*?await rowToggles\.get\(row\)\?\.show\(true\);[\s\S]*?\n  \}/);
  assert.match(reveal, /rows\.at\(-1\)\?\.scrollIntoView\(\{ block: 'nearest' \}\);/);
  // A later reveal wins over one still loading.
  assert.match(reveal, /if \(run !== revealRun\) return;/);
  // Folder loads now hand back their promise, so the next level is drawn before it is looked for.
  assert.match(nested(fn(workspacesJs, 'folderRow'), 'toggle'), /loading = renderFolders\(children, workspaceId, node\.rel, depth \+ 1\);[\s\S]*if \(willOpen\) await loading;/);
  assert.match(nested(fn(workspacesJs, 'workspaceGroup'), 'toggle'), /loading = renderFolders\(children, workspace\.id, '', 1, showCount\);[\s\S]*return willOpen \? loading : null;/);
  assert.match(fn(workspacesJs, 'workspaceGroup'), /if \(open\) \{\n    children\.dataset\.loaded = '1';\n    loading = renderFolders\(children, workspace\.id, '', 1, showCount\);/);
});

test('S2 What collapses: the other groups and the off-path folders close, before and after the path opens', () => {
  const collapse = fn(workspacesJs, 'collapseOffPath');
  assert.match(collapse, /const plan = revealPlan\(place, treeShown\(\)\);/);
  assert.match(collapse, /for \(const ws of plan\.closeGroups\) rowToggles\.get\(treeRow\(ws, ''\)\)\?\.show\(false\);/);
  assert.match(collapse, /for \(const folder of plan\.closeFolders\) rowToggles\.get\(treeRow\(folder\.ws, folder\.rel\)\)\?\.show\(false\);/);
  assert.equal(count(fn(workspacesJs, 'revealPlace'), 'collapseOffPath(place);'), 2);
  assert.match(workspacesJs, /^import \{ revealPlan \} from '\/features\/tree-reveal-model\.js';$/m);
});

test('S2 Saved state: the reveal never writes prefs nor the expanded folders', () => {
  for (const name of ['revealPlace', 'collapseOffPath', 'treeShown', 'treeRow']) {
    const body = fn(workspacesJs, name);
    assert.doesNotMatch(body, /prefs\.write|rememberExpanded|collapsed\.(add|delete)|api\(/, name);
  }
  // Both rows hand the reveal their toggle with remember false; a user's toggle still saves.
  assert.equal(count(workspacesJs, 'rowToggles.set(row, { open: () => !children.hidden, show: (next) => toggle(next, false) });'), 2);
  const group = nested(fn(workspacesJs, 'workspaceGroup'), 'toggle');
  assert.match(group, /^\n  function toggle\(next, remember = true\) \{/);
  assert.match(group, /if \(remember\) \{\n      if \(willOpen\) collapsed\.delete\(workspace\.id\);\n      else collapsed\.add\(workspace\.id\);\n      prefs\.write\('collapsedWorkspaces', \[\.\.\.collapsed\]\);\n    \}/);
  assert.match(nested(fn(workspacesJs, 'folderRow'), 'toggle'), /if \(remember\) rememberExpanded\(workspaceId, node\.rel, willOpen\);/);
});
