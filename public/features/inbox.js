// Attention inbox (W4), the panel's "Te esperan (N)" view (public/features/summary.js shows its
// slot): agent terminals that need the user.
// "Needs you" (a guarded command, a question, a choice, any dialog, an error) comes first, as
// one list with the longest wait on top, in the server's order (inbox-model.js); "Finished,
// ready for review" (the agent ended its turn) below, by workspace and folder. Browser
// notifications are opt-in from the button above the list (inbox-notify.js), with two switches
// beside it: notices that ask stay on screen (on by default) and discreet mode (off by default).
// New cards are collected for 1.5 s (NOTIFY_WINDOW_MS) before they notify, so a burst groups.
// The terminal the user is looking at is not listed, and the view says
// so while nothing waits. Updates arrive on GET /api/inbox/stream (NDJSON over fetch,
// since EventSource cannot send the session token); see src/http/routes/inbox.ts.
// Night shift: a card shows what Mirador is doing or did for it (deciding, moved on,
// left for you), and a card Mirador resolved stays as a short note until it is seen.
// Phone layout (public/features/phone.js, on its `phone` event): cards read the reason first, a
// card opens its terminal without the soft keyboard, and the stream's state goes to the header
// (the `inbox:stream` event). A stream silent for longer than two heartbeats is dropped and
// reopened, and so is one the page comes back to after a long time hidden (inbox-model.js streamWatch).
import { api, el, emit, getLanguage, on, prefs, session, slot, t, workspaceById } from '/core.js';
import { setAgentStates } from '/features/agent-states.js';
import { BRAND } from '/mode-model.js';
import { plural } from '/i18n.js';
import { nightView } from '/i18n/inbox.js';
import { icon } from '/icons.js';
import { tabAgent } from '/icons/agents.js';
import { answers, cardLayout, inboxGroups, streamWatch, waitLabel } from '/features/inbox-model.js';
import { createInboxNotifier, NOTIFY_PREF, NOTIFY_WINDOW_MS, showGroupNotification, showNotification as showCardNotification } from '/features/inbox-notify.js';
import { GUARDED_LABEL, NOTIFY_DISCREET_PREF, NOTIFY_STAY_PREF } from '/features/inbox-notify-model.js';
import { activateTerminal, activeTerminalId, adoptTerminals, markWaiting, terminalList } from '/terminals.js';
import { showsActiveTerminal } from '/features/phone-model.js';

/** gentle-shell's blocker labels, translated; any other label is shown as the agent wrote it. */
// Tracking: exported so the tracking view words blockers the same way.
export const REASONS = {
  [GUARDED_LABEL]: 'inbox.reason.guarded',
  'Questionnaire awaiting input': 'inbox.reason.questionnaire',
  'Choice awaiting input': 'inbox.reason.choice',
  'Awaiting input': 'inbox.reason.input',
  // An OSC 7501 error card (src/attention/store.ts); its message is the detail.
  Error: 'inbox.reason.error',
};
const TICK_MS = 30_000;
const MAX_BUFFER = 1024 * 1024;

let host;
let live;
/** The cards, under the notification control: a re-render replaces only these. */
let cards;
let notifyBar;
let notifyButton;
let notifyStatus;
/** The two switches beside the button: notices that ask stay on screen, and discreet mode. */
let notifyOptions;
let staySwitch;
let discreetSwitch;
let notifier;
/** The agents Mirador offers (GET /api/agents, read once), to name a card's agent in its notification. */
let offeredAgents = [];
/** A permission prompt is open (the button waits for the browser's answer). */
let asking = false;
let items = [];
/** Terminals with a night state and no waiting card (GET /api/inbox `nightNotes`). */
let notes = [];
/** terminalId → the night state last announced (state, summary, rule), so only changes are read out. */
let announced = null;
/** The phone view (phone-model.js nextView), null on the desktop layout. */
let phoneView = null;
/** The stream's state: 'live' while it reads, 'reconnecting' before the first answer and between tries. */
let stream = 'reconnecting';
/**
 * The timers of the stream's watch and of the notifications' window. unref: in Node (the tests run
 * this file) a pending timer does not keep the process alive; a browser's timer id is a number, which has none.
 */
const timers = {
  setTimer: (fn, ms) => {
    const id = setTimeout(fn, ms);
    id?.unref?.();
    return id;
  },
  clearTimer: (id) => clearTimeout(id),
};
/** Each try of the stream: aborted when silent past the bound, or on coming back to the page (inbox-model.js). */
const watch = streamWatch({ now: () => Date.now(), ...timers });
/** Ends follow()'s pending backoff wait at once; null when it is not waiting. */
let wake = null;
const baseTitle = document.title.replace(/^\(\d+\)\s*/, '') || BRAND;

/** A night note with no card behind it has no label: a question, or a note to an agent that had not finished. */
const reason = (item) =>
  item.kind === 'finished'
    ? t(item.label ? 'inbox.reason.finished' : 'inbox.reason.note')
    : REASONS[item.label] ? t(REASONS[item.label]) : item.label || t('inbox.reason.question');
const isNote = (item) => notes.includes(item);
/** He is looking at it: the active terminal of a window on screen, unless the phone's inbox covers it. */
const inView = (item) => showsActiveTerminal(phoneView) && item.terminalId === activeTerminalId() && document.visibilityState === 'visible';

/** "folder › subfolder" of the terminal, or the workspace root. */
const place = (item) => (item.rel ? item.rel.split('/').join(' › ') : t('inbox.root'));
const workspaceName = (item) => workspaceById(item.workspaceId)?.name ?? item.workspaceId;

function waited(since) {
  const { key, vars } = waitLabel(since, Date.now());
  return t(key, vars);
}

/**
 * A file the label names, as a path relative to the terminal's folder: only a token
 * with a slash or a leading dot (`src/app.ts`, `.env.example`), never one with `..`.
 * The file editor (W5) checks it against the folder before opening anything.
 */
function namedFile(label) {
  for (const token of label.split(/\s+/)) {
    const path = token.replace(/^["'`(]+|["'`),;:.]+$/g, '');
    if (!/^[\w.-]+(\/[\w.-]+)*$/.test(path) || path.startsWith('/') || path.split('/').includes('..')) continue;
    if ((path.includes('/') || path.startsWith('.')) && /\.[A-Za-z][\w-]*$/.test(path)) return path;
  }
  return null;
}

/** One line under the reason: the badge and what the night shift is doing or did. */
function renderNight(night) {
  const view = nightView(night, t);
  if (!view) return null;
  return el(
    'span',
    { class: `inbox-night ${view.state}`, title: view.title || view.line },
    el('span', { class: 'inbox-night-badge' }, icon(view.icon), view.badge),
    el('span', { class: 'inbox-night-line' }, view.line),
  );
}

/**
 * A card's click: its terminal, which takes the keyboard on the desktop; on the phone it opens
 * full-screen (features/phone.js) without raising the soft keyboard.
 */
function openCard(id) {
  activateTerminal(id, !phoneView);
  emit('inbox:open', id);
}

/**
 * A card whose terminal this window lacks (opened in another window after this page loaded):
 * read the terminal list, then open it if it came.
 */
async function openElsewhere(id) {
  await adoptTerminals();
  if (terminalList().some((info) => info.id === id)) openCard(id);
}

/**
 * One card; `named` adds its workspace to the place (the "needs you" list is not grouped by
 * workspace). Its parts follow cardLayout: the phone layout reads the reason first.
 */
function renderItem(item, note, here, named = false) {
  const time = new Date(item.since).toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit' });
  const layout = cardLayout(Boolean(phoneView), named);
  const parts = {
    place: () => el('span', { class: 'inbox-place' }, layout.named ? `${workspaceName(item)} › ${place(item)}` : place(item)),
    reason: () => el('span', { class: 'inbox-reason' }, reason(item)),
    detail: () => (item.detail ? el('span', { class: 'inbox-detail', title: item.detail }, item.detail) : null),
    night: () => renderNight(item.night),
    meta: () =>
      el(
        'span',
        { class: 'inbox-meta' },
        el('span', { class: 'inbox-wait', 'data-since': item.since, title: t('inbox.since', { time }) }, waited(item.since)),
        item.activity ? el('span', { class: 'inbox-activity', title: item.activity }, item.activity) : null,
        here ? null : el('span', {}, t('inbox.elsewhere')),
      ),
  };
  const content = layout.parts.map((part) => parts[part]());
  const file = answers(item) && !note ? namedFile(item.label) ?? (item.detail && namedFile(item.detail)) : null;
  return el(
    'li',
    { class: note ? 'inbox-item night-note' : 'inbox-item' },
    here
      ? el('button', { type: 'button', class: 'inbox-jump', 'data-terminal': item.terminalId, title: t('inbox.jump'), onclick: () => openCard(item.terminalId) }, ...content)
      : el('button', { type: 'button', class: 'inbox-jump elsewhere', 'data-terminal': item.terminalId, title: t('inbox.jump'), onclick: () => openElsewhere(item.terminalId) }, ...content),
    file
      ? el('button', { type: 'button', class: 'btn inbox-file', onclick: () => emit('files:open', { ws: item.workspaceId, rel: item.rel, path: file }) }, t('inbox.openFile', { file }))
      : null,
  );
}

/**
 * One group (inbox-model.js inboxGroups): "needs you" as one list, longest wait first, each card
 * naming its workspace; "finished" by workspace, then folder. Night notes sit in their card's group.
 */
function renderGroup(group, here) {
  const card = ({ item, note }, named) => renderItem(item, note, here.has(item.terminalId), named);
  return el(
    'section',
    { class: `inbox-group ${group.key}`, 'aria-labelledby': `inbox-${group.key}` },
    el('h2', { class: 'inbox-group-head', id: `inbox-${group.key}` }, t(`inbox.${group.key}`), group.count ? el('span', { class: 'inbox-count' }, String(group.count)) : null),
    group.entries ? el('p', { class: 'inbox-group-note' }, t('inbox.answerOrder')) : null,
    group.entries
      ? el('ul', { class: 'inbox-list' }, ...group.entries.map((entry) => card(entry, true)))
      : group.workspaces.map(([workspaceId, entries]) =>
        el(
          'div',
          { class: 'inbox-ws' },
          el('h3', {}, workspaceById(workspaceId)?.name ?? workspaceId),
          el('ul', { class: 'inbox-list' }, ...entries.map((entry) => card(entry, false))),
        ),
      ),
  );
}

function render() {
  const waiting = items.filter((item) => !inView(item));
  document.title = waiting.length ? `(${waiting.length}) ${baseTitle}` : baseTitle;
  const marks = (keep) => new Map(items.filter(keep).map((item) => [item.terminalId, reason(item)]));
  markWaiting(marks(answers), marks((item) => !answers(item)));
  emit('inbox', items);
  renderNotify();
  // Re-rendering must not steal the keyboard from someone walking the list.
  const focused = cards.contains(document.activeElement) ? document.activeElement.dataset?.terminal : undefined;
  const groups = inboxGroups(items, notes, inView);
  if (!groups.length) {
    host.removeAttribute('aria-label');
    cards.replaceChildren(el('p', { class: 'notice' }, t('inbox.empty')));
    return;
  }
  const here = new Set(terminalList().map((info) => info.id));
  host.setAttribute('aria-label', t('inbox.label'));
  cards.replaceChildren(...groups.map((group) => renderGroup(group, here)));
  if (focused) cards.querySelector(`[data-terminal="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}

/**
 * The notification control: one button (turn on / turn off) and what the browser allows.
 * `refocus`: the keyboard was on the button before it was disabled (toggleNotify).
 */
function renderNotify(refocus = false) {
  const status = notifier.status();
  const usable = status === 'on' || status === 'off';
  const hadFocus = refocus || document.activeElement === notifyButton;
  notifyBar.setAttribute('aria-label', t('inbox.notify.label'));
  notifyButton.hidden = !usable;
  notifyButton.disabled = asking;
  notifyButton.toggleAttribute('aria-busy', asking);
  notifyButton.textContent = t(status === 'on' ? 'inbox.notify.turnOff' : 'inbox.notify.turnOn');
  notifyStatus.textContent = t(asking ? 'inbox.notify.asking' : `inbox.notify.status.${status}`);
  notifyStatus.className = `inbox-notify-status ${status}`;
  notifyOptions.hidden = !usable;
  notifyOptions.setAttribute('aria-label', t('inbox.notify.options'));
  staySwitch.box.checked = prefs.read(NOTIFY_STAY_PREF, true) !== false;
  discreetSwitch.box.checked = prefs.read(NOTIFY_DISCREET_PREF, false) === true;
  staySwitch.text.textContent = t('inbox.notify.stay');
  discreetSwitch.text.textContent = t('inbox.notify.discreet');
  // The keyboard stays on the button while it shows; a refusal hides it, so the keyboard goes to the
  // text that says why.
  if (hadFocus) (usable ? notifyButton : notifyStatus).focus({ preventScroll: true });
}

/** The button's click: the only place the browser is asked for permission (inbox-notify.js). */
async function toggleNotify() {
  if (asking) return;
  // Disabling the focused button drops the keyboard to <body> (Chromium), so remember it first.
  const hadFocus = document.activeElement === notifyButton;
  asking = true;
  renderNotify();
  try {
    await notifier.toggle();
  } finally {
    asking = false;
    // Unless the user moved the keyboard somewhere else while the browser asked.
    const free = !document.activeElement || document.activeElement === document.body || document.activeElement === notifyButton;
    renderNotify(hadFocus && free);
  }
}

/** One switch beside the notification button: a checkbox stored under `key`, its text and the label holding both. */
function notifySwitch(key) {
  const box = el('input', { type: 'checkbox', onchange: () => prefs.write(key, box.checked) });
  const text = el('span', {});
  return { box, text, label: el('label', { class: 'inbox-notify-option' }, box, text) };
}

/** What every notification needs besides its card (inbox-notify-model.js): the language and the two switches. */
function notifyWords() {
  const lang = getLanguage();
  return {
    lang,
    stay: prefs.read(NOTIFY_STAY_PREF, true) !== false,
    discreet: prefs.read(NOTIFY_DISCREET_PREF, false) === true,
    waiting: (count) => plural(lang, 'inbox.notify.waiting', count),
  };
}

/** The card's agent as its tab names it (icons/agents.js tabAgent), or null when this window does not have its terminal. */
function agentName(item) {
  const info = terminalList().find((terminal) => terminal.id === item.terminalId);
  const configured = offeredAgents.find((agent) => agent?.configured)?.label ?? null;
  return (info && tabAgent(info, offeredAgents, configured)?.label) || null;
}

/**
 * Shows the inbox, as its own controls do: the phone's "waiting for you" button, or the panel
 * (opened first when hidden) and its "Te esperan" view (features/summary.js).
 */
function openInbox() {
  if (phoneView) {
    document.getElementById('phone-to-inbox')?.click();
    return;
  }
  const showPanel = document.querySelector('.side-show[data-side="panel"]');
  if (showPanel && showPanel.offsetParent !== null) showPanel.click();
  document.querySelector('[data-slot="panel-views"] [data-view="inbox"]')?.click();
}

/**
 * One browser notification for a card that started waiting, or null when the browser refused it;
 * the notifier closes it when the card leaves. Clicking it brings this window forward and selects
 * the terminal when this window still has it (inbox-notify.js showNotification).
 */
function showNotification(item) {
  try {
    return showCardNotification(Notification, item, { reason: reason(item), workspace: workspaceName(item), agent: agentName(item), ...notifyWords() }, {
      focus: () => window.focus(),
      open: ({ terminalId }) => {
        if (terminalList().some((info) => info.id === terminalId)) activateTerminal(terminalId);
      },
    });
  } catch {
    // Some browsers only notify from a service worker: the control then says it is not available.
    return null;
  }
}

/** One notification for a burst of new cards (inbox-notify.js showGroupNotification); its click opens the inbox. */
function showGroup(list) {
  try {
    const entries = list.map((item) => ({ item, workspace: workspaceName(item) }));
    return showGroupNotification(Notification, entries, notifyWords(), { focus: () => window.focus(), openInbox });
  } catch {
    return null;
  }
}

/** Says each night state that changed since the last message, politely; the first message only sets the baseline. */
function announce() {
  const marked = [...items, ...notes].filter((item) => item.night);
  const key = ({ night }) => [night.state, night.summary, night.rule ?? ''].join('\u0000');
  const changed = announced ? marked.filter((item) => announced.get(item.terminalId) !== key(item)) : [];
  announced = new Map(marked.map((item) => [item.terminalId, key(item)]));
  if (changed.length) live.textContent = changed.map((item) => `${place(item)}: ${nightView(item.night, t)?.line ?? ''}`).join('. ');
}

/** Activating a terminal means the user saw it: its finished turn and its night result leave the inbox (answers stay). */
function seen(id) {
  render();
  const result = (item) => item.terminalId === id && (item.night?.state === 'resolved' || (isNote(item) && item.night?.state === 'deferred'));
  if (items.some((item) => (item.terminalId === id && !answers(item)) || result(item)) || notes.some(result)) {
    api('POST', `/api/inbox/${encodeURIComponent(id)}/seen`).catch(() => {});
  }
}

/** Keeps the "how long" texts current without rebuilding the list. */
function tick() {
  host.querySelectorAll('.inbox-wait[data-since]').forEach((node) => { node.textContent = waited(node.dataset.since); });
}

/** The stream's state, for the phone header (features/phone.js reads it at start, then follows the event). */
export const inboxStream = () => stream;

function setStream(next) {
  if (next === stream) return;
  stream = next;
  emit('inbox:stream', stream);
}

/**
 * Reads the stream for as long as the window lives; reconnects with backoff, stops on 401. A try
 * that reads nothing (not even the `{}` heartbeat) for STREAM_SILENCE_MS is aborted, and one the page
 * comes back to after that long is aborted at once and retried without the backoff (the watch); the
 * same return during a backoff wait ends the wait.
 */
async function follow() {
  let delay = 1000;
  for (;;) {
    if (!session.token) return;
    const signal = watch.open();
    try {
      const response = await fetch('/api/inbox/stream', { headers: { authorization: `Bearer ${session.token}` }, signal });
      if (response.status === 401) return session.expire();
      if (!response.ok || !response.body) throw new Error(`inbox stream answered ${response.status}`);
      delay = 1000;
      setStream('live');
      watch.alive();
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        watch.alive();
        buffer += value;
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          // A state that changes while its card does not, or after the card left (#12).
          if (message?.agentStates && typeof message.agentStates === 'object') {
            setAgentStates(message.agentStates);
          }
          if (Array.isArray(message?.items)) {
            items = message.items;
            notes = Array.isArray(message.nightNotes) ? message.nightNotes : [];
            render();
            announce();
            // Only stream messages notify (after the window); a re-render or a reconnect's same snapshot never does.
            notifier.receive(items, inView);
          }
        }
        if (buffer.length > MAX_BUFFER) break;
      }
    } catch {
      // The server restarted, the network dropped or the watch aborted a silent try: try again below.
    } finally {
      watch.close();
    }
    if (watch.retryNow()) {
      // Back to the page after a long time away: the old socket was not trusted, so no backoff.
      setStream('reconnecting');
      continue;
    }
    setStream('reconnecting');
    await new Promise((resolve) => {
      const id = setTimeout(resolve, delay);
      wake = () => {
        clearTimeout(id);
        resolve();
      };
    });
    wake = null;
    delay = Math.min(delay * 2, 30_000);
  }
}

export async function init() {
  host = slot('inbox');
  // Outside the list, so re-rendering never recreates it and an empty inbox still hides.
  live = el('p', { class: 'inbox-live', role: 'status', 'aria-live': 'polite' });
  host.after(live);
  notifier = createInboxNotifier({
    api: typeof Notification === 'function' ? Notification : null,
    read: () => prefs.read(NOTIFY_PREF, false),
    write: (value) => prefs.write(NOTIFY_PREF, value),
    show: showNotification,
    showGroup,
    // The window ends with what the user is looking at then; a browser that refuses changes the control.
    windowMs: NOTIFY_WINDOW_MS,
    ...timers,
    onRefused: () => renderNotify(),
  });
  api('GET', '/api/agents')
    .then((answer) => { offeredAgents = Array.isArray(answer?.agents) ? answer.agents : []; })
    .catch(() => {});
  notifyStatus = el('span', { class: 'inbox-notify-status', id: 'inbox-notify-status', role: 'status', tabindex: '-1' });
  notifyButton = el('button', { type: 'button', class: 'btn inbox-notify-toggle', 'aria-describedby': 'inbox-notify-status', onclick: toggleNotify });
  cards = el('div', { class: 'inbox-cards' });
  staySwitch = notifySwitch(NOTIFY_STAY_PREF);
  discreetSwitch = notifySwitch(NOTIFY_DISCREET_PREF);
  notifyOptions = el('div', { class: 'inbox-notify-options', role: 'group' }, staySwitch.label, discreetSwitch.label);
  notifyBar = el('div', { class: 'inbox-notify', role: 'group' }, notifyButton, notifyStatus, notifyOptions);
  host.replaceChildren(notifyBar, cards);
  on('terminals', render);
  on('workspaces', render);
  on('language', render);
  on('activate', seen);
  on('phone', (view) => {
    phoneView = view;
    render();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') watch.hidden();
    else if (watch.visible()) wake?.();
    render();
  });
  setInterval(tick, TICK_MS);
  render();
  follow();
}
