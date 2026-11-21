// Terminal manager shared by every feature: xterm panes, tabs or grid, open, activate, close.
// Tabs and grid panes are grouped by workspace; each group collapses on its own, and its
// terminals are reordered by dragging a tab or a pane header (terminal-order-model.js).
// The sidebar's state filter shows only the terminals
// whose pane state is picked, and the sleeping agents' entries only for "Dormidos". While it hides
// the active terminal, the tabs layout shows the first one it keeps without activating it.
// An agent's tab shows its agent's icon before its title (icons/agents.js tabAgent), so a
// gentle-shell tab and a Claude Code one tell apart at a glance; its tooltip names the agent.
// A path in a terminal's output that names an existing file of its workspace is a link that opens
// the file editor (fileLinks, file-links-model.js); WebLinksAddon keeps the http(s) links.
import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';
import { WebLinksAddon } from '/vendor/addon-web-links.mjs';
import { $, api, el, emit, errorText, getLanguage, on, prefs, richText, session, state, t, workspaceById } from '/core.js';
import { plural } from '/i18n.js';
import { agentLabel, emptyHintKey } from '/mode-model.js';
import { icon } from '/icons.js';
import { agentIcon, tabAgent } from '/icons/agents.js';
import { confirmDialog, showAlert } from '/dialog.js';
import { exitLabels, fitColumns, gridColumns, gridTracks, groupTerminals, mostRecentTerminal, reopensActiveGroup, reorderHintGroup, showsTabsBar, visibleCount } from '/terminal-groups.js';
import { moveTerminal, moveTerminalBy, readOrder } from '/terminal-order-model.js';
import { withSleepingGroups } from '/features/sleeping-model.js';
import { terminalBody } from '/features/agent-picker-model.js';
import { returningSizes } from '/terminal-size.js';
import { paneStatus } from '/pane-status-model.js';
import { showsAsTab } from '/terminal-kind-model.js';
import { matches, normalizeSelection, paneToShow, showsTerminal } from '/features/state-filter-model.js';
import { fileChecker, findFileLinks, linkRange, splitPath } from '/features/file-links-model.js';

const terminals = new Map();
const INPUT_CHUNK = 64 * 1024;
// Long enough for the program to see the shorter size before it gets its size back.
const REPAINT_DELAY = 200;
let activeId = null;
let layout = prefs.read('layout', 'tabs');
// The last measured width of the terminals area (applyLayout); unmeasured, the grid stays near-square.
let panesWidth = Infinity;

// Workspace ids whose group is collapsed, remembered per window.
const COLLAPSED_KEY = 'collapsedTerminalGroups';
const collapsedGroups = new Set([prefs.read(COLLAPSED_KEY, [])].flat().filter((id) => typeof id === 'string'));
// Terminal id → activation sequence number, to enter a workspace on its most recent terminal.
const activations = new Map();
let activationSeq = 0;
// Saved place of the terminals inside each workspace group, by folder and kind, shared by every window.
const ORDER_KEY = 'terminalOrder';
let terminalOrder = readOrder(prefs.read(ORDER_KEY, []));
// The terminal being dragged by its tab or pane header ({ id, node }), and the node marked as drop place.
const DRAG_TYPE = 'application/x-mirador-terminal';
let dragging = null;
let dropMark = null;
// Workspace id → { tabBox, tabHead, tabList, paneHead, sleepTab?, sleepPane? }: its block in #tabs and its header row in #panes.
const groupViews = new Map();
// Sleeping agents per workspace id (no terminal), and what their "Dormidos (N)" entry opens.
let sleepingCounts = new Map();
let openSleeping = null;
// Terminal id → its inbox item (the `inbox` event of features/inbox.js), which the agent states read.
let inboxByTerminal = new Map();
// The states the sidebar's filter picked (none: every terminal shows), and its "Ver todos". Read
// from the pref features/workspaces.js saves, since it sends them only after initTerminals picked
// the first terminal: a reload must not activate one the filter hides.
let stateFilter = normalizeSelection(prefs.read('stateFilter', []));
let showAllStates = null;
// The terminal whose pane shows (showPane): the active one, or a stand-in while the filter hides it.
let shownId = null;
// The offered agents (GET /api/agents, read by initTerminals): the configured agent's catalog id
// and the chosen agents' labels, which the agent tabs show (tabAgent).
let offeredAgents = [];
// Whether a path in a terminal's output names a file: GET /api/files lists its folder, cached
// (fileChecker), so hovering the same line again asks nothing new.
const fileExists = fileChecker(async (ws, rel) => (await api('GET', `/api/files?${new URLSearchParams({ ws, rel })}`)).files.map((file) => file.name));

// ANSI colors stay the same in every theme: the terminal is a dark well (styles.css --well*).
const XTERM_ANSI = {
  black: '#1b1f27', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#c0caf5',
  brightBlack: '#565f89', brightRed: '#ff8ea3', brightGreen: '#b5e48c', brightYellow: '#f0c987', brightBlue: '#9ab8ff', brightMagenta: '#cfb5ff', brightCyan: '#a3dcff', brightWhite: '#e6ebf5',
};

/** The xterm theme for the current page theme: background, text and cursor from the well tokens. */
function xtermTheme() {
  const style = getComputedStyle(document.documentElement);
  const token = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  return {
    ...XTERM_ANSI,
    background: token('--well', '#1b1d22'),
    foreground: token('--well-ink', '#e3e5e8'),
    cursor: token('--well-work', '#8fb1f0'),
    selectionBackground: '#2e3a55',
  };
}

/** TerminalInfo of every terminal this window shows, in creation order (groupTerminals applies the saved order). */
export function terminalList() {
  return [...terminals.values()].map((record) => record.info);
}

export function activeTerminalId() {
  return activeId;
}

/**
 * Hook for the attention inbox (W4): marks the tab and pane of every terminal in
 * `waiting` (a Map of id → reason text) as waiting for an answer, and of every
 * terminal in `finished` as done with its turn; clears the marks everywhere else. The
 * state glyph and pill that follow (paintState, on the `inbox` event) take the reason as
 * their name. Styles live in styles/inbox.css.
 */
export function markWaiting(waiting, finished = new Map()) {
  for (const [id, record] of terminals) {
    for (const node of [record.tab, record.pane]) {
      for (const [key, map] of [['waiting', waiting], ['finished', finished]]) {
        if (map.has(id)) node.dataset[key] = map.get(id);
        else delete node.dataset[key];
      }
    }
  }
  renderGroups(); // A collapsed group keeps the mark on its header.
}

/**
 * Hook for the sleeping agents (public/features/sleeping.js): `counts` maps a workspace id to
 * its sleeping agents. Each such workspace's group ends with a "Dormidos (N)" entry that calls
 * `open(workspaceId)`, and a workspace whose agents all sleep gets a group of its own (no pane).
 */
export function setSleeping(counts, open) {
  sleepingCounts = counts;
  openSleeping = open;
  applyLayout();
}

/**
 * Hook for the sidebar's state filter (features/workspaces.js): `states` are the picked states
 * (state-filter-model.js), none for every terminal; `showAll` is its "Ver todos", which the notice
 * shown while nothing matches offers.
 */
export function setStateFilter(states, showAll) {
  showAllStates = showAll;
  if (states.join() === stateFilter.join()) return;
  stateFilter = [...states];
  applyLayout();
}

/**
 * The { workspaceId, rel } of the active terminal, which the state filter never hides, for the
 * sidebar tree (state-filter-model.js treeView `pinned`); null when no terminal is active.
 */
export function activePlace() {
  const info = terminals.get(activeId)?.info;
  return info ? { workspaceId: info.workspaceId, rel: info.rel ?? '' } : null;
}

/** A terminal's state as its pane shows it (paneStatus, the sidebar's), which the filter reads. */
const paneState = (info) => paneStatus(info, inboxByTerminal.get(info.id)).state;

/**
 * The terminals the filter shows: those whose pane state is picked, and the active one whatever its
 * state (state-filter-model.js showsTerminal).
 */
function shownTerminals() {
  return terminalList().filter((info) => showsTerminal(stateFilter, activeId, { id: info.id, state: paneState(info) }));
}

/**
 * Shows the active terminal's pane, or, while the filter hides it, the first one it keeps as a
 * stand-in (state-filter-model.js paneToShow), expanded groups first; none while nothing matches.
 * The stand-in is only shown, never activated: features/inbox.js marks an activated terminal seen,
 * which would take a finished turn out of a "Terminó" filter. Its tab reads as selected, since its
 * pane is the one on screen.
 */
function showPane() {
  const groups = groupTerminals(terminalList(), state.workspaces, terminalOrder);
  const order = [...groups.filter((group) => !collapsedGroups.has(group.workspaceId)), ...groups.filter((group) => collapsedGroups.has(group.workspaceId))];
  const candidates = order.flatMap((group) => group.terminals).map((info) => ({ id: info.id, state: paneState(info) }));
  const next = paneToShow(stateFilter, activeId, candidates, { exemptActive: true });
  for (const [id, record] of terminals) {
    record.tabItem.setAttribute('aria-selected', String(id === next));
    // Roving tabindex: the shown tab is the strip's one Tab stop (tabKeys moves it).
    record.tabItem.tabIndex = id === next ? 0 : -1;
    record.pane.classList.toggle('stand-in', id === next && id !== activeId);
  }
  const tabs = visibleTabs();
  if (!tabs.some((node) => node.tabIndex === 0)) tabs[0]?.setAttribute('tabindex', '0');
  if (next === shownId) return;
  shownId = next;
  const record = terminals.get(next);
  if (record) requestAnimationFrame(() => refit(record));
}

/** "Workspace › folder" for a terminal, from the workspace it was opened in. */
function placeLabel(info) {
  const name = workspaceById(info.workspaceId)?.name ?? info.workspaceId;
  return info.rel ? `${name} › ${info.rel}` : name;
}

/**
 * The agent's state (pane-status-model.js, the sidebar's own) as the design draws it: a glyph on
 * the tab, a pill with the glyph and its word on the pane head, and the waiting or error border on
 * the pane. Named by the inbox reason markWaiting wrote, else by the word.
 */
function paintState(record) {
  const { state, icon: name, border } = paneStatus(record.info, inboxByTerminal.get(record.info.id));
  const word = state ? t(`states.label.${state}`) : '';
  const reason = record.pane.dataset.waiting ?? record.pane.dataset.finished ?? '';
  const glyph = state ? icon(name, { label: reason || word }) : null;
  glyph?.classList.add('glyph', `s-${state}`);
  record.tab.querySelector('.term-mark').replaceChildren(...(glyph ? [glyph] : []));
  const pill = record.pane.querySelector('.pane-head > .st');
  pill.hidden = !state;
  pill.className = state ? `st s-${state}` : 'st';
  pill.title = reason;
  pill.replaceChildren(...(state ? [icon(name), word] : []));
  record.pane.classList.toggle('waiting', border === 'waiting');
  record.pane.classList.toggle('error', border === 'error');
}

/** The agent a terminal's tab shows (tabAgent): the configured one named as the tree's agent button names it. */
const agentOf = (info) => tabAgent(info, offeredAgents, agentLabel(state.config));

/**
 * The tab's agent (tabAgent) before its title: its icon, decorative, and its name for screen
 * readers, read with the title. None on a bash tab. Drawn again only when the agent changes.
 */
function paintAgent(record, agent) {
  const mark = record.tab.querySelector('.agent-mark');
  const key = agent ? `${agent.id}\n${agent.label}` : '';
  if (mark.dataset.agent === key) return;
  mark.dataset.agent = key;
  mark.replaceChildren(...(agent ? [agentIcon(agent.id), el('span', { class: 'agent-name' }, `${agent.label} `)] : []));
}

function updateStatus(term) {
  const exited = term.info.status === 'exited';
  const { state, kind } = paneStatus(term.info, inboxByTerminal.get(term.info.id));
  const ended = exited ? exitLabels(term.info, t).tab : null;
  term.tab.classList.toggle('exited', exited);
  // An agent's tab shows its state glyph; otherwise the tab says how it ended, or that it is a shell.
  term.tab.querySelector('.kind').textContent = state ? '' : ended ?? kind ?? '';
  // The pane head: a shell's kind where an agent has its pill, and how it ended in place of its folder.
  term.pane.querySelector('.pane-head > .kind').textContent = kind ?? '';
  const agent = agentOf(term.info);
  const named = agent ? `\n${t('term.agentTitle', { agent: agent.label })}` : '';
  term.tab.title = `${term.info.title}\n${placeLabel(term.info)}\n${term.info.cwd}${named}\n${t('term.reorderHint')}`;
  paintAgent(term, agent);
  term.pane.querySelector('.pane-head').title = t('term.reorderHint');
  term.pane.querySelector('.cwd').textContent = ended ?? placeLabel(term.info);
  [term.tab, term.pane].forEach((node) => node.querySelectorAll('.close').forEach((b) => { b.title = t('term.close'); b.setAttribute('aria-label', t('term.close')); }));
  paintState(term);
}

/** The pane head's drag grip (artboard 03 .grip); the whole head drags. */
function grip() {
  const node = icon('grip');
  node.classList.add('grip');
  return node;
}

/** The tabs of the strip that show: the filter hides some, and a collapsed group hides its own. */
function visibleTabs() {
  return [...$('#tabs').querySelectorAll('[role="tab"]')].filter((node) => !node.closest('[hidden]'));
}

/**
 * A tab's keys (APG tabs, manual activation): ←/→ move the focus to the previous or next visible
 * tab, wrapping, Home/End to the first or last, and Enter or Space activate the focused one, as a
 * click does. Alt+Shift+←/→ never gets here: moveByKeyboard takes it first to reorder.
 */
function tabKeys(event, id) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    return activateTerminal(id);
  }
  const tabs = visibleTabs();
  const here = tabs.indexOf(event.currentTarget);
  const index = { ArrowLeft: here - 1, ArrowRight: here + 1, Home: 0, End: tabs.length - 1 }[event.key];
  if (index === undefined || here < 0) return;
  event.preventDefault();
  const target = tabs[(index + tabs.length) % tabs.length];
  for (const node of tabs) node.tabIndex = -1;
  target.tabIndex = 0;
  target.focus();
}

function mountTerminal(info) {
  const closeButton = () => el('button', { class: 'close', title: t('term.close'), 'aria-label': t('term.close'), onclick: (e) => { e.stopPropagation(); closeTerminal(info.id); } }, icon('close'));
  // The role=tab holds the glyph, the agent, the title and the kind; its × sits beside it in the wrapper,
  // since a tab may not hold a button. The wrapper is what drags, looks like a tab and is hidden.
  const tabItem = el(
    'span',
    { class: 'tab-item', role: 'tab', id: `term-tab-${info.id}`, tabindex: '-1', 'aria-selected': 'false', 'aria-controls': `term-pane-${info.id}`, onkeydown: (event) => tabKeys(event, info.id) },
    el('span', { class: 'term-mark' }),
    el('span', { class: 'agent-mark' }),
    el('span', { class: 'tab-title' }, info.title),
    el('span', { class: 'kind' }),
  );
  const tab = el(
    'div',
    { class: 'tab', 'data-terminal-id': info.id, title: `${info.title}\n${placeLabel(info)}\n${info.cwd}`, translate: 'no', onclick: () => activateTerminal(info.id) },
    tabItem,
    closeButton(),
  );
  const body = el('div', { class: 'pane-body' });
  const pane = el(
    'div',
    { class: 'pane', 'data-terminal-id': info.id, id: `term-pane-${info.id}`, onmousedown: () => activateTerminal(info.id, false), translate: 'no' },
    el('div', { class: 'pane-head' }, grip(), el('span', { class: 'st', hidden: true }), el('span', { class: 'kind' }), el('span', { class: 'pane-title' }, info.title), el('span', { class: 'cwd', title: info.cwd }, placeLabel(info)), closeButton()),
    body,
  );
  // The tab, or the pane by its header in the grid, drags to another place in its group.
  wireDrag(tab, tab, info.id);
  wireDrag(pane.querySelector('.pane-head'), pane, info.id);
  // renderGroups() moves both into their workspace group; xterm needs the pane in the document to open.
  $('#panes').append(pane);
  return connectTerminal(info, pane, body, {
    created: (record) => {
      record.tab = tab;
      record.tabItem = tabItem;
      terminals.set(info.id, record);
    },
    status: updateStatus,
    exited: () => {
      // Its state changed: the filter may now hide or show it.
      if (stateFilter.length) applyLayout();
      emit('terminals', terminalList());
    },
    kept: () => terminals.has(info.id),
  });
}

/**
 * Opens an xterm for `info` in `body` (inside `pane`, which must be in the document and is what
 * refit measures) and attaches it to the terminal's WebSocket. `hooks`: created(record) once the
 * record exists, status(record) when its info changes, exited(record) after the exit line is
 * written, kept() whether a closed socket still belongs to a shown terminal. Returns the record.
 */
export function connectTerminal(info, pane, body, hooks) {
  const term = new Terminal({
    fontFamily: '"JetBrainsMono Nerd Font", "JetBrains Mono", monospace',
    fontSize: 12,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    theme: xtermTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  // The browser's page translation never rewrites terminal text.
  body.setAttribute('translate', 'no');
  term.open(body);

  const record = { info, term, fit, pane, ws: null };
  term.loadAddon(fileLinks(record, body));
  hooks.created?.(record);
  hooks.status?.(record);

  const send = (message) => record.ws?.readyState === WebSocket.OPEN && record.ws.send(JSON.stringify(message));
  record.send = send;
  // A big paste arrives as one string; the server caps frames at 1 MiB.
  term.onData((d) => {
    for (let i = 0; i < d.length; i += INPUT_CHUNK) send({ t: 'i', d: d.slice(i, i + INPUT_CHUNK) });
  });
  // Only a size measured on screen goes to the pty, not the one set to draw the replay.
  term.onResize(({ cols, rows }) => record.replaying || send({ t: 'r', c: cols, r: rows }));
  new ResizeObserver(() => refit(record)).observe(body);
  // A full-screen program redraws only the rows that change, so the replay may lack some
  // (an idle footer, the input box). It draws a whole frame when its size changes: shrink
  // the pty by a row, then give the size back.
  const repaint = () => {
    if (term.buffer.active.type !== 'alternate' || term.rows < 3) return;
    send({ t: 'r', c: term.cols, r: term.rows - 1 });
    setTimeout(() => send({ t: 'r', c: term.cols, r: term.rows }), REPAINT_DELAY);
  };

  const ws = new WebSocket(`ws://${location.host}/ws/terminals/${info.id}`, ['mirador.v1', `auth.${session.token}`]);
  record.ws = ws;
  // A hidden pane has no size of its own yet: the pty keeps its size until the pane shows.
  ws.addEventListener('open', () => refit(record) && send({ t: 'r', c: term.cols, r: term.rows }));
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.t === 's') {
      record.info = message.info;
      hooks.status?.(record);
      // The replay was drawn for the pty's size: written at another size its rows wrap
      // and its cursor moves miss, piling up copies. Fit the pane once it is written.
      term.reset();
      record.replaying = true;
      if (message.info.cols && message.info.rows) term.resize(message.info.cols, message.info.rows);
      record.replaying = false;
      record.replayWriting = true;
      term.write(message.d, () => {
        record.replayWriting = false;
        refit(record);
        repaint();
      });
    } else if (message.t === 'o') {
      term.write(message.d);
    } else if (message.t === 'x') {
      // The server sends the ended terminal's info: its signal, and whether memory ran out.
      record.info = message.info ?? { ...record.info, status: 'exited', exitCode: message.code };
      hooks.status?.(record);
      term.write(`\r\n\x1b[2m${exitLabels(record.info, t).line}\x1b[0m\r\n`);
      hooks.exited?.(record);
    }
  });
  ws.addEventListener('close', () => {
    if (hooks.kept() && record.info.status === 'running') {
      term.write(`\r\n\x1b[33m${t('term.lost')}\x1b[0m\r\n`);
    }
  });
  return record;
}

/* ---------- File links ---------- */

/**
 * Buffer row `row` (0-based) with the rows it wraps into, as one text: `text`, and `cells`, each
 * character's cell { x, y, width } (1-based) for linkRange. The second cell of a wide character has
 * no character of its own.
 */
function wrappedLine(buffer, row) {
  let first = row;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first -= 1;
  let last = row;
  while (buffer.getLine(last + 1)?.isWrapped) last += 1;
  let text = '';
  const cells = [];
  for (let y = first; y <= last; y += 1) {
    const line = buffer.getLine(y);
    for (let x = 0; line && x < line.length; x += 1) {
      const cell = line.getCell(x);
      const width = cell?.getWidth() ?? 1;
      if (width === 0) continue;
      const chars = cell?.getChars() || ' ';
      for (let i = 0; i < chars.length; i += 1) cells.push({ x: x + 1, y: y + 1, width });
      text += chars;
    }
  }
  return { text, cells };
}

/** The xterm link for `found` (a findFileLinks candidate): a click opens its folder's editor on the file. */
function fileLink(record, body, found, range, text) {
  const { info } = record;
  const { dir, name } = splitPath(found.path);
  return {
    range,
    text,
    activate: () => emit('files:open', { ws: info.workspaceId, rel: dir, path: name }),
    hover: () => {
      body.title = t('term.fileLink', { path: found.path });
    },
    leave: () => body.removeAttribute('title'),
  };
}

/**
 * xterm's provideLinks for buffer line `line` (1-based): the paths findFileLinks reads in it (with
 * the rows it wraps into), given to xterm only once fileExists says each names a file.
 */
function provideFileLinks(record, body, line, callback) {
  const { info, term } = record;
  const workspace = workspaceById(info.workspaceId);
  if (!workspace) return callback(undefined);
  const { text, cells } = wrappedLine(term.buffer.active, line - 1);
  const found = findFileLinks(text, { root: workspace.root, rel: info.rel ?? '', cwd: info.cwd });
  if (!found.length) return callback(undefined);
  Promise.all(found.map((link) => fileExists(info.workspaceId, link.path))).then((exists) => {
    const links = found.filter((link, index) => exists[index]).map((link) => fileLink(record, body, link, linkRange(cells, link.start, link.end), text.slice(link.start, link.end)));
    callback(links.length ? links : undefined);
  });
}

/** An xterm addon that links the file paths of the terminal `record` shows in `body`. */
function fileLinks(record, body) {
  let provider = null;
  return {
    activate(term) {
      provider = term.registerLinkProvider({ provideLinks: (line, callback) => provideFileLinks(record, body, line, callback) });
    },
    dispose() {
      provider?.dispose();
      provider = null;
    },
  };
}

/* ---------- Reordering ---------- */

/** Saves `next` as the terminal order and lays the groups out again, unless nothing changed. */
function saveOrder(next) {
  if (next === terminalOrder) return;
  terminalOrder = next;
  prefs.write(ORDER_KEY, [...next]);
  applyLayout();
}

/**
 * `update(order, terminals)` on the order read again from prefs, so the places another window
 * saved are kept; the current order if `update` refused the move.
 */
function moved(update) {
  const saved = readOrder(prefs.read(ORDER_KEY, []));
  const next = update(saved, terminalList());
  return next === saved ? terminalOrder : next;
}

/** Where the dragged terminal would drop on terminal `targetId` (shown by `node`): 'before', 'after', or null outside its group. */
function dropPlace(targetId, node, event) {
  const source = dragging && terminals.get(dragging.id);
  if (!source || dragging.id === targetId || source.info.workspaceId !== terminals.get(targetId)?.info.workspaceId) return null;
  const box = node.getBoundingClientRect();
  return event.clientX < box.left + box.width / 2 ? 'before' : 'after';
}

function markDrop(node, place) {
  if (dropMark && dropMark !== node) delete dropMark.dataset.drop;
  dropMark = node;
  if (node) node.dataset.drop = place;
}

function endDrag() {
  dragging?.node.classList.remove('dragging');
  dragging = null;
  markDrop(null);
}

/** Lets `handle` drag terminal `id` (its `node` looks dragged) and `node` take a drop from its own group. */
function wireDrag(handle, node, id) {
  handle.draggable = true;
  handle.addEventListener('dragstart', (event) => {
    dragging = { id, node };
    event.dataTransfer.setData(DRAG_TYPE, id);
    event.dataTransfer.effectAllowed = 'move';
    node.classList.add('dragging');
  });
  handle.addEventListener('dragend', endDrag);
  node.addEventListener('dragover', (event) => {
    const place = dropPlace(id, node, event);
    if (!place) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    markDrop(node, place);
  });
  node.addEventListener('dragleave', (event) => {
    if (dropMark === node && !node.contains(event.relatedTarget)) markDrop(null);
  });
  node.addEventListener('drop', (event) => {
    const place = dropPlace(id, node, event);
    if (!place) return;
    event.preventDefault();
    const draggedId = dragging.id;
    // Laying out moves the dragged node, and a moved node may not get its dragend.
    endDrag();
    saveOrder(moved((order, list) => moveTerminal(order, list, draggedId, id, place)));
  });
}

/** Alt+Shift+← / → in the terminals area moves the active terminal one place in its group, without dragging. */
function moveByKeyboard(event) {
  const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
  if (!step || !event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey || !activeId) return;
  if (!event.target.closest?.('#panes, #tabs')) return;
  // Before xterm, which would send the keys to the program.
  event.preventDefault();
  event.stopPropagation();
  saveOrder(moved((order, list) => moveTerminalBy(order, list, activeId, step)));
  terminals.get(activeId)?.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** Fits a visible terminal to its pane; false if it is hidden (it fits when it shows). */
function refit(record) {
  if (!record.pane.offsetParent) return false;
  try {
    record.fit.fit();
  } catch {
    // xterm throws if the element has no size yet.
  }
  return true;
}

/**
 * A window that comes back retakes the pty size: the pty keeps the
 * last size any window sent, and this window's panes did not change, so xterm's onResize
 * stays silent. Every visible terminal here sends its size again, even if unchanged.
 */
function retakeSizes() {
  const facts = [...terminals.values()].map((record) => {
    const replaying = Boolean(record.replaying || record.replayWriting);
    // Refitting mid-replay would rewrap it; refit() is false for a hidden pane.
    const visible = !replaying && refit(record);
    return { id: record.info.id, visible, replaying, cols: record.term.cols, rows: record.term.rows };
  });
  for (const { id, message } of returningSizes(facts)) terminals.get(id)?.send(message);
}

/**
 * Shows terminal `id` (its tab, or its cell in the grid) and focuses it unless `focus` is false.
 * Expands its workspace group if it was collapsed. While the state filter is on, it shows whatever
 * its state, and the one active before hides if the filter leaves it out (shownTerminals).
 */
export function activateTerminal(id, focus = true) {
  const target = terminals.get(id);
  const expanding = Boolean(target && collapsedGroups.delete(target.info.workspaceId));
  if (expanding) saveCollapsed();
  const switching = stateFilter.length > 0 && id !== activeId;
  activeId = id;
  if (expanding || switching) applyLayout();
  if (target) activations.set(id, ++activationSeq);
  for (const [tid, record] of terminals) record.pane.classList.toggle('active', tid === id);
  showPane();
  const record = terminals.get(id);
  if (!record) return;
  if (focus) record.term.focus();
  requestAnimationFrame(() => refit(record));
  record.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  // W4 inbox hook: the user is now looking at this terminal.
  emit('activate', id);
}

function applyLayout() {
  const panes = $('#panes');
  panes.dataset.layout = layout;
  document.querySelectorAll('[data-layout]').forEach((b) => b.tagName === 'BUTTON' && b.setAttribute('aria-pressed', String(b.dataset.layout === layout)));
  const grid = layout === 'grid';
  $('#tabs').hidden = !showsTabsBar(layout);
  // Each group takes a header row, then its panes unless collapsed; columns follow the visible
  // panes, as many as the terminals area holds at 300px each, and a narrow area stacks them in
  // one column (watchPanesWidth). With fewer columns than panes want, the grid scrolls.
  // A hidden area (the tracking view) has no width: it keeps the width it had.
  if (panes.clientWidth > 0) panesWidth = panes.clientWidth;
  const groups = renderGroups();
  const tracks = gridTracks(groups, collapsedGroups, panesWidth);
  const stacked = grid && tracks.columns < gridColumns(visibleCount(groups, collapsedGroups));
  panes.toggleAttribute('data-stacked', stacked);
  panes.style.gridTemplateColumns = grid ? `repeat(${tracks.columns}, minmax(0, 1fr))` : '';
  panes.style.gridTemplateRows = grid ? tracks.rows.join(' ') : '';
  panes.style.gridAutoRows = grid ? 'minmax(0, 1fr)' : '';
  requestAnimationFrame(() => terminals.forEach(refit));
}

/** Lays the grid out again when the terminals area crosses a width that changes the columns it holds. */
function watchPanesWidth() {
  const panes = $('#panes');
  new ResizeObserver(() => {
    if (layout !== 'grid' || panes.clientWidth === 0) return;
    if (fitColumns(panes.clientWidth) !== fitColumns(panesWidth)) applyLayout();
  }).observe(panes);
}

/* ---------- Workspace groups ---------- */

function saveCollapsed() {
  prefs.write(COLLAPSED_KEY, [...collapsedGroups]);
}

/** Puts `nodes` in order at the start of `parent` (after `after`), moving only the ones out of place. */
function placeChildren(parent, nodes, after = null) {
  let cursor = after ? after.nextElementSibling : parent.firstElementChild;
  for (const node of nodes) {
    if (node === cursor) cursor = cursor.nextElementSibling;
    else parent.insertBefore(node, cursor);
  }
}

function groupHead(workspaceId) {
  return el(
    'button',
    { type: 'button', class: 'term-group-head', onclick: () => toggleGroup(workspaceId) },
    el('span', { class: 'term-group-caret', 'aria-hidden': 'true' }),
    el('span', { class: 'term-group-name' }),
    el('span', { class: 'term-group-count', 'aria-hidden': 'true' }),
    el('span', { class: 'term-group-mark', 'aria-hidden': 'true' }),
  );
}

function groupView(workspaceId) {
  if (!groupViews.has(workspaceId)) {
    const tabHead = groupHead(workspaceId);
    const tabList = el('div', { class: 'tab-group-tabs' });
    groupViews.set(workspaceId, {
      tabHead,
      tabList,
      tabBox: el('div', { class: 'tab-group', role: 'group' }, tabHead, tabList),
      paneHead: el('div', { class: 'pane-group-head' }, groupHead(workspaceId)),
      hint: el('span', { class: 'term-group-hint', hidden: true }),
    });
  }
  return groupViews.get(workspaceId);
}

/** Header text: caret, name, count and the inbox mark (waiting wins over finished), also as an accessible name. */
function fillHeads(view, group, records, collapsed) {
  const waiting = records.filter((r) => r.tab.dataset.waiting !== undefined).length;
  const finished = records.filter((r) => r.tab.dataset.waiting === undefined && r.tab.dataset.finished !== undefined).length;
  const label = [group.name, plural(getLanguage(), 'termGroup.terminals', records.length)];
  if (waiting) label.push(plural(getLanguage(), 'termGroup.waiting', waiting));
  if (finished) label.push(plural(getLanguage(), 'termGroup.finished', finished));
  if (group.sleeping) label.push(plural(getLanguage(), 'termGroup.sleeping', group.sleeping));
  view.tabBox.setAttribute('aria-label', group.name);
  for (const button of [view.tabHead, view.paneHead.firstElementChild]) {
    button.setAttribute('aria-expanded', String(!collapsed));
    button.setAttribute('aria-label', label.join(', '));
    button.title = t(collapsed ? 'termGroup.expand' : 'termGroup.collapse', { name: group.name });
    button.dataset.mark = waiting ? 'waiting' : finished ? 'finished' : '';
    button.querySelector('.term-group-caret').replaceChildren(collapsed ? icon('chev-right') : icon('chev-down'));
    button.querySelector('.term-group-name').textContent = group.name;
    // "2 terminales" (artboard 03 .group-name .n); a group of only sleeping agents counts none.
    const count = button.querySelector('.term-group-count');
    count.textContent = plural(getLanguage(), 'termGroup.terminals', records.length);
    count.hidden = !records.length;
    button.querySelector('.term-group-mark').replaceChildren(...(waiting ? [icon('wait')] : finished ? [icon('check')] : []));
  }
}

/** The group's "Dormidos (N)" entry in the tabs bar (`where` 'sleepTab') or the grid header ('sleepPane'), built once. */
function sleepEntry(view, where, group) {
  view[where] ??= el('button', { type: 'button', class: 'sleep-entry', 'aria-haspopup': 'dialog', onclick: () => openSleeping?.(group.workspaceId) });
  const entry = view[where];
  entry.replaceChildren(icon('sleep'), t('sleeping.entry', { count: group.sleeping }));
  entry.title = t('sleeping.entryTitle', { name: group.name });
  return entry;
}

/**
 * Lays out #tabs and #panes as one group per workspace, in sidebar order: a header,
 * then that workspace's tabs or panes, and its sleeping agents' entry. A collapsed
 * group hides its tabs, and its panes in the grid. Returns the groups.
 */
function renderGroups() {
  const visible = shownTerminals();
  const sleeping = matches(stateFilter, 'sleep') ? sleepingCounts : new Map();
  const groups = withSleepingGroups(groupTerminals(visible, state.workspaces, terminalOrder), sleeping, state.workspaces);
  // The terminals the filter leaves out keep their nodes, hidden.
  const shownIds = new Set(visible.map((info) => info.id));
  for (const [id, record] of terminals) {
    record.tab.hidden = !shownIds.has(id);
    record.pane.hidden = !shownIds.has(id);
    // The active terminal shows only because it is active: its tab reads dimmed.
    record.tab.classList.toggle('off-filter', id === activeId && !matches(stateFilter, paneState(record.info)));
  }
  // Nothing in a picked state, though there are terminals or sleeping agents: say so, with "Ver todos".
  // The tabs layout has no pane to show even while a group holds only its "Dormidos (N)" entry.
  const none = showsTabsBar(layout) ? !visible.length : !groups.length;
  $('#filter-empty').hidden = !(stateFilter.length && none && (terminals.size || sleepingCounts.size));
  const focused = document.activeElement;
  const tabBoxes = [];
  const paneRows = [];
  const hinted = reorderHintGroup(groups, collapsedGroups);
  for (const group of groups) {
    const view = groupView(group.workspaceId);
    const collapsed = collapsedGroups.has(group.workspaceId);
    const records = group.terminals.map((info) => terminals.get(info.id));
    placeChildren(view.tabList, [...records.map((r) => r.tab), ...(group.sleeping ? [sleepEntry(view, 'sleepTab', group)] : [])]);
    if (group.sleeping) view.paneHead.append(sleepEntry(view, 'sleepPane', group));
    else {
      view.sleepTab?.remove();
      view.sleepPane?.remove();
    }
    // "Arrastra una cabecera para reordenar" ends the grid header of one group (reorderHintGroup).
    view.hint.textContent = t('termGroup.reorderHint');
    view.hint.hidden = group.workspaceId !== hinted;
    view.paneHead.append(view.hint);
    view.tabList.hidden = collapsed;
    records.forEach((r) => r.pane.classList.toggle('group-collapsed', collapsed));
    fillHeads(view, group, records, collapsed);
    tabBoxes.push(view.tabBox);
    paneRows.push(view.paneHead, ...records.map((r) => r.pane));
  }
  const shown = new Set(groups.map((group) => group.workspaceId));
  for (const [workspaceId, view] of groupViews) {
    if (shown.has(workspaceId)) continue;
    view.tabBox.remove();
    view.paneHead.remove();
    groupViews.delete(workspaceId);
  }
  placeChildren($('#tabs'), tabBoxes);
  placeChildren($('#panes'), paneRows, $('#empty-state'));
  // Moving a node blurs whatever it holds, e.g. the terminal being typed in.
  if (focused && focused !== document.activeElement && focused.isConnected) focused.focus({ preventScroll: true });
  showPane();
  return groups;
}

/** Expands the group of `workspaceId` and activates its most recent terminal the filter shows; false if it has none. */
function enterWorkspace(workspaceId, focus = true) {
  const target = mostRecentTerminal(shownTerminals().filter((info) => info.workspaceId === workspaceId), activations);
  if (!target) return false;
  activateTerminal(target.id, focus);
  return true;
}

/** Header click: a collapsed group expands on its most recent terminal; an expanded one collapses. */
function toggleGroup(workspaceId) {
  if (collapsedGroups.has(workspaceId)) {
    if (enterWorkspace(workspaceId)) return;
    // Only sleeping agents: expanding shows their entry.
    collapsedGroups.delete(workspaceId);
    saveCollapsed();
    return applyLayout();
  }
  collapsedGroups.add(workspaceId);
  saveCollapsed();
  applyLayout();
}

/** Refits every visible terminal, e.g. after a side panel opened or closed. */
export function refitAll() {
  requestAnimationFrame(() => terminals.forEach(refit));
}

/** The size a new terminal starts with: the active one's, else 120×32. */
export function newTerminalSize() {
  const probe = terminals.get(activeId);
  return probe ? { cols: probe.term.cols, rows: probe.term.rows } : { cols: 120, rows: 32 };
}

/** Shows terminals the server just opened (TerminalInfo list) and activates the last one. */
export function showOpenedTerminals(infos) {
  infos = infos.filter(showsAsTab);
  if (!infos.length) return;
  for (const info of infos) if (!terminals.has(info.id)) mountTerminal(info);
  applyLayout();
  activateTerminal(infos.at(-1).id);
  emit('terminals', terminalList());
}

/**
 * Starts a terminal in `folder` ({ ws, rel }) and shows it. `kind` 'agent' runs
 * gentle-shell, 'shell' runs bash, 'git' runs lazygit. `agent`, for kind 'agent', is the id of the
 * offered agent chosen to run there instead; without one, the
 * configured agent. Resolves to its TerminalInfo, or null if it failed.
 */
export async function openTerminal(folder, kind, agent = null) {
  try {
    const info = await api('POST', '/api/terminals', terminalBody(folder, kind, newTerminalSize(), agent));
    showOpenedTerminals([info]);
    return info;
  } catch (error) {
    showAlert(t('term.openFailed', { error: errorText(error) }));
    return null;
  }
}

export async function closeTerminal(id) {
  const record = terminals.get(id);
  if (!record) return;
  if (
    record.info.status === 'running' &&
    !(await confirmDialog({
      title: t('term.confirmCloseTitle'),
      message: t('term.confirmClose', { title: record.info.title }),
      confirmLabel: t('term.closeConfirm'),
      cancelLabel: t('common.cancel'),
      danger: true,
    }))
  ) return;
  try {
    await api('DELETE', `/api/terminals/${id}`);
  } catch (error) {
    if (error.status !== 404) return showAlert(errorText(error));
  }
  terminals.delete(id);
  activations.delete(id);
  record.ws?.close();
  record.term.dispose();
  record.tab.remove();
  record.pane.remove();
  applyLayout();
  // Next: the most recent terminal of the same workspace, else of an expanded group, else any, among those the filter shows.
  const rest = shownTerminals();
  const same = rest.filter((info) => info.workspaceId === record.info.workspaceId);
  const expanded = rest.filter((info) => !collapsedGroups.has(info.workspaceId));
  const next = mostRecentTerminal(same.length ? same : expanded.length ? expanded : rest, activations);
  if (next) activateTerminal(next.id);
  emit('terminals', terminalList());
}

function applyText() {
  $('#empty-hint').replaceChildren(...richText(emptyHintKey(state.config), { agent: el('kbd', {}, agentLabel(state.config)), shell: el('kbd', {}, 'bash') }));
  terminals.forEach(updateStatus);
  renderGroups();
}

/** Wires the layout switch and reattaches the terminals the server is already running. */
export async function initTerminals() {
  applyText();
  on('language', applyText);
  // The inbox items: each agent's state on its tab and pane, read as the sidebar reads them.
  on('inbox', (items) => {
    inboxByTerminal = new Map((Array.isArray(items) ? items : []).map((item) => [item.terminalId, item]));
    terminals.forEach(paintState);
    // The states changed: the filter may now hide or show terminals.
    if (stateFilter.length) applyLayout();
  });
  on('theme', () => {
    const theme = xtermTheme();
    terminals.forEach((record) => { record.term.options.theme = theme; });
  });
  on('workspaces', () => {
    terminals.forEach(updateStatus);
    applyLayout(); // Names and sidebar order of the groups.
  });
  // Entering a workspace from the sidebar shows its most recent terminal; the tree keeps the keyboard.
  on('selection', (selection) => {
    if (selection?.rel === '') enterWorkspace(selection.ws, false);
  });
  document.querySelectorAll('button[data-layout]').forEach((button) =>
    button.addEventListener('click', () => {
      layout = button.dataset.layout;
      prefs.write('layout', layout);
      applyLayout();
      // Refit and focus the active terminal. The grid keeps a group the user collapsed;
      // tabs reopen it, since they show its pane (activateTerminal expands it).
      const activeWorkspaceId = terminals.get(activeId)?.info.workspaceId;
      if (activeId && (!collapsedGroups.has(activeWorkspaceId) || reopensActiveGroup(layout, activeWorkspaceId, collapsedGroups))) activateTerminal(activeId);
    }),
  );
  $('#filter-empty-all').addEventListener('click', () => showAllStates?.());
  document.addEventListener('keydown', moveByKeyboard, true);
  window.addEventListener('focus', retakeSizes);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && retakeSizes());
  watchPanesWidth();
  applyLayout();
  // The agents first, so a restored tab shows its agent at once; a failed read leaves the configured
  // agent's rose (tabAgent).
  const agents = await api('GET', '/api/agents').catch(() => null);
  offeredAgents = Array.isArray(agents?.agents) ? agents.agents : [];
  // A git terminal lives in the floating panel of the window that opened it, never as a tab.
  for (const info of await api('GET', '/api/terminals')) if (showsAsTab(info)) mountTerminal(info);
  // Start on the first terminal of the first expanded group; remembered collapsed groups stay collapsed.
  // With a saved filter none is activated: showPane already shows the first one it keeps, unseen.
  applyLayout();
  const first = groupTerminals(shownTerminals(), state.workspaces, terminalOrder).find((group) => !collapsedGroups.has(group.workspaceId))?.terminals[0];
  if (first && !stateFilter.length) activateTerminal(first.id);
  emit('terminals', terminalList());
}
