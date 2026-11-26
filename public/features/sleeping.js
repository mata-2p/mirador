// Sleeping agents: agents that had finished their
// turn before a restart, which Mirador did not reopen to save memory. They have no process and no
// terminal pane. Desarrollo shows a "Dormidos (N)" entry at the end of each workspace's group
// (terminals.js setSleeping) that opens a dialog with Despertar / Olvidar per agent and Despertar
// todos; Seguimiento lists them in its dock (tracking.js, through sleepingAgents() and the
// `sleeping` event).
// - The list is GET /api/terminals/sleeping, read at start, when the terminals change (an agent
//   opened by hand in a sleeping agent's folder replaces it), when the window shows again, and after
//   each action here.
// - Despertar (POST …/:id/wake) and Despertar todos (POST /api/terminals/sleeping/wake) answer at once:
//   the agents open through the launch gate like the restore, so the loading bar shows them
//   (`launches` event) and they appear as tabs as they open. They are never blocked while other
//   agents open: the server queues them behind the run in progress.
// - Olvidar (DELETE …/:id) asks first; focus starts on Cancelar.
// - An open agent put to sleep while Mirador runs leaves its tab in every window (terminals.js
//   `slept`): one role=status line in the alerts slot says so for about 8 s, with Despertar. On the
//   phone that slot sits above the inbox. A newer line replaces it.
// Rules live in sleeping-model.js.
import { api, el, emit, errorText, on, slot, t, workspaceById } from '/core.js';
import { confirmDialog, openDialog, showAlert } from '/dialog.js';
import { icon } from '/icons.js';
import { setSleeping } from '/terminals.js';
import { sleepingCounts, sleepingGroups } from '/features/sleeping-model.js';

let agents = [];
let reading = null;

/** The sleeping agents as last read (GET /api/terminals/sleeping). */
export function sleepingAgents() {
  return agents;
}

const nameOf = (agent) => agent.rel || workspaceById(agent.workspaceId)?.name || agent.workspaceId;

/** How long the line saying an agent went to sleep stays. */
const SLEPT_LINE_MS = 8000;
let sleptLine = null;
let sleptTimer = null;

function hideSlept() {
  clearTimeout(sleptTimer);
  sleptLine?.remove();
  sleptLine = null;
}

/**
 * Open agent `info` was put to sleep (terminals.js `slept`): "«{name}» se durmió · está en Dormidos
 * · [Despertar]" for about 8 s; its sleeping record has its terminal id. Not modal: never takes focus.
 */
export function showSlept(info) {
  hideSlept();
  const host = slot('alerts');
  if (!host) return;
  const wake = el('button', { type: 'button', class: 'btn', title: t('sleeping.wakeTitle') }, t('sleeping.wake'));
  wake.addEventListener('click', () => {
    hideSlept();
    wakeSleeping(info.id);
  });
  sleptLine = el('p', { class: 'slept-line', role: 'status' }, el('span', {}, t('sleeping.slept', { name: nameOf(info) })), wake);
  host.append(sleptLine);
  sleptTimer = setTimeout(hideSlept, SLEPT_LINE_MS);
}

export function refreshSleeping() {
  reading ??= read().finally(() => (reading = null));
  return reading;
}

async function read() {
  try {
    agents = (await api('GET', '/api/terminals/sleeping')).agents ?? [];
  } catch {
    // An older server, or a restart: nothing sleeps here.
    agents = [];
  }
  setSleeping(sleepingCounts(agents), openWorkspace);
  emit('sleeping', agents);
}

/** Despertar: one agent by id. Resolves true once the server took it. */
export async function wakeSleeping(id) {
  return act(() => api('POST', `/api/terminals/sleeping/${encodeURIComponent(id)}/wake`));
}

/** Despertar todos: every sleeping agent, or `workspaceId`'s. */
export async function wakeAllSleeping(workspaceId) {
  return act(() => api('POST', '/api/terminals/sleeping/wake', workspaceId ? { ws: workspaceId } : {}));
}

/** Olvidar, after a confirmation that starts on Cancelar. */
export async function forgetSleeping(agent) {
  const sure = await confirmDialog({
    title: t('sleeping.confirmForgetTitle'),
    message: t('sleeping.confirmForget', { name: nameOf(agent) }),
    confirmLabel: t('sleeping.forget'),
    cancelLabel: t('sleeping.cancel'),
    danger: true,
  });
  if (!sure) return false;
  return act(() => api('DELETE', `/api/terminals/sleeping/${encodeURIComponent(agent.id)}`));
}

async function act(request) {
  let ok = true;
  try {
    await request();
    // A wake opens through the launch gate: the loading bar reads its run now.
    emit('launches');
  } catch (error) {
    // 404: it was woken or forgotten meanwhile (another window); the list below says so.
    if (error.status !== 404) {
      ok = false;
      showAlert(t('sleeping.failed', { error: errorText(error) }));
    }
  }
  await refreshSleeping();
  return ok;
}

/** One sleeping agent: its folder, whether it continues a session, Despertar and Olvidar. */
export function sleepingRow(agent, { onDone } = {}) {
  // Secondary: "Despertar todos" is the dialog's one primary action.
  const wake = el('button', { type: 'button', class: 'btn', title: t('sleeping.wakeTitle') }, t('sleeping.wake'));
  const forget = el('button', { type: 'button', class: 'btn', title: t('sleeping.forgetTitle') }, t('sleeping.forget'));
  const busy = async (button, run) => {
    if (button.getAttribute('aria-busy') === 'true') return;
    button.setAttribute('aria-busy', 'true');
    try {
      if (await run()) onDone?.();
    } finally {
      button.removeAttribute('aria-busy');
    }
  };
  wake.addEventListener('click', () => busy(wake, () => wakeSleeping(agent.id)));
  forget.addEventListener('click', () => busy(forget, () => forgetSleeping(agent)));
  return el(
    'li',
    { class: 'sleep-row' },
    el('span', { class: 'sleep-name' }, icon('sleep'), nameOf(agent)),
    agent.resumable ? '' : el('span', { class: 'muted sleep-fresh' }, t('sleeping.fresh')),
    el('span', { class: 'sleep-actions' }, wake, forget),
  );
}

/** The dialog behind a workspace's "Dormidos (N)" entry. */
async function openWorkspace(workspaceId) {
  const group = sleepingGroups(agents, workspaceById(workspaceId) ? [workspaceById(workspaceId)] : []).find((g) => g.workspaceId === workspaceId);
  if (!group) return;
  const list = el('ul', { class: 'sleep-list' });
  let dialogNode = null;
  const fill = () => {
    const left = agents.filter((agent) => agent.workspaceId === workspaceId);
    if (!left.length) return dialogNode?.close();
    list.replaceChildren(...sleepingGroups(left, []).flatMap((g) => g.agents).map((agent) => sleepingRow(agent, { onDone: fill })));
  };
  fill();
  const opening = openDialog({
    title: t('sleeping.title', { name: group.name }),
    className: 'sleep-dialog',
    body: [el('p', { class: 'muted' }, t('sleeping.whyMany')), list],
    close: t('sleeping.close'),
    actions: [
      { label: t('sleeping.wakeAll'), value: 'wake', kind: 'primary' },
    ],
    onAction: async (value) => (value === 'wake' ? wakeAllSleeping(workspaceId) : true),
  });
  dialogNode = list.closest('dialog');
  await opening;
}

export async function init() {
  // The entries follow the language and workspace names through terminals.js's own re-render.
  on('terminals', refreshSleeping);
  on('slept', showSlept);
  // Another window forgot a sleeping agent; the inbox stream says so (#91).
  on('sleepingChanged', refreshSleeping);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refreshSleeping());
  await refreshSleeping();
}
