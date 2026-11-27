// Global tracking view: a top-bar switch "Development | Tracking". Tracking hides
// the development layout (its terminals keep running) and shows, read-only, a view that
// fills the window without a page scroll:
// - a strip with today's counts and the autopilot (public/features/night.js: switch,
//   the jornada's Claude calls, "Before bed" and the shift settings in dialogs);
// - four lanes by what each thing needs from the user: "Needs you" (agents waiting for an
//   answer, what the night shift left for them), "To review" (finished agents, results
//   Mirador resolved), "Working" (only the agents running now, and the bash count) and
//   night.js's "What Mirador did"; a card shows its workspace › folder as a chip;
// - a collapsible dock with the three charts, the Engram projects active today, the
//   closed agents and the projects with no agent in Mirador, and the memory health
//   (read when asked, GET /api/memory/health, never polled). A project outside Mirador
//   offers "Traer a Mirador" (GET /api/activity/adopt, adopt-model.js): it opens the
//   Delegate dialog of workspaces.js on its folder, prefilled with its Next Steps.
// Each lane and dock pane is a persistent, labelled, focusable region with its own
// scroll; polling only replaces what is inside. While it shows, the development-only
// top-bar controls (Tabs/Grid, Daily summary) are hidden. Data shaping lives in
// tracking-model.js and charts-model.js; this module fetches, renders and polls while
// visible, every trackingRefreshMs of the resource profile (GET /api/profile, read once
// and again when the night settings switch profile; 15 s until it answers).
// RAM and CPU come from resources.js, which polls
// on its own: the strip's free memory, a usage line per agent card and the dock's "Usage"
// pane, updated in place on each `resources` event.
import { $, api, el, errorText, getLanguage, on, prefs, slot, state, t, workspaceById } from '/core.js';
import { plural } from '/i18n.js';
import { icon } from '/icons.js';
import { activateTerminal, refitAll, terminalList } from '/terminals.js';
import { REASONS } from '/features/inbox.js';
import { nightRuleKey, nightView } from '/i18n/inbox.js';
import { buildTracking, dockGroups, placeChip, trackingLanes } from '/features/tracking-model.js';
import { adoptActivity, adoptInstruction } from '/features/adopt-model.js';
import { delegate } from '/features/workspaces.js';
import { agentStateShares, hourColumns, projectBars } from '/charts-model.js';
import { barChart, columnChart, stackedBar } from '/charts.js';
import { healthSections } from '/memory-health-model.js';
import { showsExtra } from '/mode-model.js';
import { fillMemoryItem, refreshUsageLines, renderUsagePane, usageLine } from '/features/resources.js';
// Night
import { nightParts, nightPending, refreshNight } from '/features/night.js';
import { forgetSleeping, sleepingAgents, wakeAllSleeping, wakeSleeping } from '/features/sleeping.js';
import { DEFAULT_REFRESH_MS, pendingTitle, refreshMs } from '/features/night-model.js';

const VIEWS = ['development', 'tracking'];
let pollMs = DEFAULT_REFRESH_MS;

const saved = prefs.read('view', null);
let view = VIEWS.includes(saved) ? saved : 'development';
let host;
let switcher;
// The persistent skeleton (strip, lanes, dock), built on the first render.
let frame = null;
let dockOpen = prefs.read('trackingDock', true) !== false;
let timer = null;
let loading = false;
let data = { terminals: null, items: null, nightNotes: [], activity: null, hours: null, truncated: false, agentsError: null, projectsError: null, at: null };
// The memory health card: built once, its body re-rendered on load and on language change.
let healthBody = null;
let health = { report: null, error: null, loading: false, at: null, request: 0 };
// "Traer a Mirador": per outside project, GET /api/activity/adopt's answer and when it was read.
const adoptions = new Map();
const ADOPT_REFRESH_MS = 5 * 60_000;
// Plain mode has no Engram (public/mode-model.js): today's activity is empty and never read.
const NO_ACTIVITY = { projects: [], hours: [], truncated: false };

const clock = (iso) => new Date(iso).toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit', timeZone: state.config.timeZone });
/** Engram stores UTC times as "YYYY-MM-DD HH:MM:SS[.fraction]" without a zone. */
const engramClock = (value) => {
  const [day, time = '00:00:00'] = String(value).split(/[ T]/);
  return clock(`${day}T${time.split('.')[0]}Z`);
};
const count = (key, n) => plural(getLanguage(), key, n);
const list = (items) => new Intl.ListFormat(getLanguage(), { type: 'conjunction' }).format(items);

function duration(minutes) {
  if (minutes < 1) return t('tracking.duration.now');
  if (minutes < 60) return t('tracking.duration.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? t('tracking.duration.hoursMinutes', { hours, minutes: minutes % 60 }) : t('tracking.duration.hours', { hours });
}

function today() {
  const date = new Date(`${state.config.today}T12:00:00`);
  return date.toLocaleDateString(getLanguage(), { weekday: 'long', day: 'numeric', month: 'long' });
}

/* ---------- Data ---------- */

/** Reads terminals, inbox and today's activity; a failing source keeps its last answer. */
async function refresh() {
  if (loading) return;
  loading = true;
  if (showsExtra(state.config, 'night')) refreshNight();
  const [terminals, inbox, activity] = await Promise.allSettled([
    api('GET', '/api/terminals'),
    api('GET', '/api/inbox'),
    showsExtra(state.config, 'memory') ? api('GET', `/api/activity?date=${encodeURIComponent(state.config.today)}`) : NO_ACTIVITY,
  ]);
  loading = false;
  if (terminals.status === 'fulfilled' && inbox.status === 'fulfilled') {
    data.terminals = terminals.value;
    data.items = inbox.value.items;
    // Terminals with a night state and no waiting card: their own cards in the lanes.
    data.nightNotes = inbox.value.nightNotes ?? [];
    data.agentsError = null;
  } else {
    data.agentsError = errorText(terminals.reason ?? inbox.reason);
  }
  if (activity.status === 'fulfilled') {
    data.activity = activity.value.projects;
    // An older server answers without `hours`: the hour chart says it has no data.
    data.hours = Array.isArray(activity.value.hours) ? activity.value.hours : null;
    data.truncated = activity.value.truncated;
    data.projectsError = null;
  } else {
    data.projectsError = errorText(activity.reason);
  }
  data.at = new Date().toISOString();
  if (view === 'tracking') render();
}

function startPolling() {
  if (timer || view !== 'tracking' || document.visibilityState !== 'visible') return;
  refresh();
  timer = setInterval(refresh, pollMs);
}

/** Follows the profile's refresh interval; a running poll restarts on the new one. */
function applyProfile(profile) {
  const next = refreshMs(profile);
  if (next === pollMs) return;
  pollMs = next;
  if (!timer) return;
  clearInterval(timer);
  timer = setInterval(refresh, pollMs);
}

/** GET /api/profile once at start; an older server without it keeps the default. */
async function loadRefresh() {
  try {
    applyProfile(await api('GET', '/api/profile'));
  } catch {
    // Keeps 15 s.
  }
}

function stopPolling() {
  clearInterval(timer);
  timer = null;
}

/* ---------- View switch ---------- */

function setView(next) {
  if (!VIEWS.includes(next) || next === view) return;
  view = next;
  prefs.write('view', view);
  apply();
}

/**
 * Top-bar parts that only belong to Development: the settings sheet's Tabs/Grid row and the
 * free-memory figure (the strip shows it here), marked data-development-only.
 */
function developmentControls() {
  return [...document.querySelectorAll('.topbar [data-development-only]')];
}

function apply() {
  const tracking = view === 'tracking';
  $('#layout').hidden = tracking;
  // Only `hidden` changes: their pressed state stays as Development left it.
  for (const control of developmentControls()) control.hidden = tracking;
  host.hidden = !tracking;
  switcher.querySelectorAll('button[data-view]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
  if (tracking) {
    render();
    startPolling();
  } else {
    stopPolling();
    refitAll();
  }
}

function renderSwitch() {
  switcher.setAttribute('aria-label', t('tracking.switch.label'));
  switcher.replaceChildren(
    ...VIEWS.map((name) =>
      el('button', { type: 'button', class: 'btn', 'data-view': name, 'aria-pressed': String(name === view), onclick: () => setView(name) }, t(`tracking.switch.${name}`)),
    ),
  );
}

/** Leaves Tracking for Development and shows that agent's terminal. */
function jump(id) {
  setView('development');
  activateTerminal(id);
}

/* ---------- Rendering ---------- */

const notice = (text, className = 'muted') => el('p', { class: className }, text);
const workspaceName = (id) => (id === null ? t('night.place.unknown') : workspaceById(id)?.name ?? id);

/** A labelled, focusable scroll region that survives every render: only its children change. */
const region = (id) => el('div', { class: 'tracking-scroll', id, tabindex: '0', role: 'region' });

function labelRegion(node, title) {
  node.setAttribute('aria-label', t('tracking.lane.region', { lane: title }));
}

/** The chip that stands for the workspace › folder tree; the whole path is its tooltip. */
const chip = (place) => el('span', { class: 'tracking-chip', title: place.full }, place.chip);

function cardHead(place, when, whenTitle, tone) {
  return el('span', { class: 'tracking-card-head' }, chip(place), when ? el('span', { class: `tracking-since${tone ? ` ${tone}` : ''}`, title: whenTitle }, when) : null);
}

function nightLine(night) {
  const view = nightView(night, t);
  if (!view) return null;
  return el('span', { class: `inbox-night ${view.state}`, title: view.title || view.line }, el('span', { class: 'inbox-night-badge' }, icon(view.icon), view.badge), el('span', { class: 'inbox-night-line' }, view.line));
}

/** A card that jumps to its terminal when this window has it, or a dashed note when another window does. */
function jumpCard(terminalId, focusKey, here, content, extra = '') {
  return here
    ? el('button', { type: 'button', class: `tracking-card${extra}`, 'data-focus': focusKey, title: t('tracking.jump'), onclick: () => jump(terminalId) }, ...content)
    : el('div', { class: `tracking-card still elsewhere${extra}` }, ...content, el('span', { class: 'tracking-note' }, t('inbox.elsewhere')));
}

function agentCard(agent, here) {
  // An agent stopped with an error waits for the user like a blocked one: its reason ("Stopped with an error") and the warn tone.
  const waits = agent.state === 'waiting' || agent.state === 'error';
  const reason = waits && agent.label ? (REASONS[agent.label] ? t(REASONS[agent.label]) : agent.label) : null;
  const since =
    agent.state === 'exited'
      ? [agent.exitCode === null ? null : t('tracking.exitCode', { code: agent.exitCode }), null]
      : [duration(agent.minutes), `${t(`tracking.since.${agent.state}`, { time: duration(agent.minutes) })} · ${t('tracking.at', { time: clock(agent.since) })}`];
  return jumpCard(agent.id, `agent:${agent.id}`, here, [
    cardHead(agent.place, since[0], since[1], waits ? 'warn' : null),
    // Next to its state: why idle sleep keeps it awake ("Awake: npm is still running"), the program's name only.
    agent.awake ? el('span', { class: 'tracking-awake' }, t('tracking.awake', { name: agent.awake })) : null,
    el('span', { class: 'tracking-title', title: agent.title }, agent.title),
    usageLine(agent.id),
    reason ? el('span', { class: 'tracking-reason' }, reason) : null,
    agent.detail ? el('span', { class: 'tracking-detail', title: agent.detail }, agent.detail) : null,
    nightLine(agent.night),
    agent.activity ? el('span', { class: 'tracking-activity', title: agent.activity }, agent.activity) : null,
  ], agent.state === 'exited' ? ' dashed' : '');
}

/** What the night shift left for the user (GET /api/night → pending). */
function pendingCard(item, here) {
  const { key, vars } = nightRuleKey(item.rule);
  const title = pendingTitle(item, t);
  return el(
    'div',
    { class: 'tracking-card still' },
    cardHead(item.place, clock(item.time), t('tracking.at', { time: clock(item.time) })),
    el('span', { class: 'tracking-title', title }, title),
    el(
      'span',
      { class: 'inbox-night deferred wrap', title: item.reason || undefined },
      el('span', { class: 'inbox-night-badge' }, t(item.kind === 'question' ? 'night.type.question' : 'night.type.followUp')),
      el('span', { class: 'tracking-wrap' }, t('night.pending.reason', { reason: t(key, vars) }), item.rule ? el('code', { title: t('night.rule') }, item.rule) : null),
    ),
    here
      ? el('span', { class: 'tracking-card-actions' }, el('button', { type: 'button', class: 'btn', 'data-focus': `pending:${item.id}`, onclick: () => jump(item.terminalId) }, t('night.pending.jump')))
      : el('span', { class: 'tracking-note' }, t('night.pending.closed')),
  );
}

/** A terminal with a night state and no waiting card: left for the user, or resolved and not seen yet. */
function noteCard(note, here) {
  const at = note.night?.at ?? note.since;
  return jumpCard(note.terminalId, `note:${note.terminalId}`, here, [
    cardHead(note.place, clock(at), t('tracking.at', { time: clock(at) })),
    el('span', { class: 'tracking-title', title: note.title }, note.title),
    nightLine(note.night),
  ], note.night?.state === 'resolved' ? ' dashed' : '');
}

/** A sleeping agent: no process until woken; Despertar continues its saved session, Olvidar drops it. */
function sleepingCard(card) {
  return el(
    'div',
    { class: 'tracking-card still dashed sleeping' },
    cardHead(card.place, t('sleeping.state'), t('sleeping.why')),
    el('span', { class: 'tracking-note' }, card.resumable ? t('sleeping.why') : t('sleeping.fresh')),
    el(
      'span',
      { class: 'tracking-card-actions' },
      el('button', { type: 'button', class: 'btn', 'data-focus': `sleep-wake:${card.id}`, title: t('sleeping.wakeTitle'), onclick: () => wakeSleeping(card.id) }, t('sleeping.wake')),
      el('button', { type: 'button', class: 'btn', 'data-focus': `sleep-forget:${card.id}`, title: t('sleeping.forgetTitle'), onclick: () => forgetSleeping(card) }, t('sleeping.forget')),
    ),
  );
}

/* ---------- Traer a Mirador ---------- */

const adoptUrl = (project) => `/api/activity/adopt?project=${encodeURIComponent(project)}`;

/** Where an outside project would open, read once and again every ADOPT_REFRESH_MS; undefined until read. */
function adoptInfo(project) {
  const entry = adoptions.get(project);
  if (!entry || (!entry.loading && Date.now() - entry.at > ADOPT_REFRESH_MS)) {
    adoptions.set(project, { ...entry, loading: true });
    api('GET', adoptUrl(project)).then(
      (info) => {
        adoptions.set(project, { info, at: Date.now() });
        render();
      },
      // Asked again at the next poll's render.
      () => adoptions.delete(project),
    );
  }
  return entry?.info;
}

/** Reads the folder and Next Steps afresh, then opens the Delegate dialog on that folder. */
async function adopt(project, button) {
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  let info = null;
  try {
    info = await api('GET', adoptUrl(project.project));
    adoptions.set(project.project, { info, at: Date.now() });
  } catch (error) {
    adoptions.set(project.project, { ...adoptions.get(project.project), failed: errorText(error) });
  } finally {
    button.removeAttribute('aria-busy');
    button.disabled = false;
  }
  if (!info || info.reason) return render();
  await delegate(info.ws, [info.rel], { instruction: adoptInstruction(info.nextSteps, t('tracking.adopt.lead')) });
  refresh();
}

let adoptNoteId = 0;

/** The card's "Traer a Mirador" button, disabled while the project looks active, or why it cannot be adopted. */
function adoptParts(project) {
  const info = adoptInfo(project.project);
  if (!info) return [];
  if (info.reason) return [el('span', { class: 'tracking-note adopt-reason' }, t(`tracking.adopt.reason.${info.reason}`))];
  const { recent, minutes } = adoptActivity(project.lastAt, Date.now());
  const failed = adoptions.get(project.project)?.failed;
  const noteId = `adopt-note-${++adoptNoteId}`;
  const button = el(
    'button',
    {
      type: 'button',
      class: 'btn',
      'data-focus': `adopt:${project.project}`,
      'data-launch-block': 'adopt',
      disabled: recent,
      'aria-describedby': recent ? noteId : null,
      title: t('tracking.adopt.title', { place: placeChip(info.workspace, info.rel).full }),
      onclick: () => adopt(project, button),
    },
    t('tracking.adopt.button'),
  );
  return [
    recent ? el('span', { class: 'tracking-note adopt-recent', id: noteId }, t('tracking.adopt.recent', { minutes })) : null,
    failed ? el('span', { class: 'tracking-error', role: 'alert' }, t('tracking.adopt.failed', { error: failed })) : null,
    el('span', { class: 'tracking-card-actions' }, button),
  ];
}

/** An Engram project active today with no agent in Mirador: seen only through its memories. */
function projectCard(project) {
  return el(
    'div',
    { class: 'tracking-card still dashed' },
    cardHead({ chip: project.project, full: project.project }, engramClock(project.lastAt), t('tracking.projects.last', { time: engramClock(project.lastAt) })),
    el('span', { class: 'tracking-note' }, count('tracking.projects.memories', project.count)),
    ...adoptParts(project),
  );
}

function cardFor(card, here) {
  if (card.type === 'agent') return agentCard(card, here.has(card.id));
  if (card.type === 'pending') return pendingCard(card, here.has(card.terminalId));
  if (card.type === 'note') return noteCard(card, here.has(card.terminalId));
  if (card.type === 'sleeping') return sleepingCard(card);
  return projectCard(card);
}

/** Groups that are the lane's whole point need no sub-heading. */
const UNTITLED_GROUPS = new Set(['working']);

function laneContent(lane, empty) {
  if (data.terminals === null) return [notice(t(data.agentsError ? 'tracking.charts.noData' : 'tracking.loading'))];
  const here = new Set(terminalList().map((info) => info.id));
  const body = [];
  for (const group of lane.groups) {
    if (!UNTITLED_GROUPS.has(group.key)) body.push(el('h3', { class: 'tracking-sub' }, t(`tracking.group.${group.key}`)));
    if (group.key === 'sleeping') {
      body.push(el(
        'div',
        { class: 'tracking-sleep-head' },
        el('p', { class: 'tracking-note' }, t('sleeping.whyMany')),
        el('button', { type: 'button', class: 'btn', 'data-focus': 'sleep-wake-all', title: t('sleeping.wakeAllTitle'), onclick: () => wakeAllSleeping() }, t('sleeping.wakeAll')),
      ));
    }
    body.push(el('ul', { class: 'tracking-cards' }, ...group.cards.map((card) => el('li', {}, cardFor(card, here)))));
    if (group.key === 'outside') body.push(el('p', { class: 'tracking-note' }, t('tracking.note')));
  }
  if (!body.length) body.push(el('p', { class: 'tracking-empty' }, t(empty)));
  if (lane.shells) body.push(el('p', { class: 'tracking-note' }, count('tracking.shells', lane.shells)));
  return body;
}

const LANES = [
  { key: 'needs', icon: 'wait', empty: 'tracking.lane.needs.empty' },
  { key: 'review', icon: 'check', empty: 'tracking.lane.review.empty' },
  { key: 'working', icon: 'work', empty: 'tracking.agents.empty' },
];

function renderLane(shell, lane) {
  const title = t(`tracking.lane.${shell.key}`);
  const glyph = icon(shell.icon);
  glyph.classList.add('tracking-lane-glyph');
  shell.head.replaceChildren(
    glyph,
    el('h2', { id: `tracking-lane-${shell.key}` }, title),
    // No count until the agents are read.
    ...(data.terminals === null ? [] : [el('span', { class: `tracking-count ${shell.key}` }, String(lane.count))]),
  );
  labelRegion(shell.body, title);
  shell.body.replaceChildren(...laneContent(lane, shell.empty));
}

function renderStrip(lanes) {
  frame.title.replaceChildren(
    el('h1', {}, t('tracking.title')),
    el('p', { class: 'muted tracking-small' }, today(), data.at ? ` · ${t('tracking.updated', { time: clock(data.at) })}` : ''),
  );
  frame.counts.setAttribute('aria-label', t('tracking.strip.summary'));
  frame.counts.replaceChildren(
    el('li', {}, el('strong', {}, String(lanes.strip.projects)), ` ${count('tracking.stat.projects', lanes.strip.projects)}`),
    el('li', {}, el('strong', {}, String(lanes.strip.running)), ` ${count('tracking.stat.running', lanes.strip.running)}`),
    frame.memory,
  );
  fillMemoryItem(frame.memory);
  // replaceChildren would print a null as text.
  frame.notices.replaceChildren(
    ...[
      data.agentsError ? el('p', { class: 'tracking-error', role: 'alert' }, t('tracking.failed.agents', { error: data.agentsError })) : null,
      data.projectsError ? el('p', { class: 'tracking-error', role: 'alert' }, t('tracking.failed.projects', { error: data.projectsError })) : null,
    ].filter(Boolean),
  );
}

/* ---------- Dock: charts, projects active today, memory health ---------- */

function setDock(open) {
  dockOpen = open;
  prefs.write('trackingDock', open);
  renderDockHead();
}

function renderDockHead() {
  frame.root.classList.toggle('dock-closed', !dockOpen);
  frame.panes.hidden = !dockOpen;
  frame.dockHead.replaceChildren(
    el('h2', { id: 'tracking-dock-title' }, t('tracking.dock')),
    el(
      'button',
      { type: 'button', class: 'btn', 'aria-expanded': String(dockOpen), 'aria-controls': 'tracking-dock-panes', 'data-focus': 'dock-toggle', onclick: () => setDock(!dockOpen) },
      t(dockOpen ? 'tracking.dock.collapse' : 'tracking.dock.expand'),
    ),
  );
}

/** A dock pane: its heading (re-rendered) over a persistent scroll region. */
function pane(id) {
  const head = el('h3', { id: `${id}-title` });
  const body = region(id);
  return { head, body, section: el('section', { class: 'tracking-pane', 'aria-labelledby': `${id}-title` }, head, body) };
}

function projectsList(model) {
  const body = [];
  if (data.activity === null) {
    if (!data.projectsError) body.push(notice(t('tracking.loading')));
  } else if (!model.projects.length) {
    body.push(el('p', { class: 'tracking-empty' }, t('tracking.projects.empty')));
  } else {
    body.push(
      el(
        'ul',
        { class: 'tracking-projects' },
        ...model.projects.map((project) =>
          el(
            'li',
            {},
            el(
              'div',
              { class: 'tracking-project-head' },
              el('strong', {}, project.project),
              project.withAgent ? el('span', { class: 'tracking-badge' }, t('tracking.projects.withAgent')) : null,
              el('span', { class: 'tracking-when' }, `${count('tracking.projects.memories', project.count)} · ${t('tracking.projects.last', { time: engramClock(project.lastAt) })}`),
            ),
            el('ul', { class: 'tracking-titles' }, ...project.titles.map((title) => el('li', { title }, title))),
          ),
        ),
      ),
    );
    if (data.truncated) body.push(el('p', { class: 'muted tracking-small' }, t('tracking.projects.truncated')));
  }
  return body;
}

/** A chart block: its title, then the chart, a loading or empty notice. */
function chartCard(id, title, body) {
  return el('section', { class: 'tracking-chart', 'aria-labelledby': id }, el('h4', { id }, title), body);
}

function statesChart(model) {
  const title = t('tracking.charts.states');
  if (data.terminals === null) return chartCard('tracking-chart-states', title, notice(t(data.agentsError ? 'tracking.charts.noData' : 'tracking.loading')));
  // The bar has no error slice (charts-model.js AGENT_STATES): an agent stopped with an error counts with the waiting ones.
  const shares = agentStateShares({ ...model.summary, waiting: model.summary.waiting + model.summary.error });
  if (!shares.total) return chartCard('tracking-chart-states', title, notice(t('tracking.charts.states.empty'), 'tracking-empty'));
  const slices = shares.slices.map((slice) => ({
    key: slice.state,
    share: slice.share,
    offset: slice.offset,
    legend: t('tracking.charts.states.item', { state: t(`tracking.state.${slice.state}`), count: slice.count, percent: slice.percent }),
  }));
  return chartCard('tracking-chart-states', title, stackedBar({ label: t('tracking.charts.states.label', { list: list(slices.map((slice) => slice.legend)) }), slices }));
}

function projectsChart(model) {
  const title = t('tracking.charts.projects');
  if (data.activity === null) return chartCard('tracking-chart-projects', title, notice(t(data.projectsError ? 'tracking.charts.noData' : 'tracking.loading')));
  const bars = projectBars(model.projects);
  if (!bars.total) return chartCard('tracking-chart-projects', title, notice(t('tracking.projects.empty'), 'tracking-empty'));
  const rows = bars.bars.map((bar) => ({ name: bar.project, share: bar.share, value: bar.count }));
  if (bars.others) rows.push({ name: count('tracking.charts.others', bars.others.projects), share: bars.others.share, value: bars.others.count, muted: true });
  const label = t('tracking.charts.projects.label', { list: list(rows.map((row) => t('tracking.charts.projects.item', { project: row.name, count: row.value }))) });
  return chartCard('tracking-chart-projects', title, barChart({ label, rows }));
}

const hourText = (hour) => `${String(hour).padStart(2, '0')}:00`;

function hoursChart() {
  const title = t('tracking.charts.hours');
  if (data.activity === null) return chartCard('tracking-chart-hours', title, notice(t(data.projectsError ? 'tracking.charts.noData' : 'tracking.loading')));
  if (data.hours === null) return chartCard('tracking-chart-hours', title, notice(t('tracking.charts.noData')));
  const hours = hourColumns(data.hours);
  if (!hours.total) return chartCard('tracking-chart-hours', title, notice(t('tracking.projects.empty'), 'tracking-empty'));
  const peaks = new Set(hours.peaks);
  const columns = hours.columns.map((column) => ({
    share: column.share,
    peak: peaks.has(column.hour),
    title: t('tracking.charts.hours.item', { time: hourText(column.hour), count: column.count }),
  }));
  const label = t('tracking.charts.hours.label', {
    total: count('tracking.projects.memories', hours.total),
    peaks: list(hours.peaks.map(hourText)),
    count: hours.max,
  });
  const ticks = [0, 6, 12, 18, 23].map((hour) => ({ index: hour, text: String(hour).padStart(2, '0') }));
  return chartCard('tracking-chart-hours', title, [columnChart({ label, columns, ticks }), el('p', { class: 'muted tracking-small', 'aria-hidden': 'true' }, label)]);
}

function renderDock(model) {
  renderDockHead();
  const { charts, projects, offLane } = frame;
  charts.head.textContent = t('tracking.dock.charts');
  labelRegion(charts.body, t('tracking.dock.charts'));
  // The hours and projects charts count memories: plain mode keeps only the agents' states.
  charts.body.replaceChildren(...(showsExtra(state.config, 'memory') ? [hoursChart(), statesChart(model), projectsChart(model)] : [statesChart(model)]));
  projects.head.replaceChildren(t('tracking.projects'), data.activity === null ? '' : el('span', { class: 'muted tracking-small' }, String(model.projects.length)));
  labelRegion(projects.body, t('tracking.projects'));
  projects.body.replaceChildren(...projectsList(model));
  // Closed agents and Engram-only projects: out of the lanes, which list only what runs now.
  const off = dockGroups({ model, workspaceName, sleeping: sleepingAgents() });
  offLane.head.replaceChildren(t('tracking.offLane'), data.terminals === null ? '' : el('span', { class: 'muted tracking-small' }, String(off.count)));
  labelRegion(offLane.body, t('tracking.offLane'));
  offLane.body.replaceChildren(...laneContent(off, 'tracking.offLane.empty'));
  renderUsage();
}

/** The dock's "Usage" pane: heaviest agents, the server and the gentle-shells outside Mirador (resources.js). */
function renderUsage() {
  const { usage } = frame;
  usage.head.replaceChildren(t('resources.pane'), el('span', { class: 'muted tracking-small' }, t('resources.pane.hint')));
  labelRegion(usage.body, t('resources.pane'));
  const here = new Set(terminalList().map((info) => info.id));
  renderUsagePane(usage.body, {
    describe: (id) => {
      const info = data.terminals?.find((terminal) => terminal.id === id);
      return info ? { title: info.title, chip: placeChip(workspaceName(info.workspaceId), info.rel).chip, here: here.has(id) } : null;
    },
    pick: (id) => here.has(id) && jump(id),
  });
}

/** A new resources answer: only the figures change, in place. */
function showResources() {
  if (view !== 'tracking' || !frame) return;
  fillMemoryItem(frame.memory);
  refreshUsageLines(host);
  renderUsage();
}

/* ---------- Memory health (read-only, read when asked) ---------- */

/** Reads the report once per click: "Check now" the first time, or "Check again". */
async function loadHealth({ focusRetry = false } = {}) {
  const request = ++health.request;
  health.loading = true;
  health.error = null;
  renderHealth();
  try {
    const report = await api('GET', '/api/memory/health');
    if (request !== health.request) return;
    health.report = report;
    health.at = new Date().toISOString();
  } catch (error) {
    if (request !== health.request) return;
    health.error = error.status === 503 ? t('error.engramDown') : errorText(error);
  } finally {
    if (request === health.request) {
      health.loading = false;
      renderHealth();
      if (focusRetry) healthBody?.querySelector('.tracking-health-retry')?.focus();
    }
  }
}

const retryButton = () =>
  el('button', { type: 'button', class: 'btn tracking-health-retry', onclick: () => loadHealth({ focusRetry: true }) }, t(health.report || health.error ? 'tracking.health.retry' : 'tracking.health.check'));

const directories = (dirs) =>
  dirs.length ? el('span', { class: 'tracking-health-dirs', title: dirs.join('\n') }, dirs.join(', ')) : el('span', { class: 'muted' }, t('tracking.health.noDirectories'));

const engramDay = (value) => String(value).slice(0, 10);

/** One listed entry of a finding: titles, names and folders only, never memory content. */
function findingItem(id, item) {
  switch (id) {
    case 'suspicious':
      return el(
        'li',
        {},
        el('div', { class: 'tracking-project-head' }, el('strong', {}, item.name), el('span', { class: 'tracking-when' }, count('tracking.projects.memories', item.observations))),
        el('span', {}, t(`tracking.health.reason.${item.reason}`)),
        directories(item.directories),
      );
    case 'unmatched':
      return el(
        'li',
        {},
        el('div', { class: 'tracking-project-head' }, el('strong', {}, item.name), el('span', { class: 'tracking-when' }, count('tracking.projects.memories', item.observations))),
        directories(item.directories),
      );
    case 'untitled':
      return el(
        'li',
        {},
        el(
          'div',
          { class: 'tracking-project-head' },
          el('strong', {}, item.project),
          el('em', { class: 'muted tracking-health-title' }, item.fallbackTitle ?? t('tracking.health.noText')),
          el('span', { class: 'tracking-when' }, engramDay(item.at)),
        ),
      );
    case 'duplicates':
      return el(
        'li',
        {},
        el(
          'div',
          { class: 'tracking-project-head' },
          el('strong', {}, item.project),
          el('span', { class: 'tracking-health-title' }, item.title),
          el('span', { class: 'tracking-when' }, t('tracking.health.copies', { count: item.copies })),
        ),
      );
    default:
      return null;
  }
}

function findingView(section) {
  const key = `tracking.health.${section.id}`;
  const parts = [el('h3', {}, t('tracking.health.findingTitle', { title: t(`${key}.title`), count: section.count }))];
  if (!section.count) {
    parts.push(el('p', { class: 'tracking-health-ok' }, t('tracking.health.none')));
  } else {
    parts.push(el('p', {}, t(`${key}.why`)));
    if (section.id === 'duplicates') parts.push(el('p', { class: 'muted tracking-small' }, t('tracking.health.duplicates.rule')));
    parts.push(el('p', { class: 'tracking-health-fix' }, el('strong', {}, t('tracking.health.fixLabel')), ' ', t(`${key}.fix`)));
    if (section.items.length) {
      parts.push(el('ul', { class: 'tracking-projects tracking-health-list' }, ...section.items.map((item) => findingItem(section.id, item))));
      if (section.items.length < section.count) parts.push(el('p', { class: 'muted tracking-small' }, t('tracking.health.more', { shown: section.items.length, count: section.count })));
    }
  }
  return el('section', { class: `tracking-health-finding${section.count ? ' has-findings' : ''}`, 'data-finding': section.id }, ...parts);
}

function projectStatus(project) {
  if (project.suspicious) return t(`tracking.health.status.${project.suspicious}`);
  return t(project.matched ? 'tracking.health.status.matched' : 'tracking.health.status.unmatched');
}

function projectsTable(projects) {
  const columns = ['project', 'memories', 'untitled', 'copies', 'topicKey', 'passive', 'folder'];
  const number = (value) => el('td', { class: 'num' }, String(value));
  return el(
    'details',
    { class: 'tracking-health-projects' },
    el('summary', {}, t('tracking.health.byProject', { count: projects.length })),
    el(
      'div',
      { class: 'tracking-health-table' },
      el(
        'table',
        {},
        el('thead', {}, el('tr', {}, ...columns.map((column) => el('th', { scope: 'col', class: column === 'project' || column === 'folder' ? null : 'num' }, t(`tracking.health.col.${column}`))))),
        el(
          'tbody',
          {},
          ...projects.map((p) =>
            el('tr', {}, el('th', { scope: 'row' }, p.name), number(p.observations), number(p.untitled), number(p.duplicateCopies), number(p.withoutTopicKey), number(p.passive), el('td', {}, projectStatus(p))),
          ),
        ),
      ),
    ),
  );
}

function stat(key, n, tone) {
  return el('div', { class: `tracking-stat${tone && n ? ` ${tone}` : ''}`, role: 'listitem' }, el('strong', {}, String(n)), el('span', {}, count(key, n)));
}

function healthStats(totals) {
  const item = (key, n, tone) => stat(key, n, tone);
  return el(
    'div',
    { class: 'tracking-stats tracking-health-stats', role: 'list' },
    item('tracking.health.stat.memories', totals.observations),
    item('tracking.health.stat.projects', totals.projects),
    item('tracking.health.stat.suspicious', totals.suspicious, 'warn'),
    item('tracking.health.stat.unmatched', totals.unmatched, 'warn'),
    item('tracking.health.stat.untitled', totals.untitled, 'warn'),
    item('tracking.health.stat.copies', totals.duplicateCopies, 'warn'),
  );
}

/** Fills the dock's health pane from `health`: its heading, then the body, inside its persistent scroll region. */
function renderHealth() {
  if (!frame) return;
  const { head } = frame.health;
  head.replaceChildren(t('tracking.health.title'), el('span', { class: 'muted tracking-small' }, health.at ? t('tracking.health.checked', { time: clock(health.at) }) : t('tracking.health.hint')));
  labelRegion(healthBody, t('tracking.health.title'));
  const body = [];
  if (health.loading) body.push(el('p', { class: 'muted', role: 'status' }, t('tracking.health.loading')));
  if (health.error) body.push(el('p', { class: 'tracking-error', role: 'alert' }, t('tracking.health.failed', { error: health.error })));
  const report = health.report;
  if (report?.totals) {
    const { totals } = report;
    body.push(el('p', { class: 'muted' }, t('tracking.health.intro')), healthStats(totals));
    if (totals.windowFull) body.push(el('p', { class: 'muted tracking-small' }, t('tracking.health.windowFull', { count: totals.inWindow })));
    if (totals.foldersNotResolved) body.push(el('p', { class: 'muted tracking-small' }, t('tracking.health.notResolved', { count: totals.foldersNotResolved })));
    body.push(...healthSections(report).map(findingView));
    if (Array.isArray(report.projects) && report.projects.length) body.push(projectsTable(report.projects));
  }
  if (!health.loading) {
    body.push(
      el(
        'div',
        { class: 'tracking-health-foot' },
        retryButton(),
      ),
    );
  }
  healthBody.replaceChildren(...body);
}

/** Builds the persistent skeleton once: the polling only fills it. */
function build() {
  const lanes = LANES.map((lane) => {
    const head = el('div', { class: 'tracking-lane-head' });
    const body = region(`tracking-lane-${lane.key}-body`);
    body.classList.add('tracking-lane-body');
    return { ...lane, head, body, section: el('section', { class: `tracking-lane ${lane.key}`, 'aria-labelledby': `tracking-lane-${lane.key}` }, head, body) };
  });
  const charts = pane('tracking-charts');
  const projects = pane('tracking-projects');
  const offLane = pane('tracking-offlane');
  const healthPane = pane('tracking-health');
  const usage = pane('tracking-usage');
  healthBody = healthPane.body;
  // The night parts are built once by night.js: its forms and focus survive the polling. Plain mode
  // (public/mode-model.js) has no night parts and no memory panes.
  const night = showsExtra(state.config, 'night') ? nightParts() : {};
  const memory = showsExtra(state.config, 'memory');
  frame = {
    title: el('div', { class: 'tracking-strip-title' }),
    counts: el('ul', { class: 'tracking-counts' }),
    memory: el('li', { hidden: true }),
    notices: el('div', { class: 'tracking-notices' }),
    lanes,
    dockHead: el('div', { class: 'tracking-dock-head' }),
    panes: el('div', { class: memory ? 'tracking-dock-panes' : 'tracking-dock-panes plain', id: 'tracking-dock-panes' }, charts.section, memory ? projects.section : null, offLane.section, usage.section, memory ? healthPane.section : null),
    charts,
    projects,
    offLane,
    usage,
    health: healthPane,
  };
  frame.root = el(
    'div',
    { class: 'tracking' },
    el('div', { class: 'tracking-top' }, el('header', { class: 'tracking-strip' }, frame.title, frame.counts, night.head), frame.notices, night.banner),
    el('div', { class: 'tracking-lanes' }, ...lanes.map((lane) => lane.section), night.report),
    el('section', { class: 'tracking-dock', 'aria-labelledby': 'tracking-dock-title' }, frame.dockHead, frame.panes),
  );
  host.replaceChildren(frame.root);
  renderHealth();
}

function render() {
  if (view !== 'tracking') return;
  const model = buildTracking({
    terminals: data.terminals ?? [],
    items: data.items ?? [],
    activity: data.activity ?? [],
    workspaceOrder: state.workspaces.map((w) => w.id),
  });
  const lanes = trackingLanes({ model, items: data.items ?? [], nightNotes: data.nightNotes, pending: nightPending().pending, workspaceName });
  if (!frame) build();
  // Re-rendering on every poll must not steal the keyboard from someone walking a lane.
  const focused = host.contains(document.activeElement) ? document.activeElement.dataset?.focus : undefined;
  renderStrip(lanes);
  for (const shell of frame.lanes) renderLane(shell, lanes[shell.key]);
  renderDock(model);
  if (focused) host.querySelector(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
}

export async function init() {
  host = slot('tracking');
  switcher = el('div', { class: 'segmented tracking-switch', role: 'group' });
  slot('topbar').append(switcher);
  renderSwitch();
  on('language', () => {
    renderSwitch();
    render();
    renderHealth();
  });
  on('terminals', render);
  on('workspaces', () => {
    // A workspace added, moved or removed changes where outside projects would open.
    adoptions.clear();
    render();
  });
  // The night shift read its status: what it left for the user goes to "Needs you".
  on('night', render);
  // The sleeping agents were read again (sleeping.js).
  on('sleeping', render);
  on('resources', showResources);
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? startPolling() : stopPolling()));
  on('profile', applyProfile);
  loadRefresh();
  apply();
}
