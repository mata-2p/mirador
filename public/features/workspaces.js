// Workspaces feature: the sidebar shows each workspace as a group with the folders
// the user chose (or all of them), each folder with its gentle-shell and bash buttons.
// Add, rename, choose folders and remove happen here; removing never touches the disk.
// Selection mode ("Marcar varias" on a workspace row) marks several folders to open gentle-shell
// in all of them, or to save them as the workspace's projects, opened later with one click
// ("Abrir N").
// Workspace row tools show an icon and short text; rename and remove live in its "Más" menu
// (workspace-tools.js).
// Row actions never cover the name: they sit beside it, on the row's one line, and those that do
// not fit move, in order, into the row's "Más" menu (fitRow, row-actions-model.js), on folder and
// workspace rows alike.
// Each row shows the state of its agents as a glyph (sidebar-status-model.js), from the terminals,
// the inbox and the sleeping agents. The funnel in the Workspaces head filters the tree and the
// terminals by those states (state-filter-model.js):
// its menu counts the agents per state, the picked states show as removable chips under the head,
// and the tree keeps the folders in a picked state and the folders that hold them.
// gentle-shell's button shows its rose; a tight row
// collapses it to the rose alone before any action moves into "Más".
// "Delegar a Sereno" (a folder row, or the marked folders) gives an instruction to gentle-shell
// there, as the first message of a new agent or as a message to the one already open, and can
// switch the autopilot on (delegate-model.js). Opened from the
// tree, it proposes an instruction from each folder's latest Next Steps,
// and "Mejorar con IA" asks Claude for a better one on demand (improveControls, also used by night.js).
// When more than one agent is offered (GET /api/agents), a ▾ right after a row's agent button drops
// down the other ones, each with its icon (agent-picker.js,
// icons/agents.js); with one, rows stay as they were.
import { $, api, el, emit, errorText, getLanguage, on, prefs, rowActionList, sameFolder, select, setWorkspaces, slot, state, t, workspaceById } from '/core.js';
import { openDialog, showAlert } from '/dialog.js';
import { plural } from '/i18n.js';
import { agentLabel, modeOf, showsExtra } from '/mode-model.js';
import { MAX_INSTRUCTION, checkInstruction, delegateBody, summarizeDelegation } from '/features/delegate-model.js';
import { FOLLOW_MS, batchProgress, busyFolders, marked, markFolder, queuedFolders, summarizeBatch, unmarkAll } from '/features/multi-open-model.js';
import { improveRequest, improver, proposalQuery, proposalText } from '/features/proposals-model.js';
import { icon } from '/icons.js';
import { agentIcon } from '/icons/agents.js';
import { NAME_MIN_PX, inlineActionCount, nameMinimum, showsMore } from '/features/row-actions-model.js';
import { ICONS, folderKey, sidebarStatus } from '/features/sidebar-status-model.js';
import { loadAgents, pickerAgents } from '/features/agent-picker.js';
import { menuItems, normalizeSelection, pick, toggleState, treeView } from '/features/state-filter-model.js';
import { revealPlan } from '/features/tree-reveal-model.js';
import { sleepingAgents } from '/features/sleeping.js';
import { activateTerminal, activePlace, activeTerminalId, newTerminalSize, openTerminal, setStateFilter, showOpenedTerminals, terminalList } from '/terminals.js';
import { openGitPanel } from '/git-panel.js';
import { registerPanelView } from '/features/summary.js';
import { plainLeftOffView } from '/features/plain-left-off.js';
import { changesView } from '/features/changes-panel.js';
import { closesMenu, menuFocusIndex, moreButton, moreTools, rowTools } from '/workspace-tools.js';

const collapsed = new Set(prefs.read('collapsedWorkspaces', []));
const expandTimers = new Map();
let fieldId = 0;
// Marked folders per workspace (multi-open-model.js), the workspaces in selection mode, and
// each workspace's refresh of its selection bar.
let picked = {};
const picking = new Set();
const pickBars = new Map();
// The agents' states per folder and per state (sidebar-status-model.js), and the inbox items they come from.
let status = sidebarStatus();
let inboxItems = [];
// The states picked in the filter (state-filter-model.js), kept in the window's prefs like the
// collapsed workspaces; each workspace's folder rows once its list loaded, for "N de M carpetas";
// and the funnel button and its menu.
let chosenStates = normalizeSelection(prefs.read('stateFilter', []));
const loadedFolders = new Map();
let filterButton = null;
let filterMenu = null;

const workspaceUrl = (id) => `/api/workspaces/${encodeURIComponent(id)}`;
/** 16px per level, after the 10px of a workspace row (the design's --depth). */
const indent = (depth) => `padding-left:${depth * 16 + 10}px`;
/** A tree caret's icon: down while its children show, right while they are hidden. */
const caretIcon = (open) => (open ? icon('chev-down') : icon('chev-right'));
/** Its name says what a press does: "Mostrar subcarpetas" while they are hidden, "Ocultar…" while they show. */
const caretLabel = (open) => t(open ? 'tree.collapse' : 'tree.expand');

/** gentle-shell's rose, in --rose. */
function roseIcon() {
  const rose = icon('rose');
  rose.classList.add('gs-rose');
  return rose;
}

/**
 * gentle-shell (the rose and its name, which stays its accessible name on a tight row), the ▾ of
 * the other offered agents when there are any (agentCombo), and bash.
 */
function terminalButtons(folder, path) {
  return [
    el('button', { class: 'btn gs-btn', title: t('tree.startAgent', { path }), 'data-launch-block': 'agent', onclick: (e) => { e.stopPropagation(); openTerminal(folder, 'agent'); } }, roseIcon(), el('span', { class: 'tool-label' }, agentLabel(state.config))),
    agentCombo(folder, path),
    el('button', { class: 'btn', title: t('tree.openShell', { path }), 'data-icon': 'terminal', onclick: (e) => { e.stopPropagation(); openTerminal(folder, 'shell'); } }, 'bash'),
  ];
}

/**
 * The ▾ right after the agent button: with the agent button, a split button whose menu
 * lists the other offered agents (agent-picker.js), each with its icon (icons/agents.js), and opens
 * the chosen one in `folder`. Blocked like the agent button while agents open. None while only one
 * agent is offered, so the row stays as before.
 */
function agentCombo(folder, path) {
  if (!pickerAgents().length) return null;
  const menu = el('div', { class: 'ws-more-menu agent-menu', id: `agent-menu-${++fieldId}`, role: 'menu', 'aria-label': t('tree.chooseAgent'), hidden: true });
  const button = el('button', { type: 'button', class: 'btn agent-pick', title: t('tree.chooseAgent'), 'aria-label': t('tree.chooseAgent'), 'data-launch-block': 'agent', onclick: (e) => { e.stopPropagation(); toggle(); } }, icon('chev-down'));
  const wrap = el('span', { class: 'agent-combo' }, button, menu);
  const toggle = popupMenu(wrap, button, menu, (close) => {
    // The next opening lists the agents offered then.
    loadAgents();
    return pickerAgents().map((agent) => el(
      'button',
      { type: 'button', class: 'ws-more-item', title: t('tree.startWithTitle', { agent: agent.label, path }), 'data-agent': agent.id, 'data-launch-block': 'agent', onclick: (e) => { e.stopPropagation(); close(true); openTerminal(folder, 'agent', agent.id); } },
      agentIcon(agent.id),
      el('span', { class: 'tool-label' }, agent.label),
    ));
  });
  return wrap;
}

/** Gives the ▾ to the rows drawn before the offered agents were known (agentCombo), then fits the shown rows again. */
function addAgentCombos() {
  if (pickerAgents().length) {
    for (const agent of slot('workspaces')?.querySelectorAll('.row-actions > .gs-btn') ?? []) {
      if (agent.nextElementSibling?.matches('.agent-combo')) continue;
      const row = agent.closest('.row');
      agent.after(agentCombo({ ws: row.dataset.ws, rel: row.dataset.rel }, row.querySelector(':scope > .name')?.title ?? ''));
      actionStops(row, row.matches(':focus-within'));
    }
  }
  fitShownRows();
}

/** A row action's text in the "Más" menu: the i18n key `<id>.menu` when it has one ("Servidores MCP"), else its row text. */
function menuText(action) {
  const key = `${action.id}.menu`;
  const text = t(key);
  return text === key ? action.text() : text;
}

/**
 * Buttons other features add to every row with registerRowAction (core.js), e.g. Files.
 * `compact` rows (workspace rows, already crowded) show the action's icon when it has one, and
 * leave out the actions marked `folderOnly` (e.g. MCP servers, chosen per folder). An action whose
 * `extra` (public/mode-model.js) does not show in this mode is left out everywhere.
 */
function featureButtons(folder, path, compact = false) {
  return rowActionList().filter((action) => !(compact && action.folderOnly) && showsExtra(state.config, action.extra)).map((action) => {
    const title = action.title(folder, path);
    const name = compact && action.icon;
    // `data-label` and `data-icon` are the text and icon the "Más" menu shows for a button that left the row.
    return el(
      'button',
      { class: name ? 'btn icon' : 'btn', title, 'aria-label': name ? title : null, 'data-label': menuText(action), 'data-icon': name ? null : action.icon ?? null, 'data-row-action': action.id, onclick: (e) => { e.stopPropagation(); action.run(folder); } },
      name ? icon(name) : action.text(),
    );
  });
}

/** Marks a folder Engram holds no memory for (hasMemory false; null means Engram is unreachable); never in plain mode. */
function noMemoryBadge(node) {
  return node.hasMemory === false && showsExtra(state.config, 'memory') ? el('span', { class: 'no-memory', title: t('tree.noMemoryHint') }, t('tree.noMemory')) : null;
}

/**
 * The git mark of a repository folder: the 12px icon, a button that opens lazygit there in the
 * floating panel (public/git-panel.js). It stops
 * its click and double click so the row neither selects nor starts an agent under it.
 */
function repoMark(folder, path, node) {
  const mark = icon('git');
  mark.classList.add('repo');
  return el('button', { class: 'repo-btn', title: t('tree.openGit', { path }), 'aria-label': t('tree.openGit', { path }), onclick: (e) => { e.stopPropagation(); openGitPanel(folder, node.name); }, ondblclick: (e) => e.stopPropagation() }, mark);
}

/** The glyph of the most urgent state among a folder's agents, named by its word; null while it has none. */
function stateGlyph(workspaceId, rel) {
  const current = status.folders.get(folderKey(workspaceId, rel));
  if (!current) return null;
  const glyph = icon(ICONS[current], { label: t(`states.label.${current}`) });
  glyph.classList.add('glyph', `s-${current}`);
  glyph.dataset.state = current;
  return glyph;
}

/**
 * The row's state glyph, left of its name: far from the actions at the row's end, so it is not
 * clicked by mistake. An empty slot takes no room (styles.css), so a row without a state keeps its
 * name where the tree's indent puts it.
 */
function glyphSlot(workspaceId, rel) {
  return el('span', { class: 'glyph-slot' }, stateGlyph(workspaceId, rel));
}

/** Puts the row's glyph in line with `status`, inside its slot; true when it changed. */
function placeGlyph(row) {
  const box = row.querySelector(':scope > .glyph-slot');
  if (!box) return false;
  const current = box.querySelector('svg.glyph');
  const next = stateGlyph(row.dataset.ws, row.dataset.rel);
  if ((current?.dataset.state ?? null) === (next?.dataset.state ?? null)) return false;
  box.replaceChildren(...(next ? [next] : []));
  return true;
}

/** Reads the states again (terminals, inbox, sleeping agents), redraws the glyphs that changed and filters again. */
function refreshStatus() {
  status = sidebarStatus({ terminals: terminalList(), items: inboxItems, sleeping: sleepingAgents() });
  let changed = false;
  slot('workspaces')?.querySelectorAll('.row').forEach((row) => { if (placeGlyph(row)) changed = true; });
  if (applyFilter()) changed = true;
  // A glyph, or a longer folder count, takes room on its row.
  if (changed) fitShownRows();
  markActive();
}

/**
 * Marks the folder of the terminal you are looking at (the active tab or grid pane), so you can
 * find it to open its files or anything else. It never selects the row: the main view stays.
 */
function markActive() {
  const place = activePlace();
  const active = place && { ws: place.workspaceId, rel: place.rel };
  slot('workspaces')?.querySelectorAll('.row').forEach((row) => {
    row.classList.toggle('has-active', sameFolder(active, { ws: row.dataset.ws, rel: row.dataset.rel }));
  });
}

/* ---------- Revealing the active terminal's place ---------- */

// Each tree row's caret, for the reveal: `open()` says whether its children show, and `show(next)`
// opens or closes them without saving it, resolving once its subfolders loaded. A redraw drops the
// old rows, and their entries with them.
const rowToggles = new WeakMap();
let revealRun = 0;

/** The tree as revealPlan reads it: each workspace group and each folder row drawn, with whether it is open. */
function treeShown() {
  const groups = [];
  const folders = [];
  for (const row of slot('workspaces')?.querySelectorAll('.row') ?? []) {
    const toggles = rowToggles.get(row);
    if (!toggles) continue;
    if (row.classList.contains('ws-row')) groups.push({ ws: row.dataset.ws, open: toggles.open() });
    else folders.push({ ws: row.dataset.ws, rel: row.dataset.rel, open: toggles.open() });
  }
  return { groups, folders };
}

/** The row of folder `rel` of workspace `ws` ('' for the workspace row), when the tree draws it. */
function treeRow(ws, rel) {
  return [...(slot('workspaces')?.querySelectorAll('.row') ?? [])].find((row) => row.dataset.ws === ws && row.dataset.rel === rel) ?? null;
}

/** Closes the other workspace groups and the open folders off `place`'s path (revealPlan), without saving it. */
function collapseOffPath(place) {
  const plan = revealPlan(place, treeShown());
  for (const ws of plan.closeGroups) rowToggles.get(treeRow(ws, ''))?.show(false);
  for (const folder of plan.closeFolders) rowToggles.get(treeRow(folder.ws, folder.rel))?.show(false);
}

/**
 * Reveals `place` ({ workspaceId, rel }), which terminals.js sends on a tab click or a press on a
 * grid tile that changed the active terminal: opens its workspace, then each folder down to its
 * project in order, waiting for each level to load, closes everything else and scrolls the deepest
 * row it reached into view. Only what is shown changes: the saved collapsed workspaces and expanded
 * folders stay, so a reload brings back the user's own layout.
 */
async function revealPlace(place) {
  const run = ++revealRun;
  const plan = revealPlan(place, treeShown());
  if (!plan.openGroup) return;
  collapseOffPath(place);
  const rows = [treeRow(plan.openGroup, '')];
  await rowToggles.get(rows[0])?.show(true);
  for (const rel of plan.openFolders) {
    if (run !== revealRun) return;
    const row = treeRow(plan.openGroup, rel);
    if (!row) continue;
    rows.push(row);
    await rowToggles.get(row)?.show(true);
  }
  if (run !== revealRun) return;
  // Folders the saved layout opened as their parents loaded are off the path too.
  collapseOffPath(place);
  markActive();
  rows.at(-1)?.scrollIntoView({ block: 'nearest' });
}

/* ---------- State filter ---------- */

/** A state's name in the filter, and "Ver todos" for 'all'. */
const stateName = (key) => t(`filter.state.${key}`);

/** Picks `next` states: remembers them, then filters the tree and the terminals again. */
function chooseStates(next) {
  chosenStates = next;
  prefs.write('stateFilter', chosenStates);
  if (applyFilter()) fitShownRows();
}

/** "Ver todos" outside the menu (the chips line, the terminals' empty notice): clears, back on the funnel. */
function showAll() {
  chooseStates([]);
  filterButton?.focus();
}

/**
 * Applies the picked states to the tree and the terminals and redraws the funnel, its open menu
 * and the chips with the current counts. True when a workspace's folder count changed.
 */
function applyFilter() {
  const changed = filterTree();
  setStateFilter(chosenStates, showAll);
  renderFilterControls();
  return changed;
}

/**
 * "7 carpetas", or "1 de 7 carpetas" while the filter is on, over the workspace's folder rows; the
 * chosen folders until its list loads, nothing while it has none. True when the text changed.
 */
function writeCount(group, view) {
  const workspaceId = group.dataset.ws;
  const count = group.querySelector(':scope > .ws-row > .count');
  const rels = loadedFolders.get(workspaceId) ?? workspaceById(workspaceId)?.folders ?? [];
  const before = count.hidden ? null : count.textContent;
  if (!loadedFolders.has(workspaceId) && !rels.length) {
    count.hidden = true;
    return before !== null;
  }
  const { shown, total } = view.count(workspaceId, rels);
  count.textContent = view.active ? t(`ws.folderCountOf.${total === 1 ? 'one' : 'other'}`, { shown, count: total }) : plural(getLanguage(), 'ws.folderCount', total);
  count.hidden = false;
  return before !== count.textContent;
}

/**
 * Hides the workspaces and folders the filter leaves out (a folder row and its subfolders), writes
 * the folder counts, and says "Ningún workspace en este estado." when nothing stays. The active
 * terminal's folder and workspace stay whatever its state (terminals.js activePlace). True when a
 * count changed.
 */
function filterTree() {
  const tree = slot('workspaces');
  if (!tree) return false;
  const place = activePlace();
  const view = treeView(status.agents, chosenStates, place ? [place] : []);
  let changed = false;
  tree.querySelectorAll(':scope > .ws').forEach((group) => {
    group.classList.toggle('filtered-out', !view.keeps(group.dataset.ws, ''));
    if (writeCount(group, view)) changed = true;
  });
  tree.querySelectorAll('.row:not(.ws-row)').forEach((row) => row.classList.toggle('filtered-out', !view.keeps(row.dataset.ws, row.dataset.rel)));
  const none = state.workspaces.length > 0 && view.empty(state.workspaces.map((workspace) => workspace.id));
  const notice = tree.querySelector(':scope > .tree-empty');
  if (none && !notice) tree.append(el('p', { class: 'notice tree-empty' }, t('filter.noWorkspaces')));
  if (!none) notice?.remove();
  rovingStop();
  return changed;
}

/** The menu's items: "Ver todos", then each state with its glyph, name, count and check mark. */
function filterItems() {
  return menuItems(status.counts, chosenStates).map((item) => {
    const glyph = icon(item.icon);
    if (item.state !== 'all') glyph.classList.add('st-ic');
    const check = icon('check');
    check.classList.add('mi-check');
    return el(
      'button',
      { type: 'button', class: item.state === 'all' ? 'ws-more-item' : `ws-more-item s-${item.state}`, role: 'menuitemcheckbox', 'aria-checked': String(item.checked), 'data-filter': item.state, tabindex: -1, onclick: (e) => { e.stopPropagation(); pickFilter(item.state); } },
      glyph,
      el('span', { class: 'mi-label' }, stateName(item.state)),
      el('span', { class: 'n' }, String(item.count)),
      check,
    );
  });
}

/** Redraws the open menu's items, keeping the focus on the same item. */
function fillFilterMenu() {
  const focused = filterMenu.contains(document.activeElement) ? document.activeElement.dataset.filter : null;
  filterMenu.replaceChildren(...filterItems());
  if (focused) filterMenu.querySelector(`[data-filter="${focused}"]`)?.focus();
}

/** A state toggles and the menu stays open to pick another; "Ver todos" clears and closes it. */
function pickFilter(choice) {
  const { selected, close } = pick(chosenStates, choice);
  chooseStates(selected);
  if (close) closeFilter(true);
}

function openFilter() {
  fillFilterMenu();
  filterMenu.hidden = false;
  filterButton.setAttribute('aria-expanded', 'true');
  document.addEventListener('pointerdown', outsideFilter, true);
  filterMenu.firstElementChild?.focus();
}

function closeFilter(refocus) {
  if (filterMenu.hidden) return;
  filterMenu.hidden = true;
  filterButton.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', outsideFilter, true);
  if (refocus) filterButton.focus();
}

/** A press outside the funnel and its menu closes the menu, and the focus goes back to the funnel. */
function outsideFilter(e) {
  if (closesMenu({ type: 'pointerdown', inside: slot('state-filter').contains(e.target) })) closeFilter(true);
}

/**
 * The funnel and its menu in the Workspaces head, as the "Más" menu works: arrow keys, Home and End
 * move between the items; Escape, Tab or a press outside close it.
 */
function buildFilter() {
  const host = slot('state-filter');
  if (!host) return;
  filterMenu = el('div', { class: 'ws-more-menu state-menu', id: 'state-menu', role: 'menu', hidden: true });
  filterButton = el('button', { type: 'button', class: 'btn ghost filter-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'state-menu', onclick: () => (filterMenu.hidden ? openFilter() : closeFilter(true)) }, icon('filter'));
  host.replaceChildren(filterButton, filterMenu);
  host.addEventListener('keydown', (e) => {
    if (filterMenu.hidden) return;
    const items = [...filterMenu.children];
    const next = menuFocusIndex(e.key, items.indexOf(document.activeElement), items.length);
    if (next !== null) {
      e.preventDefault();
      items[next].focus();
    } else if (closesMenu({ type: 'keydown', key: e.key })) {
      if (e.key === 'Escape') e.preventDefault();
      closeFilter(true);
    }
  });
}

/** Removes one picked state from its chip; the focus moves to the next chip, else to the funnel. */
function unpick(key) {
  chooseStates(toggleState(chosenStates, key));
  (slot('active-filter').querySelector('[data-unpick]') ?? filterButton)?.focus();
}

/** The funnel's name and look, the open menu, and the chips line: "Filtrando:", one chip per picked state, "Ver todos". */
function renderFilterControls() {
  const active = chosenStates.length > 0;
  if (filterButton) {
    filterButton.classList.toggle('on', active);
    filterButton.title = t('filter.button');
    filterButton.setAttribute('aria-label', active ? t('filter.buttonActive', { list: chosenStates.map(stateName).join(', ') }) : t('filter.button'));
    filterMenu.setAttribute('aria-label', t('filter.menu'));
    if (!filterMenu.hidden) fillFilterMenu();
  }
  const line = slot('active-filter');
  if (!line) return;
  const focused = line.contains(document.activeElement) ? document.activeElement.dataset.unpick ?? null : null;
  line.hidden = !active;
  if (!active) return line.replaceChildren();
  const chip = (key) => {
    const glyph = icon(ICONS[key]);
    const remove = icon('close');
    remove.classList.add('x');
    return el('button', { type: 'button', class: `af-chip s-${key}`, 'data-unpick': key, 'aria-label': t('filter.remove', { state: stateName(key) }), title: t('filter.remove', { state: stateName(key) }), onclick: () => unpick(key) }, glyph, stateName(key), el('span', { class: 'n' }, String(status.counts[key])), remove);
  };
  line.replaceChildren(
    el('span', {}, t('filter.active')),
    ...chosenStates.map(chip),
    el('button', { type: 'button', class: 'af-reset', onclick: showAll }, stateName('all')),
  );
  if (focused) line.querySelector(`[data-unpick="${focused}"]`)?.focus();
}

/**
 * A workspace tool (workspace-tools.js): icon and short text, which is its accessible name;
 * the long text, naming the workspace, is the tooltip. `onclick` gets the button.
 */
function toolButton(tool, onclick, className = 'btn ws-tool') {
  return el(
    'button',
    { type: 'button', class: className, title: t(tool.title.key, tool.title.vars), 'data-tool': tool.id, onclick: (e) => { e.stopPropagation(); onclick(e.currentTarget); } },
    tool.icon ? icon(tool.icon) : null,
    el('span', { class: 'tool-label' }, t(tool.label.key, tool.label.vars)),
  );
}

/**
 * The "Más" button at the end of a row (folder or workspace, `subject` names it) and its menu:
 * the row's actions that did not fit (fitRow), in order, then `extra` items of its own, e.g. a
 * workspace's rename and remove ({ tool, run, refocus }).
 */
function moreMenu(subject, extra = []) {
  const more = moreButton(subject);
  const menu = el('div', { class: 'ws-more-menu', id: `ws-more-${++fieldId}`, role: 'menu', 'aria-label': t(more.title.key, more.title.vars), hidden: true });
  const button = toolButton(more, () => toggle());
  const wrap = el('span', { class: 'ws-more', 'data-always': extra.length ? 'true' : null }, button, menu);
  // Built on opening, so they follow what fitRow last moved off the row; the agents' ▾ goes with its button.
  // Rename moves the focus to its field; the rest give it back to the button (a dialog returns it there).
  const toggle = popupMenu(wrap, button, menu, (close) => [
    ...[...wrap.parentElement.children]
      .filter((node) => node !== wrap && node.hidden && !node.matches('.agent-combo'))
      .map((source) => overflowItem(source, () => { close(true); source.click(); })),
    ...extra.map(({ tool, run, refocus }) => toolButton(tool, () => { close(refocus); run(); }, 'ws-more-item')),
  ]);
  return wrap;
}

/**
 * A row's menu, shared by "Más" and the agents' ▾: `button` opens `menu` (role menu, both
 * inside `wrap`) with the items `build(close)` returns, built on each opening; with none it stays
 * shut. Arrow keys, Home and End move between the items; Escape, Tab or a press outside close it,
 * and Escape gives the focus back to `button`. Returns what a press on `button` does.
 */
function popupMenu(wrap, button, menu, build) {
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', menu.id);
  const outside = (e) => { if (closesMenu({ type: 'pointerdown', inside: wrap.contains(e.target) })) close(false); };
  let items = [];
  // A double click on the button opens and closes the menu; it must not open a terminal (the row's dblclick).
  wrap.addEventListener('dblclick', (e) => e.stopPropagation());

  function open() {
    items = build(close);
    if (!items.length) return;
    items.forEach((item) => { if (!item.hasAttribute('role')) item.setAttribute('role', 'menuitem'); item.tabIndex = -1; });
    menu.replaceChildren(...items);
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    items[0].focus();
    // Near the foot of the tree the whole menu scrolls into view, not only its first item.
    menu.scrollIntoView({ block: 'nearest' });
  }
  function close(refocus) {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    if (refocus) button.focus();
  }

  wrap.addEventListener('keydown', (e) => {
    if (menu.hidden) return;
    const next = menuFocusIndex(e.key, items.indexOf(document.activeElement), items.length);
    if (next !== null) {
      e.preventDefault();
      items[next].focus();
    } else if (closesMenu({ type: 'keydown', key: e.key })) {
      // Back on the button, so Tab goes on from there.
      if (e.key === 'Escape') e.preventDefault();
      close(true);
    }
  });
  return () => (menu.hidden ? open() : close(true));
}

/**
 * The "Más" menu item of a row action that did not fit: the same icon and short text, and
 * `onpick` clicks the hidden button, so it runs exactly what the button runs (and stays blocked
 * or pressed exactly when the button is).
 */
function overflowItem(source, onpick) {
  const sourceIcon = source.querySelector('svg.icon');
  const label = source.querySelector('.tool-label')?.textContent ?? source.dataset.label ?? source.textContent;
  const pressed = source.getAttribute('aria-pressed');
  const disabled = source.disabled || source.getAttribute('aria-disabled') === 'true';
  return el(
    'button',
    {
      type: 'button',
      class: 'ws-more-item',
      title: source.title || null,
      role: pressed === null ? null : 'menuitemcheckbox',
      'aria-checked': pressed,
      'aria-disabled': disabled ? 'true' : null,
      onclick: (e) => { e.stopPropagation(); onpick(); },
    },
    sourceIcon ? sourceIcon.cloneNode(true) : source.dataset.icon ? icon(source.dataset.icon) : null,
    el('span', { class: 'tool-label' }, label),
  );
}

/**
 * Shows on a row the actions that fit beside its name and hides the rest, which its "⋯" menu
 * lists (row-actions-model.js). The name keeps its minimum width (its CSS min-width, 7ch), on
 * every row, the selected one included. Measures with every action shown, in one go; short of
 * room, it first collapses gentle-shell to its rose (`.tight`) and measures again.
 */
function fitRow(row) {
  // A row inside a closed group has no width yet; it is fitted when the group opens.
  const actions = row.getClientRects().length && row.querySelector(':scope > .row-actions');
  const more = actions && actions.querySelector(':scope > .ws-more');
  if (!more) return;
  const combo = actions.querySelector(':scope > .agent-combo');
  const buttons = [...actions.children].filter((node) => node !== more && node !== combo);
  const focused = actions.contains(document.activeElement) ? document.activeElement : null;
  row.classList.add('fitting');
  row.classList.remove('tight');
  for (const node of [...buttons, more]) node.hidden = false;
  if (combo) combo.hidden = false;
  const width = (node) => Math.ceil(node.getBoundingClientRect().width);
  // The agents' ▾ goes with the agent button before it: its width counts in that button's, and it leaves the row with it.
  const widthOf = (node) => width(node) + (combo && node === combo.previousElementSibling ? gap + width(combo) : 0);
  const px = (value) => parseFloat(value) || 0;
  const rowStyle = getComputedStyle(row);
  const gap = px(getComputedStyle(actions).columnGap);
  const content = row.clientWidth - px(rowStyle.paddingLeft) - px(rowStyle.paddingRight);
  const name = row.querySelector(':scope > .name, :scope > input.rename');
  const others = [...row.children].filter((node) => node !== name && node !== actions && node.getClientRects().length);
  // The model puts the actions' own gap before the first one; the row's wider gap separates them from the name.
  const available = content - others.reduce((sum, node) => sum + width(node) + px(rowStyle.columnGap), 0) - (px(rowStyle.columnGap) - gap);
  const isName = name?.matches('.name');
  const nameMin = nameMinimum(isName ? name.scrollWidth : Number.NaN, (isName && px(getComputedStyle(name).minWidth)) || NAME_MIN_PX);
  const alwaysMore = more.dataset.always === 'true';
  const fits = () => inlineActionCount({ available, nameMin, moreWidth: width(more), widths: buttons.map(widthOf), gap, alwaysMore });
  let count = fits();
  if (count < buttons.length && actions.querySelector(':scope > .gs-btn')) {
    row.classList.add('tight');
    count = fits();
  }
  buttons.forEach((node, index) => { node.hidden = index >= count; });
  if (combo) combo.hidden = combo.previousElementSibling.hidden;
  more.hidden = !showsMore(count, buttons.length, alwaysMore);
  row.classList.remove('fitting');
  if (focused?.closest('[hidden]')) more.querySelector('button')?.focus();
}

/** Fits again the rows showing their actions: selected, hovered or holding the focus. */
function fitShownRows() {
  slot('workspaces')?.querySelectorAll('.row.selected, .row:hover, .row:focus-within').forEach(fitRow);
}

/** Fits a row's actions whenever they appear: on hover, and when the focus enters it from outside. */
function fitOnShow(row) {
  row.addEventListener('pointerenter', () => fitRow(row));
  row.addEventListener('focusin', (e) => { if (!row.contains(e.relatedTarget)) fitRow(row); });
}

/* ---------- Keyboard (APG tree) ---------- */

// A row's own controls, which leave the Tab order until the focus is on that row (its caret never
// takes it, and its "Más" menu items move with the arrow keys).
const ROW_ACTIONS = ':scope > .pick, :scope > .repo-btn, :scope > .row-actions button:not(.ws-more-item)';

/** The rows the tree shows, in order: none inside a folded group or left out by the filter. */
function visibleRows() {
  return [...(slot('workspaces')?.querySelectorAll('.row') ?? [])].filter((row) => !row.closest('[hidden], .filtered-out'));
}

/**
 * The tree's one Tab stop: `row` (the focused one) takes it; else the shown row that has it keeps
 * it, else the selected row or the first one gets it.
 */
function rovingStop(row = null) {
  const rows = visibleRows();
  const target = row ?? rows.find((r) => r.tabIndex === 0) ?? rows.find((r) => r.classList.contains('selected')) ?? rows[0];
  for (const r of slot('workspaces')?.querySelectorAll('.row') ?? []) r.tabIndex = r === target ? 0 : -1;
}

/** Puts a row's actions in the Tab order (`on`, while the focus is on the row) or takes them out. */
function actionStops(row, on) {
  for (const node of row.querySelectorAll(ROW_ACTIONS)) node.tabIndex = on ? 0 : -1;
}

/** ↑/↓ move the focus to the previous or next row the tree shows, Home/End to the first or last; no wrap. */
function treeKeys(e) {
  if (!e.target.matches?.('.row') || e.altKey || e.ctrlKey || e.metaKey) return;
  const rows = visibleRows();
  const here = rows.indexOf(e.target);
  const index = { ArrowUp: here - 1, ArrowDown: here + 1, Home: 0, End: rows.length - 1 }[e.key];
  if (index === undefined || here < 0) return;
  e.preventDefault();
  if (rows[index]) rows[index].focus();
}

function replaceWorkspace(updated) {
  setWorkspaces(state.workspaces.map((w) => (w.id === updated.id ? updated : w)));
}

/** Remembers which folders show their subfolders; saved to the workspace after a short pause. */
function rememberExpanded(workspaceId, rel, open) {
  const workspace = workspaceById(workspaceId);
  if (!workspace) return;
  const expanded = new Set(workspace.expanded);
  if (open) expanded.add(rel);
  else expanded.delete(rel);
  workspace.expanded = [...expanded];
  clearTimeout(expandTimers.get(workspaceId));
  expandTimers.set(
    workspaceId,
    setTimeout(() => {
      api('PATCH', workspaceUrl(workspaceId), { expanded: workspace.expanded }).catch((error) => console.warn('could not save open folders:', error));
    }, 400),
  );
}

/* ---------- Folder rows ---------- */

function folderRow(workspaceId, node, depth) {
  const folder = { ws: workspaceId, rel: node.rel };
  const children = el('div', { role: 'group', hidden: true });
  const caret = el('button', { class: 'caret', 'aria-label': caretLabel(false), tabindex: -1, disabled: !node.hasChildren }, caretIcon(false));
  const row = el(
    'div',
    { class: 'row', role: 'treeitem', tabindex: -1, 'data-ws': workspaceId, 'data-rel': node.rel, style: indent(depth) },
    caret,
    pickBox(workspaceId, node.rel),
    glyphSlot(workspaceId, node.rel),
    el('span', { class: 'name', translate: 'no', title: node.path }, node.name),
    node.isRepo ? repoMark(folder, node.path, node) : null,
    noMemoryBadge(node),
    el(
      'span',
      { class: 'row-actions' },
      terminalButtons(folder, node.path),
      el('button', { class: 'btn', title: t('delegate.rowTitle', { path: node.path }), 'data-delegate': 'row', 'data-launch-block': 'delegate', 'data-icon': 'delegate', 'data-label': t('delegate.menu'), onclick: (e) => { e.stopPropagation(); delegate(workspaceId, [node.rel]); } }, t('delegate.row')),
      featureButtons(folder, node.path),
      moreMenu({ name: node.name }),
    ),
  );
  actionStops(row, false);
  fitOnShow(row);
  // The subfolders' first load, which an opening waits for: the reveal looks for the next level in it.
  let loading = null;

  async function toggle(open, remember = true) {
    if (!node.hasChildren) return;
    const willOpen = open ?? children.hidden;
    children.hidden = !willOpen;
    caret.replaceChildren(caretIcon(willOpen));
    caret.setAttribute('aria-label', caretLabel(willOpen));
    row.setAttribute('aria-expanded', String(willOpen));
    rovingStop();
    if (willOpen) fitShownRows();
    if (remember) rememberExpanded(workspaceId, node.rel, willOpen);
    if (willOpen && !children.dataset.loaded) {
      children.dataset.loaded = '1';
      loading = renderFolders(children, workspaceId, node.rel, depth + 1);
    }
    if (willOpen) await loading;
  }

  rowToggles.set(row, { open: () => !children.hidden, show: (next) => toggle(next, false) });

  caret.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  row.addEventListener('click', () => select(folder));
  row.addEventListener('dblclick', () => openTerminal(folder, 'agent'));
  row.addEventListener('keydown', (e) => {
    if (e.target !== row) return;
    if (e.key === 'Enter') openTerminal(folder, 'agent');
    if (e.key === 'ArrowRight') toggle(true);
    if (e.key === 'ArrowLeft') toggle(false);
    if (e.key === ' ') { e.preventDefault(); select(folder); }
  });
  if (node.hasChildren) row.setAttribute('aria-expanded', 'false');
  if (workspaceById(workspaceId)?.expanded.includes(node.rel)) queueMicrotask(() => toggle(true, false));
  return [row, children];
}

/** Loads and shows the subfolders of `rel`, as the filter leaves them; `onCount` gets them once they load. */
async function renderFolders(container, workspaceId, rel, depth, onCount = null) {
  // In line with the names: the indent, the 12px caret and the 6px gap.
  const notice = (text, extra = '') => el('div', { class: `notice ${extra}`.trim(), style: `padding-left:${depth * 16 + 28}px` }, text);
  container.replaceChildren(notice(t('common.loading')));
  try {
    const nodes = await api('GET', `/api/tree?ws=${encodeURIComponent(workspaceId)}&rel=${encodeURIComponent(rel)}`);
    container.replaceChildren(...nodes.flatMap((node) => folderRow(workspaceId, node, depth)));
    if (!nodes.length) container.replaceChildren(notice(t('tree.empty')));
    onCount?.(nodes);
  } catch (error) {
    container.replaceChildren(notice(errorText(error), 'error'));
  }
  // The new rows follow the filter; the workspace's count may now read "N de M carpetas".
  if (filterTree()) fitShownRows();
  markSelected();
}

/* ---------- Workspace groups ---------- */

function workspaceGroup(workspace) {
  const folder = { ws: workspace.id, rel: '' };
  const open = !collapsed.has(workspace.id);
  const children = el('div', { role: 'group', hidden: !open });
  const caret = el('button', { class: 'caret', 'aria-label': caretLabel(open), tabindex: -1 }, caretIcon(open));
  const name = el('span', { class: 'name', translate: 'no', title: workspace.root }, workspace.name);
  const run = {
    open: (button) => openBatch(workspace.id, null, button),
    pick: () => setPicking(workspace.id, !picking.has(workspace.id)),
    folders: () => chooseFolders(workspace.id),
  };
  const tools = rowTools(workspace).map((tool) => toolButton(tool, run[tool.id]));
  for (const tool of tools) {
    if (tool.dataset.tool === 'open') {
      tool.dataset.pick = 'saved';
      tool.dataset.launchBlock = 'batch';
    }
    if (tool.dataset.tool === 'pick') {
      tool.dataset.pick = 'toggle';
      tool.setAttribute('aria-pressed', String(picking.has(workspace.id)));
    }
  }
  // "7 carpetas": the chosen folders until the list loads, then the folders it shows (writeCount).
  const count = el('span', { class: 'count', title: workspace.folders.length ? t('ws.chosenCount', { count: workspace.folders.length }) : null, hidden: true });
  const showCount = (nodes) => loadedFolders.set(workspace.id, nodes.map((node) => node.rel));
  const row = el(
    'div',
    { class: 'row ws-row', role: 'treeitem', tabindex: -1, 'aria-expanded': String(open), 'data-ws': workspace.id, 'data-rel': '', style: indent(0) },
    caret,
    glyphSlot(workspace.id, ''),
    name,
    count,
    el(
      'span',
      { class: 'row-actions' },
      terminalButtons(folder, workspace.root),
      featureButtons(folder, workspace.root, true),
      tools,
    ),
  );
  const runMore = { rename: () => startRename(workspace.id, row, name), remove: () => removeWorkspace(workspace.id) };
  const extra = moreTools(workspace).map((tool) => ({ tool, run: runMore[tool.id], refocus: tool.id !== 'rename' }));
  row.querySelector('.row-actions').append(moreMenu(workspace, extra));
  actionStops(row, false);
  fitOnShow(row);
  // The first-level folders' first load, which an opening hands back for the reveal to wait for.
  let loading = null;

  function toggle(next, remember = true) {
    const willOpen = next ?? children.hidden;
    children.hidden = !willOpen;
    caret.replaceChildren(caretIcon(willOpen));
    caret.setAttribute('aria-label', caretLabel(willOpen));
    row.setAttribute('aria-expanded', String(willOpen));
    rovingStop();
    if (willOpen) fitShownRows();
    if (remember) {
      if (willOpen) collapsed.delete(workspace.id);
      else collapsed.add(workspace.id);
      prefs.write('collapsedWorkspaces', [...collapsed]);
    }
    if (willOpen && !children.dataset.loaded) {
      children.dataset.loaded = '1';
      loading = renderFolders(children, workspace.id, '', 1, showCount);
    }
    return willOpen ? loading : null;
  }

  rowToggles.set(row, { open: () => !children.hidden, show: (next) => toggle(next, false) });

  caret.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  row.addEventListener('click', () => select(folder));
  row.addEventListener('keydown', (e) => {
    if (e.target !== row) return;
    if (e.key === 'Enter') openTerminal(folder, 'agent');
    if (e.key === 'F2') startRename(workspace.id, row, name);
    if (e.key === 'ArrowRight') toggle(true);
    if (e.key === 'ArrowLeft') toggle(false);
    if (e.key === ' ') { e.preventDefault(); select(folder); }
  });
  if (open) {
    children.dataset.loaded = '1';
    loading = renderFolders(children, workspace.id, '', 1, showCount);
  }
  return el('div', { class: picking.has(workspace.id) ? 'ws picking' : 'ws', 'data-ws': workspace.id }, row, pickBar(workspace), children);
}

/* ---------- Several folders at once ---------- */

/** The checkbox of a folder row; shown only while its workspace is in selection mode (CSS). */
function pickBox(workspaceId, rel) {
  const box = el('input', { type: 'checkbox', class: 'pick', 'aria-label': t('multi.mark', { path: rel }), checked: marked(picked, workspaceId).includes(rel) });
  box.addEventListener('click', (e) => e.stopPropagation());
  box.addEventListener('dblclick', (e) => e.stopPropagation());
  box.addEventListener('change', () => {
    picked = markFolder(picked, workspaceId, rel, box.checked);
    pickBars.get(workspaceId)?.();
  });
  return box;
}

function setPicking(workspaceId, on) {
  if (on) picking.add(workspaceId);
  else picking.delete(workspaceId);
  const group = [...document.querySelectorAll('.ws')].find((node) => node.dataset.ws === workspaceId);
  if (!group) return;
  group.classList.toggle('picking', on);
  group.querySelector('.ws-row [data-pick="toggle"]')?.setAttribute('aria-pressed', String(on));
  group.querySelector('.pick-bar').hidden = !on;
  // The folder checkboxes take room on their rows.
  fitShownRows();
}

/** Re-checks the boxes of a workspace from `picked` (after clearing or loading the saved set). */
function syncBoxes(workspaceId) {
  const rels = marked(picked, workspaceId);
  document.querySelectorAll('.row').forEach((row) => {
    const box = row.dataset.ws === workspaceId && row.querySelector('input.pick');
    if (box) box.checked = rels.includes(row.dataset.rel);
  });
  pickBars.get(workspaceId)?.();
}

/** The bar under a workspace row in selection mode: live count, open, save as projects, load, clear. */
function pickBar(workspace) {
  const id = workspace.id;
  const projects = workspace.projects ?? [];
  const hint = el('p', { class: 'pick-hint', role: 'status' });
  const saved = el('p', { class: 'hint pick-saved' });
  const note = el('p', { class: 'hint pick-note', role: 'status' });
  const button = (action, kind, onclick) => el('button', { type: 'button', class: `btn ${kind}`.trim(), 'data-pick': action, onclick });
  const openButton = button('open', 'primary', () => openBatch(id, marked(picked, id), openButton));
  const saveButton = button('save', '', () => saveProjects(id, marked(picked, id), note));
  const delegateButton = button('delegate', '', () => delegate(id, marked(picked, id), { fromSelection: true }));
  // Disabled while agents open (public/features/launch-progress.js): each starts one more pi.
  openButton.dataset.launchBlock = 'batch';
  delegateButton.dataset.launchBlock = 'delegate';
  const loadButton = button('load', '', () => {
    for (const rel of projects) picked = markFolder(picked, id, rel, true);
    syncBoxes(id);
  });
  const clearButton = button('clear', '', () => {
    picked = unmarkAll(picked, id);
    syncBoxes(id);
  });
  const refresh = () => {
    const count = marked(picked, id).length;
    hint.textContent = count ? t('multi.count', { count }) : t('multi.none');
    if (!openButton.getAttribute('aria-busy')) openButton.textContent = t('multi.open', { count });
    openButton.disabled = !count || openButton.hasAttribute('aria-busy');
    delegateButton.textContent = t('delegate.marked', { count });
    delegateButton.disabled = !count;
    saveButton.textContent = count || !projects.length ? t('multi.save') : t('multi.forget');
    saveButton.disabled = !count && !projects.length;
    loadButton.textContent = t('multi.loadSaved', { count: projects.length });
    loadButton.hidden = !projects.length;
    clearButton.textContent = t('multi.clear');
    clearButton.disabled = !count;
    saved.textContent = projects.length ? t('multi.saved', { list: projects.join(', ') }) : t('multi.noSaved');
  };
  pickBars.set(id, refresh);
  refresh();
  return el(
    'div',
    { class: 'pick-bar', role: 'group', 'aria-label': t('multi.barLabel', { name: workspace.name }), hidden: !picking.has(id), 'data-ws': id },
    hint,
    el('div', { class: 'pick-actions' }, openButton, delegateButton, saveButton, loadButton, clearButton),
    saved,
    note,
  );
}

/** Saves the marked folders as the workspace's projects (an empty list forgets them). */
async function saveProjects(workspaceId, rels, note) {
  note.textContent = t('ws.saving');
  try {
    const updated = await api('PATCH', workspaceUrl(workspaceId), { projects: rels });
    replaceWorkspace(updated);
    const bar = [...document.querySelectorAll('.pick-bar')].find((node) => node.dataset.ws === workspaceId);
    bar?.querySelector('[data-pick="save"]')?.focus();
    const fresh = bar?.querySelector('.pick-note');
    if (fresh) fresh.textContent = rels.length ? t('multi.savedDone', { count: rels.length }) : t('multi.forgotDone');
  } catch (error) {
    note.textContent = errorText(error);
  }
}

const skipReason = (item) => (item.reason === 'failed' ? t('multi.skipFailed', { error: item.error ?? '' }) : t(`multi.skip_${item.reason}`));

function notice(title, body) {
  return openDialog({ title, body, initialFocus: 'cancel', actions: [{ label: t('multi.ok'), value: null }] });
}

/**
 * Follows a batch the server goes on opening after its answer (`batchId`, launch gate):
 * every FOLLOW_MS it shows the agents opened since, leaving the terminal and the control the user
 * is on as they were, and once the batch ends it reports the queued folders that did not open.
 */
async function followBatch(batchId, workspace, queued, line) {
  const shown = new Set();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, FOLLOW_MS));
    let answer;
    try {
      answer = await api('GET', `/api/terminals/batch/${encodeURIComponent(batchId)}`);
    } catch {
      return; // Mirador restarted or forgot the batch: its agents show at the next load.
    }
    const progress = batchProgress(answer.results, queued, shown);
    if (progress.fresh.length) {
      const focused = document.activeElement;
      const current = activeTerminalId();
      showOpenedTerminals(progress.fresh);
      progress.fresh.forEach((info) => shown.add(info.id));
      if (current) activateTerminal(current, false);
      if (focused instanceof HTMLElement && focused !== document.body) focused.focus({ preventScroll: true });
    }
    if (!answer.done) continue;
    if (progress.notOpened.length) {
      await notice(t('multi.laterTitle', { opened: progress.opened, notOpened: progress.notOpened.length }), [
        el('ul', { class: 'pick-list' }, progress.notOpened.map((item) => el('li', {}, el('code', {}, item.rel || workspace.name), ` — ${line(item)}`))),
      ]);
    }
    return;
  }
}

/**
 * Opens gentle-shell in `rels` of a workspace, or in its saved projects when `rels` is null:
 * asks first when some already run an agent, shows the new terminals, reports skipped folders.
 */
async function openBatch(workspaceId, rels, trigger) {
  const workspace = workspaceById(workspaceId);
  const asked = rels ?? workspace?.projects ?? [];
  if (!workspace || !asked.length || trigger.hasAttribute('aria-busy')) return;
  let reopen = false;
  try {
    const busy = busyFolders(await api('GET', '/api/terminals'), workspaceId, asked);
    if (busy.length) {
      const choice = await openDialog({
        title: t('multi.busyTitle', { count: busy.length }),
        body: [el('p', {}, t('multi.busyBody')), el('ul', { class: 'pick-list' }, busy.map((rel) => el('li', {}, rel)))],
        actions: [
          { label: t('common.cancel'), value: null },
          { label: t('multi.busySkip'), value: 'skip' },
          { label: t('multi.busyReopen'), value: 'reopen', kind: 'primary' },
        ],
      });
      if (!choice) return;
      reopen = choice === 'reopen';
    }
  } catch (error) {
    return notice(t('multi.failedTitle'), [el('p', {}, errorText(error))]);
  }
  // The row's open button holds an icon and a text span: put the same nodes back afterwards.
  const label = [...trigger.childNodes];
  trigger.setAttribute('aria-busy', 'true');
  trigger.disabled = true;
  trigger.textContent = t('multi.opening', { count: asked.length });
  let summary = null;
  let answer = null;
  let failure = null;
  try {
    answer = await api('POST', '/api/terminals/batch', { ws: workspaceId, ...(rels ? { rels } : { saved: true }), reopen, ...newTerminalSize() });
    summary = summarizeBatch(answer.results);
  } catch (error) {
    failure = error;
  } finally {
    trigger.removeAttribute('aria-busy');
    trigger.disabled = false;
    trigger.replaceChildren(...label);
    pickBars.get(workspaceId)?.();
  }
  if (failure) return notice(t('multi.failedTitle'), [el('p', {}, errorText(failure))]);
  showOpenedTerminals(summary.opened);
  if (rels) {
    picked = unmarkAll(picked, workspaceId);
    syncBoxes(workspaceId);
  }
  const queued = queuedFolders(answer.results);
  if (answer.batchId) emit('launches');
  if (answer.batchId && queued.length) void followBatch(answer.batchId, workspace, queued, (item) => skipReason({ reason: item.status, error: item.error }));
  if (queued.length) {
    await notice(t('multi.queuedTitle', { opened: summary.opened.length, queued: queued.length }), [
      el('p', {}, t('multi.queuedHint')),
      el('ul', { class: 'pick-list' }, [
        ...queued.map((rel) => el('li', {}, el('code', {}, rel), ` — ${t('multi.skip_queued')}`)),
        ...summary.skipped.map((item) => el('li', {}, el('code', {}, item.rel), ` — ${skipReason(item)}`)),
      ]),
    ]);
  } else if (summary.skipped.length) {
    await notice(t('multi.reportTitle', { opened: summary.opened.length, skipped: summary.skipped.length }), [
      el('ul', { class: 'pick-list' }, summary.skipped.map((item) => el('li', {}, el('code', {}, item.rel), ` — ${skipReason(item)}`))),
    ]);
  }
}

/* ---------- Delegar a Sereno ---------- */

const delegateLine = (line) => (line.status === 'failed' ? t('delegate.status_failed', { error: line.error ?? '' }) : t(`delegate.status_${line.status}`));

/** The sensitive topic `text` mentions (POST /api/night/sensitive), or null; null too when the check fails. */
async function sensitiveTopic(text) {
  // The check is the night shift's (public/mode-model.js): plain mode never asks it.
  if (!showsExtra(state.config, 'night')) return null;
  try {
    return (await api('POST', '/api/night/sensitive', { text })).topic ?? null;
  } catch {
    return null;
  }
}

let improveId = 0;

/**
 * "Mejorar con IA" for one proposal field: the button with its cost, the outcome line,
 * "Deshacer", and the suggestion shown when the user edited the field while Claude answered.
 * `read`/`write` the field's text (`write` runs the field's own checks, the sensitive warning
 * included); `ws` and `rel` the folder whose memory, mission and skills Claude reads; `place`
 * names that folder in the cost line when the field covers several. Only fills the field:
 * sending stays with the dialog's own confirm. `relabel()` redraws its text in the current language.
 */
export function improveControls({ read, write, ws, rel, place = null }) {
  const id = `improve-${++improveId}`;
  const button = el('button', { type: 'button', class: 'btn improve-btn', 'aria-describedby': `${id}-cost` });
  const cost = el('span', { class: 'hint improve-cost', id: `${id}-cost` });
  const undo = el('button', { type: 'button', class: 'btn improve-undo' });
  const status = el('p', { class: 'improve-status', role: 'status' });
  const lead = el('p', { class: 'hint' });
  const text = el('blockquote', { class: 'improve-suggestion-text' });
  const apply = el('button', { type: 'button', class: 'btn' });
  const dismiss = el('button', { type: 'button', class: 'btn' });
  const suggestion = el('div', { class: 'improve-suggestion', role: 'group', 'aria-labelledby': `${id}-lead` }, lead, text, el('div', { class: 'improve-actions' }, apply, dismiss));
  lead.id = `${id}-lead`;
  const failure = (error) => {
    const key = `error.${error?.code}`;
    return error?.code && t(key) !== key ? t(key) : t('proposal.improve.failed');
  };
  const render = (view) => {
    button.disabled = view.pending;
    button.setAttribute('aria-busy', view.pending ? 'true' : 'false');
    button.textContent = view.pending ? t('proposal.improve.pending') : t('proposal.improve');
    cost.textContent = place ? `${t('proposal.improve.cost')} · ${t('proposal.improve.contextOf', { place })}` : t('proposal.improve.cost');
    undo.hidden = view.undo === null;
    undo.textContent = t('proposal.improve.undo');
    status.textContent = view.error ? failure(view.error) : view.undo !== null ? t('proposal.improve.done') : '';
    status.classList.toggle('error', !!view.error);
    suggestion.hidden = view.suggestion === null;
    lead.textContent = t('proposal.improve.suggestion');
    text.textContent = view.suggestion ?? '';
    apply.textContent = t('proposal.improve.apply');
    dismiss.textContent = t('proposal.improve.dismiss');
  };
  const control = improver({
    read,
    write,
    request: async (draft) => (await api('POST', '/api/proposals/improve', improveRequest(ws, rel, draft))).text,
    render,
  });
  button.addEventListener('click', () => control.improve());
  undo.addEventListener('click', () => control.undo());
  apply.addEventListener('click', () => control.apply());
  dismiss.addEventListener('click', () => control.dismiss());
  render(control.view());
  return { node: el('div', { class: 'improve' }, el('div', { class: 'improve-bar' }, button, cost, undo), status, suggestion), relabel: () => render(control.view()) };
}

/**
 * Asks for an instruction and delegates it to gentle-shell in `rels` of a workspace: new agents
 * get it as their first message, open ones as a message. Reports every folder. `fromSelection`:
 * the marked folders, unmarked once delegated. `instruction`: the editable text the field opens
 * with ("Traer a Mirador" in tracking.js prefills an outside project's Next Steps); without one,
 * Mirador proposes one from the folders' Next Steps (GET /api/proposals) once the dialog is open.
 * "Mejorar con IA" reads the first folder's memory: one call stays one folder's context, and the
 * proposal already carries every folder's Next Steps.
 */
export async function delegate(workspaceId, rels, { fromSelection = false, instruction = null } = {}) {
  const workspace = workspaceById(workspaceId);
  if (!workspace || !rels.length) return;
  let busy = [];
  try {
    busy = busyFolders(await api('GET', '/api/terminals'), workspaceId, rels);
  } catch {
    busy = [];
  }
  const id = `delegate-${++fieldId}`;
  const input = el('textarea', { id, rows: 4, spellcheck: 'true', autocomplete: 'off', placeholder: t('delegate.example'), 'aria-describedby': `${id}-proposal ${id}-hint ${id}-count ${id}-error ${id}-warn` });
  const proposal = el('p', { class: 'hint delegate-proposal', id: `${id}-proposal`, role: 'status' });
  const count = el('p', { class: 'hint delegate-count', id: `${id}-count` });
  const error = el('p', { class: 'field-error', id: `${id}-error`, role: 'alert' });
  const warning = el('p', { class: 'delegate-warn', id: `${id}-warn`, role: 'status' });
  const autopilot = el('input', { type: 'checkbox', id: `${id}-auto`, checked: true, 'aria-describedby': `${id}-auto-hint` });
  // What checking it does, shown only while it is checked.
  const autoHint = el('p', { class: 'hint', id: `${id}-auto-hint`, hidden: !autopilot.checked }, t('delegate.autopilotHint'));
  autopilot.addEventListener('change', () => { autoHint.hidden = !autopilot.checked; });
  const caret = icon('chev-right', { size: 'sm' });
  caret.classList.add('delegate-caret');
  const folders = rels.map((rel) => el('li', {}, el('code', {}, rel || workspace.name), busy.includes(rel) ? ` — ${t('delegate.busy')}` : ''));
  let warnedFor = null;
  let answer = null;

  const setError = (text) => {
    error.textContent = text ?? '';
    if (text) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  };
  const recount = () => {
    const check = checkInstruction(input.value);
    count.textContent = t('delegate.count', { count: check.count, max: MAX_INSTRUCTION });
    count.classList.toggle('over', check.count > MAX_INSTRUCTION);
    return check;
  };
  const validate = () => {
    const check = recount();
    setError(check.error ? t(`delegate.error_${check.error}`, { max: MAX_INSTRUCTION }) : null);
    return !check.error;
  };
  /** Shows the warning for the instruction as it is now; true when it mentions something sensitive. */
  const warn = async () => {
    const text = input.value.trim();
    const topic = text ? await sensitiveTopic(text) : null;
    if (input.value.trim() !== text) return false;
    warning.textContent = topic ? t('delegate.sensitive', { topic }) : '';
    if (topic) warnedFor = text;
    return !!topic;
  };
  let typed = false;
  input.addEventListener('input', () => {
    typed = true;
    recount();
    if (input.getAttribute('aria-invalid')) validate();
    if (warning.textContent && input.value.trim() !== warnedFor) warning.textContent = '';
  });
  input.addEventListener('blur', () => {
    if (input.value.trim()) validate();
    warn();
  });
  const toTop = () => { input.setSelectionRange(0, 0); input.scrollTop = 0; };
  input.value = instruction ?? '';
  recount();
  // A prefilled instruction gets its sensitive warning before the user edits it, like a typed one on blur.
  if (instruction) warn();
  // ...and opens at its first line, not scrolled to the caret at its end.
  if (instruction) input.addEventListener('focus', toTop, { once: true });
  /** Mirador's proposal from memory: it fills the field only while the user has not written anything. */
  const propose = async () => {
    proposal.textContent = t('delegate.proposalLoading');
    let text = '';
    try {
      const answer = await api('GET', `/api/proposals?${proposalQuery(workspaceId, rels)}`);
      text = proposalText(answer.proposals.map((p) => ({ label: p.rel || workspace.name, steps: p.nextSteps })), t('tracking.adopt.lead'), MAX_INSTRUCTION);
    } catch {
      text = '';
    }
    if (!text || typed || input.value.trim()) {
      proposal.textContent = '';
      return;
    }
    input.value = text;
    recount();
    proposal.textContent = t('delegate.proposal');
    warn();
    if (document.activeElement === input) toTop();
    else input.addEventListener('focus', toTop, { once: true });
  };
  // Plain mode has no memory to propose from (public/mode-model.js).
  if (instruction === null && showsExtra(state.config, 'memory')) propose();
  const improve = improveControls({
    read: () => input.value,
    write: (text) => {
      // Claude's version (or the draft "Deshacer" brings back) counts as typed: the prefill never replaces it.
      typed = true;
      input.value = text;
      recount();
      if (input.getAttribute('aria-invalid')) validate();
      warning.textContent = '';
      warn();
    },
    ws: workspaceId,
    rel: rels[0],
    place: rels.length > 1 ? rels[0] || workspace.name : null,
  });

  await openDialog({
    title: t('delegate.title'),
    className: 'delegate-dialog',
    body: [
      el('div', {}, el('p', {}, t('delegate.where', { count: rels.length })), el('ul', { class: 'pick-list' }, folders)),
      el('div', { class: 'field' }, el('label', { for: id }, t('delegate.label')), el('div', { class: 'proposal-bar' }, proposal, showsExtra(state.config, 'improve') ? improve.node : null), input, count, error, warning),
      el('div', { class: 'delegate-auto' }, autopilot, el('label', { for: `${id}-auto` }, t('delegate.autopilot')), autoHint),
      // The static hint, folded; the field's aria-describedby still reads it.
      el('details', { class: 'delegate-how' }, el('summary', {}, caret, t('delegate.howItWorks')), el('p', { class: 'hint', id: `${id}-hint` }, t('delegate.hint'))),
    ],
    initialFocus: input,
    actions: [
      { label: t('common.cancel'), value: null },
      { label: t('delegate.submit'), value: 'send', kind: 'primary', busyLabel: t('delegate.sending') },
    ],
    onAction: async () => {
      if (!validate()) {
        input.focus();
        return false;
      }
      // A sensitive instruction may go, but only once its warning was on screen.
      const text = input.value.trim();
      if (warnedFor !== text && (await warn())) {
        input.focus();
        return false;
      }
      try {
        answer = await api('POST', '/api/terminals/batch', delegateBody(workspaceId, rels, input.value, autopilot.checked, newTerminalSize()));
        return true;
      } catch (failure) {
        setError(errorText(failure));
        input.focus();
        return false;
      }
    },
  });
  if (!answer) return;
  const summary = summarizeDelegation(answer);
  showOpenedTerminals(summary.opened);
  if (fromSelection) {
    picked = unmarkAll(picked, workspaceId);
    syncBoxes(workspaceId);
  }
  const queued = queuedFolders(answer.results);
  if (answer.batchId) emit('launches');
  if (answer.batchId && queued.length) void followBatch(answer.batchId, workspace, queued, delegateLine);
  const title = queued.length
    ? t('delegate.queuedTitle', { done: summary.counts.done, queued: queued.length, notDone: summary.counts.notDone - queued.length })
    : t('delegate.reportTitle', summary.counts);
  await notice(title, [
    el('ul', { class: 'pick-list' }, summary.lines.map((line) => el('li', {}, el('code', {}, line.rel || workspace.name), ` — ${delegateLine(line)}`))),
    summary.autopilot ? el('p', {}, t(`delegate.autopilot_${summary.autopilot}`)) : null,
  ]);
}

function render() {
  for (const id of picking) if (!workspaceById(id)) picking.delete(id);
  pickBars.clear();
  loadedFolders.clear();
  const tree = slot('workspaces');
  const focused = document.activeElement?.closest?.('.row');
  const keep = focused && tree.contains(focused) ? { ws: focused.dataset.ws, rel: focused.dataset.rel } : null;
  tree.replaceChildren(...(state.workspaces.length ? state.workspaces.map(workspaceGroup) : [el('p', { class: 'notice empty-ws' }, t('ws.none'))]));
  if (keep) focusRow(keep);
  markSelected();
  refreshStatus();
}

function focusRow(folder) {
  const row = [...document.querySelectorAll('.row')].find((r) => r.dataset.ws === folder.ws && r.dataset.rel === folder.rel);
  row?.focus();
}

function markSelected() {
  document.querySelectorAll('.row').forEach((row) => {
    const selected = sameFolder(state.selection, { ws: row.dataset.ws, rel: row.dataset.rel });
    if (row.classList.contains('selected') === selected) return;
    row.classList.toggle('selected', selected);
    // Selected, the row shows its actions (and a workspace row its tool text) on its one line.
    fitRow(row);
  });
  rovingStop();
}

/* ---------- Rename (inline) ---------- */

function startRename(workspaceId, row, nameNode) {
  const workspace = workspaceById(workspaceId);
  if (!workspace || row.querySelector('input.rename')) return;
  const errorId = `rename-error-${++fieldId}`;
  const input = el('input', { class: 'rename', value: workspace.name, maxlength: 60, spellcheck: 'false', 'aria-label': t('ws.renameField'), 'aria-describedby': errorId });
  const error = el('div', { class: 'field-error rename-error', id: errorId, role: 'alert' });
  let done = false;
  const stop = () => {
    done = true;
    input.replaceWith(nameNode);
    error.remove();
    row.focus();
  };
  const save = async () => {
    if (done) return;
    const name = input.value.trim();
    if (name === workspace.name) return stop();
    try {
      const updated = await api('PATCH', workspaceUrl(workspaceId), { name });
      done = true;
      replaceWorkspace(updated);
      focusRow({ ws: workspaceId, rel: '' });
    } catch (failure) {
      input.setAttribute('aria-invalid', 'true');
      error.textContent = errorText(failure);
      if (!error.isConnected) row.after(error);
      input.focus();
    }
  };
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') stop();
  });
  input.addEventListener('blur', () => {
    if (!error.textContent) save();
  });
  nameNode.replaceWith(input);
  input.focus();
  input.select();
}

/* ---------- Dialogs: add, choose folders, remove ---------- */

/** A labelled input with a hint and an error line wired with aria-describedby. */
function field({ label, input, hint }) {
  const id = `field-${++fieldId}`;
  const hintNode = hint ? el('p', { class: 'hint', id: `${id}-hint` }, hint) : null;
  const errorNode = el('p', { class: 'field-error', id: `${id}-error`, role: 'alert' });
  input.id = id;
  input.setAttribute('aria-describedby', [hintNode && `${id}-hint`, `${id}-error`].filter(Boolean).join(' '));
  return {
    node: el('div', { class: 'field' }, el('label', { for: id }, label), input, hintNode, errorNode),
    setError(text) {
      errorNode.textContent = text ?? '';
      if (text) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    },
  };
}

async function addWorkspace() {
  const rootInput = el('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: t('ws.addRootExample') });
  const nameInput = el('input', { type: 'text', maxlength: 60, autocomplete: 'off' });
  const rootField = field({ label: t('ws.addRootLabel'), input: rootInput, hint: t('ws.addRootHint') });
  const nameField = field({ label: t('ws.addNameLabel'), input: nameInput, hint: t('ws.addNameHint') });
  rootInput.addEventListener('input', () => {
    nameInput.placeholder = rootInput.value.trim().replace(/\/+$/, '').split('/').pop() ?? '';
    if (rootInput.getAttribute('aria-invalid')) rootField.setError(null);
  });
  let added = null;
  await openDialog({
    title: t('ws.addTitle'),
    body: [rootField.node, nameField.node],
    initialFocus: rootInput,
    actions: [
      { label: t('common.cancel'), value: null },
      { label: t('ws.addSubmit'), value: 'add', kind: 'primary', busyLabel: t('ws.adding') },
    ],
    onAction: async () => {
      rootField.setError(null);
      nameField.setError(null);
      if (!rootInput.value.trim()) {
        rootField.setError(t('error.workspace_root'));
        rootInput.focus();
        return false;
      }
      try {
        added = await api('POST', '/api/workspaces', { root: rootInput.value.trim(), name: nameInput.value.trim() || undefined });
        return true;
      } catch (error) {
        const [target, input] = error.code === 'workspace_name' ? [nameField, nameInput] : [rootField, rootInput];
        target.setError(errorText(error));
        input.focus();
        return false;
      }
    },
  });
  if (!added) return;
  collapsed.delete(added.id);
  setWorkspaces([...state.workspaces, added]);
  select({ ws: added.id, rel: '' });
  focusRow({ ws: added.id, rel: '' });
}

async function chooseFolders(workspaceId) {
  const workspace = workspaceById(workspaceId);
  if (!workspace) return;
  let nodes;
  try {
    nodes = await api('GET', `/api/tree?ws=${encodeURIComponent(workspaceId)}&rel=&all=1`);
  } catch (error) {
    return showAlert(errorText(error));
  }
  // Folders chosen below the first level (through the API) stay in the list.
  const known = new Map(nodes.map((n) => [n.rel, n]));
  const rels = [...known.keys(), ...workspace.folders.filter((rel) => !known.has(rel))];
  const boxes = rels.map((rel) => el('input', { type: 'checkbox', value: rel, id: `pick-${++fieldId}`, checked: workspace.folders.includes(rel) }));
  const error = el('p', { class: 'field-error', role: 'alert' });
  const list = el(
    'ul',
    { class: 'picker' },
    boxes.map((box) => el('li', {}, box, el('label', { for: box.id }, box.value), known.has(box.value) ? noMemoryBadge(known.get(box.value)) : null)),
  );
  let updated = null;
  await openDialog({
    title: t('ws.foldersTitle', { name: workspace.name }),
    className: 'picker-dialog',
    body: [el('p', { class: 'hint' }, t('ws.foldersHint')), rels.length ? list : el('p', { class: 'notice' }, t('ws.foldersEmpty')), error],
    initialFocus: boxes[0] ?? 'cancel',
    actions: [
      { label: t('ws.foldersAll'), value: 'all', busyLabel: t('ws.saving') },
      { label: t('common.cancel'), value: null },
      { label: t('ws.foldersSave'), value: 'save', kind: 'primary', busyLabel: t('ws.saving') },
    ],
    onAction: async (value) => {
      const folders = value === 'all' ? [] : boxes.filter((box) => box.checked).map((box) => box.value);
      try {
        updated = await api('PATCH', workspaceUrl(workspaceId), { folders });
        return true;
      } catch (failure) {
        error.textContent = errorText(failure);
        return false;
      }
    },
  });
  if (updated) replaceWorkspace(updated);
}

async function removeWorkspace(workspaceId) {
  const workspace = workspaceById(workspaceId);
  if (!workspace) return;
  const error = el('p', { class: 'field-error', role: 'alert' });
  const removed = await openDialog({
    title: t('ws.removeTitle', { name: workspace.name }),
    body: [el('p', {}, t('ws.removeBody', { root: workspace.root })), error],
    actions: [
      { label: t('common.cancel'), value: null },
      { label: t('ws.removeSubmit'), value: 'remove', kind: 'danger', busyLabel: t('ws.removing') },
    ],
    onAction: async () => {
      try {
        await api('DELETE', workspaceUrl(workspaceId));
        return true;
      } catch (failure) {
        if (failure.status === 404) return true;
        error.textContent = errorText(failure);
        return false;
      }
    },
  });
  if (removed) setWorkspaces(state.workspaces.filter((w) => w.id !== workspaceId));
}

export async function init() {
  // Plain mode's "Where it left off" (git and NOTES.md, no Engram) in the panel, where gentle-deck shows overview.js's.
  registerPanelView(plainLeftOffView({ api, el, t, isPlain: () => modeOf(state.config) === 'plain' }));
  // The read-only "Changes" view (git diff against HEAD), in both modes.
  registerPanelView(changesView({ api, el, t }));
  $('#ws-add').addEventListener('click', addWorkspace);
  buildFilter();
  on('workspaces', render);
  on('selection', markSelected);
  on('language', render);
  on('rowactions', render);
  // One Tab stop for the tree (rovingStop); the focused row's actions join the Tab order.
  const tree = slot('workspaces');
  tree.addEventListener('keydown', treeKeys);
  tree.addEventListener('focusin', (e) => {
    const row = e.target.closest?.('.row');
    if (!row) return;
    rovingStop(row);
    actionStops(row, true);
  });
  tree.addEventListener('focusout', (e) => {
    const row = e.target.closest?.('.row');
    if (row && !row.contains(e.relatedTarget)) actionStops(row, false);
  });
  on('terminals', refreshStatus);
  // A tab click or a press on another grid tile (terminals.js revealTerminal) opens its place in the tree.
  on('reveal', revealPlace);
  // The active terminal's folder stays under the filter; the one active before may now hide.
  on('activate', () => {
    markActive();
    if (chosenStates.length && filterTree()) fitShownRows();
  });
  on('sleeping', refreshStatus);
  on('inbox', (items) => {
    inboxItems = Array.isArray(items) ? items : [];
    refreshStatus();
  });
  render();
  // Once the offered agents are known, the rows drawn before gain the ▾.
  loadAgents().then(addAgentCombos);
  // Dragging the sidebar edge (columns.js) changes the room of every row.
  if (typeof ResizeObserver === 'function') new ResizeObserver(fitShownRows).observe(slot('workspaces'));
}
