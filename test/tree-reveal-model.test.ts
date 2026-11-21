// A tab click, or a click on a grid tile that changes the active terminal, reveals that terminal's
// place in the sidebar tree: its workspace and the folders down to its project open, the other
// workspaces and the folders off that path collapse (public/features/tree-reveal-model.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
// Loaded by URL, as test/leftoff-reading.test.ts loads markdown.js: the model is plain JS with no declaration file.
const { folderPath, revealPlan } = await import(new URL('../public/features/tree-reveal-model.js', import.meta.url).href);

const shown = {
  groups: [
    { ws: 'dev', open: false },
    { ws: 'web', open: true },
    { ws: 'ops', open: true },
  ],
  folders: [
    { ws: 'dev', rel: 'apps', open: false },
    { ws: 'web', rel: 'site', open: true },
    { ws: 'web', rel: 'site/src', open: false },
    { ws: 'ops', rel: 'infra', open: true },
  ],
};

test('S2 What opens: the terminal\'s workspace group opens, even when it was collapsed', () => {
  assert.equal(revealPlan({ workspaceId: 'dev', rel: 'apps/api' }, shown).openGroup, 'dev');
  assert.equal(revealPlan({ workspaceId: 'web', rel: 'site' }, shown).openGroup, 'web');
});

test('S2 What opens: each folder from the workspace root down to the project folder opens, outermost first', () => {
  assert.deepEqual(revealPlan({ workspaceId: 'dev', rel: 'apps/api/src' }, shown).openFolders, ['apps', 'apps/api', 'apps/api/src']);
  assert.deepEqual(folderPath('a/b/c'), ['a', 'a/b', 'a/b/c']);
  assert.deepEqual(folderPath('a'), ['a']);
  assert.deepEqual(folderPath('/a//b/'), ['a', 'a/b'], 'stray slashes are not folders');
});

test('S2 What collapses: every other open workspace group collapses, and the terminal\'s own never does', () => {
  assert.deepEqual(revealPlan({ workspaceId: 'dev', rel: 'apps' }, shown).closeGroups, ['web', 'ops']);
  assert.deepEqual(revealPlan({ workspaceId: 'web', rel: 'site' }, shown).closeGroups, ['ops']);
});

test('S2 What collapses: every open folder off the path collapses, in any workspace; those on it stay', () => {
  const plan = revealPlan({ workspaceId: 'web', rel: 'site' }, {
    groups: shown.groups,
    folders: [
      { ws: 'web', rel: 'site', open: true },
      { ws: 'web', rel: 'site/src', open: true },
      { ws: 'web', rel: 'docs', open: true },
      { ws: 'web', rel: 'sitemap', open: true },
      { ws: 'ops', rel: 'site', open: true },
      { ws: 'web', rel: 'blog', open: false },
    ],
  });
  assert.deepEqual(plan.closeFolders, [
    { ws: 'web', rel: 'site/src' },
    { ws: 'web', rel: 'docs' },
    { ws: 'web', rel: 'sitemap' },
    { ws: 'ops', rel: 'site' },
  ]);
});

test('S2 Workspace root: rel \'\' opens the workspace with all its folders collapsed', () => {
  const plan = revealPlan({ workspaceId: 'web', rel: '' }, shown);
  assert.equal(plan.openGroup, 'web');
  assert.deepEqual(plan.openFolders, []);
  assert.deepEqual(plan.closeGroups, ['ops']);
  assert.deepEqual(plan.closeFolders, [{ ws: 'web', rel: 'site' }, { ws: 'ops', rel: 'infra' }]);
  assert.deepEqual(folderPath(''), []);
});

test('S2 a place the tree does not show (a removed workspace, no place) leaves the tree as it is', () => {
  const none = { openGroup: null, openFolders: [], closeGroups: [], closeFolders: [] };
  assert.deepEqual(revealPlan({ workspaceId: 'gone', rel: 'x' }, shown), none);
  assert.deepEqual(revealPlan(null, shown), none);
});
