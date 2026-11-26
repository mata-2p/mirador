// Pure data shaping for the global tracking view (public/features/tracking.js):
// terminals (GET /api/terminals), inbox items (GET /api/inbox) and today's Engram
// activity (GET /api/activity) become one model with counts and agent states, which
// trackingLanes sorts into the view's lanes by what each thing needs from the user.
// No DOM and no core.js: the browser and the tests import it.

/** How many titles each active project shows. */
const TITLES = 3;

/** The states the server reports for an agent terminal (GET /api/terminals `agentState`). */
const SERVER_STATES = new Set(['working', 'waiting', 'finished', 'error']);

/**
 * State of an agent terminal: 'exited' when its process ended, 'waiting' when the
 * inbox says it needs an answer (blocked or prompt), 'error' when its program reported
 * that it stopped with an error (an OSC 7501 error card), 'finished' when it ended its
 * turn, 'working' when it runs and the inbox says nothing.
 */
export function agentState(terminal, item) {
  if (terminal.status === 'exited') return 'exited';
  // No card: the server's own state, sent with the terminal and with the inbox stream. An agent
  // whose card left the inbox is still finished or in error, and showing it as working is what #12
  // reported. 'unknown', absent, or an older server keeps the old answer.
  if (!item) return SERVER_STATES.has(terminal.agentState) ? terminal.agentState : 'working';
  if (item.kind === 'error') return 'error';
  return item.kind === 'finished' ? 'finished' : 'waiting';
}

/** States that come with an inbox card: the entry takes its kind, label, detail and time from it. */
const CARD_STATES = new Set(['waiting', 'error', 'finished']);

/** Whole minutes from `since` (ISO) to `now` (ms); 0 for a future or unreadable date. */
export function elapsedMinutes(since, now) {
  const minutes = Math.floor((now - Date.parse(since)) / 60_000);
  return minutes > 0 ? minutes : 0;
}

/**
 * The name a folder and an Engram project are compared by: the last path segment,
 * lower-cased. Engram names a project after its folder, so `/Dev/tools/mirador`
 * and the project `mirador` count as one project.
 */
export function projectKey(pathOrName) {
  const parts = String(pathOrName ?? '').split('/').filter(Boolean);
  return (parts.at(-1) ?? '').toLowerCase();
}

/**
 * States GET /api/terminals reports (`agentState`) that the view keeps for an agent with no card:
 * a seen error or finished card leaves the inbox, but the agent is still stopped or done. The
 * view polls that list, so the value is current here; the sidebar's copy is not, and it does not use it.
 */
const KEPT_WITHOUT_CARD = new Set(['error', 'finished']);

function agentEntry(terminal, item, now) {
  const fromInbox = agentState(terminal, item);
  const state = fromInbox === 'working' && KEPT_WITHOUT_CARD.has(terminal.agentState) ? terminal.agentState : fromInbox;
  // With no card there is no kind, label or detail, and the time counts from the terminal's start.
  const live = CARD_STATES.has(state) && Boolean(item);
  const since = live ? item.since : terminal.createdAt;
  return {
    id: terminal.id,
    title: terminal.title,
    workspaceId: terminal.workspaceId,
    rel: terminal.rel,
    cwd: terminal.cwd,
    state,
    itemKind: live ? item.kind : null,
    label: (live && item.label) || null,
    detail: (live && item.detail) || null,
    activity: item?.activity || null,
    since,
    minutes: elapsedMinutes(since, now),
    exitCode: state === 'exited' ? terminal.exitCode ?? null : null,
  };
}

/**
 * Builds the tracking model.
 * - `terminals`: TerminalInfo[]; shells are only counted, agents are listed.
 * - `items`: AttentionItem[] from the inbox; items of unknown or shell terminals are ignored.
 * - `activity`: projects of GET /api/activity ({ project, count, lastAt, titles }).
 * - `workspaceOrder`: workspace ids in sidebar order; unknown ones follow, by id.
 * Returns { summary, workspaces: [{ workspaceId, folders: [{ rel, agents }] }], projects }.
 */
export function buildTracking({ terminals, items, activity, workspaceOrder = [], now = Date.now() }) {
  const itemOf = new Map(items.map((item) => [item.terminalId, item]));
  const started = new Map(terminals.map((terminal) => [terminal.id, Date.parse(terminal.createdAt) || 0]));
  const agents = terminals.filter((terminal) => terminal.kind === 'agent').map((terminal) => agentEntry(terminal, itemOf.get(terminal.id), now));

  const summary = { projects: 0, running: 0, working: 0, waiting: 0, finished: 0, error: 0, exited: 0, shells: 0 };
  summary.shells = terminals.length - agents.length;
  for (const agent of agents) {
    summary[agent.state] += 1;
    if (agent.state !== 'exited') summary.running += 1;
  }

  const advancing = new Set(agents.filter((agent) => agent.state !== 'exited').map((agent) => projectKey(agent.cwd)));
  const active = activity.filter((project) => project.count > 0);
  const projects = active.map((project) => ({
    project: project.project,
    count: project.count,
    lastAt: project.lastAt,
    titles: project.titles.slice(0, TITLES),
    withAgent: advancing.has(projectKey(project.project)),
  }));
  for (const project of active) advancing.add(projectKey(project.project));
  advancing.delete('');
  summary.projects = advancing.size;

  const byWorkspace = new Map();
  for (const agent of agents) {
    const folders = byWorkspace.get(agent.workspaceId) ?? new Map();
    byWorkspace.set(agent.workspaceId, folders);
    folders.set(agent.rel, [...(folders.get(agent.rel) ?? []), agent]);
  }
  const rank = (id) => (workspaceOrder.includes(id) ? workspaceOrder.indexOf(id) : workspaceOrder.length);
  const workspaces = [...byWorkspace]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([workspaceId, folders]) => ({
      workspaceId,
      folders: [...folders]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([rel, list]) => ({ rel, agents: list.sort((a, b) => started.get(a.id) - started.get(b.id)) })),
    }));

  return { summary, workspaces, projects };
}

/* ---------- Lanes of the Seguimiento view ---------- */

const segments = (rel) => String(rel ?? '').split('/').filter(Boolean);
/** Oldest first: the one that has waited longest leads; ties keep a stable order by id. */
const oldestFirst = (time) => (a, b) => String(time(a)).localeCompare(String(time(b))) || String(a.id ?? a.terminalId).localeCompare(String(b.id ?? b.terminalId));

/**
 * The chip a card shows instead of the workspace › folder tree: the workspace and the
 * last folder of `rel` (the workspace alone at its root); `full` keeps the whole path
 * for the tooltip.
 */
export function placeChip(workspaceName, rel) {
  const folders = segments(rel);
  return {
    chip: [workspaceName, ...folders.slice(-1)].join(' › '),
    full: [workspaceName, ...folders].join(' › '),
  };
}

const group = (key, cards) => (cards.length ? [{ key, cards }] : []);
const terminalOf = (card) => card.terminalId ?? card.id;

/** Every agent of the model as a card, with its chip and what the night shift does for it. */
function agentCards(model, place, nightOf = new Map()) {
  return model.workspaces
    .flatMap((workspace) => workspace.folders.flatMap((folder) => folder.agents))
    .map((agent) => ({ type: 'agent', ...agent, place: place(agent.workspaceId, agent.rel), night: nightOf.get(agent.id) ?? null }));
}

const placer = (workspaceName) => (workspaceId, rel) => placeChip(workspaceName(workspaceId ?? null), rel);

/**
 * Sorts everything the Seguimiento view lists into lanes by what it needs from the user.
 * - `model`: buildTracking's answer (agents, summary, projects).
 * - `items` / `nightNotes`: GET /api/inbox; a terminal's night state rides on its card.
 * - `pending`: GET /api/night → pending (null while unread counts as none).
 * - `workspaceName(id)`: the name to show for a workspace id (null for an unknown one).
 * Returns { strip: { projects, running }, needs, review, working }; each lane is
 * { count, groups: [{ key, cards }] } with empty groups left out, `working` also has `shells`.
 * needs: waiting agents and agents stopped with an error (one list), then night-shift pending
 * items, then notes Mirador left for you;
 * review: finished agents, then results Mirador resolved; working: only the agents
 * running now (closed agents and Engram-only projects are in dockGroups). A terminal
 * appears only in its most urgent lane (needs, then review, then working). Every group
 * is oldest first: the one that has waited longest leads.
 */
export function trackingLanes({ model, items = [], nightNotes = [], pending = [], workspaceName = (id) => id ?? '' }) {
  const nightOf = new Map([...items, ...nightNotes].filter((entry) => entry.night).map((entry) => [entry.terminalId, entry.night]));
  const place = placer(workspaceName);
  const agents = agentCards(model, place, nightOf);
  const inState = (...states) => agents.filter((agent) => states.includes(agent.state)).sort(oldestFirst((agent) => agent.since));

  const pendingCards = (Array.isArray(pending) ? pending : [])
    .map((entry) => ({
      type: 'pending',
      id: entry.id,
      terminalId: entry.terminalId,
      kind: entry.kind,
      time: entry.time,
      summary: entry.summary,
      rule: entry.rule,
      reason: entry.reason,
      place: place(entry.workspaceId, entry.rel),
    }))
    .sort(oldestFirst((card) => card.time));
  const covered = new Set(pendingCards.map((card) => card.terminalId));
  const noteCard = (note) => ({
    type: 'note',
    terminalId: note.terminalId,
    title: note.title,
    kind: note.kind,
    label: note.label,
    since: note.since,
    night: note.night,
    place: place(note.workspaceId, note.rel),
  });
  const deferred = nightNotes.filter((note) => note.night?.state === 'deferred' && !covered.has(note.terminalId)).map(noteCard).sort(oldestFirst((card) => card.since));
  const resolved = nightNotes.filter((note) => note.night?.state === 'resolved').map(noteCard).sort(oldestFirst((card) => card.night.at));

  // An agent stopped with an error waits for the user with the blocked ones, as in the inbox's "Needs you".
  const waiting = inState('waiting', 'error');
  // A terminal already in a more urgent lane is not listed again further right.
  const inNeeds = new Set([...waiting, ...pendingCards, ...deferred].map(terminalOf));
  const notIn = (taken) => (card) => !taken.has(terminalOf(card));
  const finished = inState('finished').filter(notIn(inNeeds));
  const reviewed = resolved.filter(notIn(inNeeds));
  const taken = new Set([...inNeeds, ...[...finished, ...reviewed].map(terminalOf)]);
  const working = inState('working').filter(notIn(taken));
  return {
    strip: { projects: model.summary.projects, running: model.summary.running },
    needs: { count: waiting.length + pendingCards.length + deferred.length, groups: [...group('waiting', waiting), ...group('pending', pendingCards), ...group('deferred', deferred)] },
    review: { count: finished.length, groups: [...group('finished', finished), ...group('resolved', reviewed)] },
    working: { count: working.length, groups: group('working', working), shells: model.summary.shells },
  };
}

/**
 * What the Seguimiento dock lists next to today's projects, out of the lanes: closed
 * agents (oldest first), sleeping agents (GET /api/terminals/sleeping, no process until
 * woken; oldest record first) and the Engram projects active today with no running agent in
 * Mirador (seen only through their memories; activity order). Returns
 * { count, groups: [{ key: 'exited' | 'sleeping' | 'outside', cards }] } with empty groups left out.
 */
export function dockGroups({ model, workspaceName = (id) => id ?? '', sleeping = [] }) {
  const place = placer(workspaceName);
  const exited = agentCards(model, place)
    .filter((agent) => agent.state === 'exited')
    .sort(oldestFirst((agent) => agent.since));
  const asleep = sleeping
    .map(({ id, workspaceId, rel, createdAt, resumable }) => ({ type: 'sleeping', id, workspaceId, rel, createdAt, resumable, place: place(workspaceId, rel) }))
    .sort(oldestFirst((card) => card.createdAt));
  const outside = model.projects
    .filter((project) => !project.withAgent)
    .map((project) => ({ type: 'project', project: project.project, count: project.count, lastAt: project.lastAt, titles: project.titles }));
  return { count: exited.length + asleep.length + outside.length, groups: [...group('exited', exited), ...group('sleeping', asleep), ...group('outside', outside)] };
}

