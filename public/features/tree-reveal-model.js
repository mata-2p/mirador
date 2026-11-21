// Pure rules behind revealing a terminal's place in the sidebar tree (public/features/workspaces.js
// revealPlace): a tab click, or a click on a grid tile that makes a different terminal active, opens
// that terminal's workspace and each folder down to its project, and collapses the other workspaces
// and every open folder off that path. The reveal only changes what is shown; workspaces.js never
// saves it. No DOM and no core.js: the browser and the tests import it.

/** The folder rels from the workspace root down to `rel`, outermost first: 'a/b' → ['a', 'a/b']; none for the root (''). */
export function folderPath(rel) {
  const parts = String(rel ?? '').split('/').filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}

/**
 * What to open and close to reveal `place` ({ workspaceId, rel }, terminals.js activePlace) in the
 * tree `shown`: its workspace groups ({ ws, open }) and the folder rows drawn so far ({ ws, rel, open }).
 * - `openGroup`: the place's workspace.
 * - `openFolders`: every folder from the root down to `rel`, outermost first. Deeper rows load as
 *   their parent opens, and a workspace that chose its folders may not draw every level, so the
 *   caller opens those it finds, in order.
 * - `closeGroups`: the other open workspace groups.
 * - `closeFolders`: the open folders off that path, in any workspace, in tree order.
 * A place the tree does not show (no place, or a removed workspace) changes nothing.
 */
export function revealPlan(place, shown) {
  const groups = shown?.groups ?? [];
  const folders = shown?.folders ?? [];
  if (!place || !groups.some((group) => group.ws === place.workspaceId)) return { openGroup: null, openFolders: [], closeGroups: [], closeFolders: [] };
  const path = folderPath(place.rel);
  const onPath = new Set(path);
  return {
    openGroup: place.workspaceId,
    openFolders: path,
    closeGroups: groups.filter((group) => group.open && group.ws !== place.workspaceId).map((group) => group.ws),
    closeFolders: folders
      .filter((folder) => folder.open && !(folder.ws === place.workspaceId && onPath.has(folder.rel)))
      .map((folder) => ({ ws: folder.ws, rel: folder.rel })),
  };
}
