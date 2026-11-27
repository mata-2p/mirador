// The topbar's "Ajustes" sheet and night chip ("Barra superior"). One button opens a sheet with
// the autopilot switch, the terminals layout, the theme and the language; it closes with Esc
// or a click outside and gives the focus back to the button. Rows and rules: settings-model.js.
// - mountSettings() builds the rows; app.js calls it at start, before it wires `data-lang` and
//   public/terminals.js wires `data-layout`, so both keep their own handlers and pressed state.
// - The theme row calls setTheme() and follows the `theme` event.
// - The "El árbol sigue a la terminal" switch turns the tree reveal on and off; its choice lives in
//   core.js prefs (`mirador.treeFollows`, tree-reveal-model.js), which public/terminals.js reads.
// - The "Ayuda" row's "Abrir la guía" opens the help guide (public/features/help.js).
// - Under the rows, "Dormir inactivos / Idle sleep" (#115) has a switch and the threshold in minutes, read with
//   GET /api/settings/idle-sleep and saved with PUT, which applies them at once (no restart).
// - Under the rows, "Otras ventanas" signs out every other window (a lost phone) with
//   DELETE /api/session/others, after a confirmation, and says how many it signed out.
// - The night switch and the "Piloto automático" chip follow GET /api/night through
//   public/features/night.js (its `night` event, plus a light read every NIGHT_POLL_MS while the
//   window is visible) and switch it with toggleNight(), the strip's former switch.
import { $, api, el, errorText, getTheme, on, prefs, setTheme, state, t } from '/core.js';
import { confirmDialog } from '/dialog.js';
import { openGuide } from '/features/help.js';
import { nightSwitchState, readNightStatus, toggleNight } from '/features/night.js';
import { icon } from '/icons.js';
import { showsExtra } from '/mode-model.js';
import { IDLE_SLEEP_SETTING, SETTINGS_ROWS, SIGN_OUT_OTHERS, idleSleepMinutesFrom, idleSleepSwitchView, nightSwitchView, pressedChoices, sheetCloses, signOutResult, treeFollowsSwitchView } from '/settings-model.js';
import { readTreeFollows, writeTreeFollows } from '/features/tree-reveal-model.js';

const NIGHT_POLL_MS = 30_000;

let toggleButton;
let sheet;
let nightSwitch;
let nightWord;
let nightError;
let treeFollowsSwitch;
let treeFollowsWord;
let signOutButton;
let signOutLine;
/** The last sign-out's answer: { cleared } or { error }; null before the first. */
let signOutAnswer = null;
let signingOut = false;
let timer = null;
let idleSwitch;
let idleWord;
let idleMinutes;
let idleLine;
/** { on, minutes } from GET /api/settings/idle-sleep; null until read. */
let idleSetting = null;
let idleSaving = false;
/** The last idle-sleep problem: { key } (the field's own check) or { error } (the server's); null when none. */
let idleProblem = null;

function choiceButton(row, choice) {
  return el(
    'button',
    {
      type: 'button',
      class: 'btn',
      [`data-${row.attr}`]: choice.value,
      'aria-pressed': 'false',
      lang: choice.text ? choice.value : undefined,
      'data-i18n': choice.key,
      'data-i18n-label': choice.labelKey,
    },
    choice.text ?? t(choice.key),
  );
}

function control(row) {
  if (row.control === 'choices') {
    return el('div', { class: 'segmented', role: 'group', 'data-i18n-label': row.groupKey }, ...row.choices.map((choice) => choiceButton(row, choice)));
  }
  if (row.control === 'button') {
    return el('button', { type: 'button', class: 'btn sm', 'aria-keyshortcuts': row.shortcut, 'data-i18n': row.buttonKey, onclick: () => openGuide() }, t(row.buttonKey));
  }
  if (row.id === 'treeFollows') return treeFollowsControl(row);
  nightWord = el('span', { class: 'switch-state', 'aria-hidden': 'true' });
  nightSwitch = el(
    'button',
    { type: 'button', class: 'switch', role: 'switch', 'aria-checked': 'false', 'aria-labelledby': `settings-${row.id}-label`, 'aria-describedby': row.hintKey ? `settings-${row.id}-hint` : undefined, disabled: true, onclick: () => toggleNight() },
    nightWord,
    el('span', { class: 'switch-track', 'aria-hidden': 'true' }, el('span', { class: 'switch-thumb' })),
  );
  return nightSwitch;
}

/** The "El árbol sigue a la terminal" switch: a press flips the stored choice and redraws it. */
function treeFollowsControl(row) {
  treeFollowsWord = el('span', { class: 'switch-state', 'aria-hidden': 'true' });
  treeFollowsSwitch = el(
    'button',
    {
      type: 'button',
      class: 'switch',
      role: 'switch',
      'aria-checked': 'true',
      'aria-labelledby': `settings-${row.id}-label`,
      'aria-describedby': row.hintKey ? `settings-${row.id}-hint` : undefined,
      onclick: () => {
        writeTreeFollows(prefs, !readTreeFollows(prefs));
        renderTreeFollows();
      },
    },
    treeFollowsWord,
    el('span', { class: 'switch-track', 'aria-hidden': 'true' }, el('span', { class: 'switch-thumb' })),
  );
  return treeFollowsSwitch;
}

/** A row's icon; Sereno's owl takes the accent color. */
function rowIcon(name) {
  const node = icon(name);
  if (name === 'sereno') node.classList.add('sereno-ic');
  return node;
}

/** A row's name, which names its control, and under it the row's hint when it has one. */
function rowLabel(row) {
  const name = el('span', { id: `settings-${row.id}-label`, 'data-i18n': row.key }, t(row.key));
  if (!row.hintKey) return name;
  return el('span', { class: 'set-text' }, name, el('small', { class: 'set-hint', 'data-i18n': row.hintKey, id: `settings-${row.id}-hint` }, t(row.hintKey)));
}

/** Builds the sheet's rows in #settings-sheet. Synchronous and before sign-in: no request. */
export function mountSettings() {
  toggleButton = $('#settings-toggle');
  sheet = $('#settings-sheet');
  nightError = el('p', { class: 'settings-error', role: 'alert' });
  sheet.replaceChildren(
    ...SETTINGS_ROWS.map((row) =>
      el(
        'div',
        { class: 'set-row', 'data-development-only': row.developmentOnly || undefined },
        el('span', { class: 'set-label' }, row.icon ? rowIcon(row.icon) : null, rowLabel(row)),
        control(row),
      ),
    ),
    ...idleSleepParts(),
    ...signOutParts(),
    nightError,
  );
  renderTheme();
  renderNight();
  renderTreeFollows();
  renderIdleSleep();
}

/* ---------- Idle sleep ---------- */

/** "Dormir inactivos": the switch row, the minutes row and the line that says what went wrong. */
function idleSleepParts() {
  const row = { id: 'idleSleep', ...IDLE_SLEEP_SETTING };
  idleWord = el('span', { class: 'switch-state', 'aria-hidden': 'true' });
  idleSwitch = el(
    'button',
    {
      type: 'button',
      class: 'switch',
      role: 'switch',
      'aria-checked': 'false',
      'aria-labelledby': `settings-${row.id}-label`,
      'aria-describedby': `settings-${row.id}-hint`,
      disabled: true,
      onclick: () => idleSetting && saveIdleSleep({ on: !idleSetting.on, minutes: idleSetting.minutes }),
    },
    idleWord,
    el('span', { class: 'switch-track', 'aria-hidden': 'true' }, el('span', { class: 'switch-thumb' })),
  );
  idleMinutes = el('input', {
    id: 'settings-idleSleep-minutes',
    class: 'set-minutes',
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'off',
    size: '5',
    disabled: true,
    'aria-describedby': 'settings-idleSleep-error',
    onchange: () => {
      const minutes = idleSleepMinutesFrom(idleMinutes.value);
      if (minutes === null) {
        idleProblem = { key: IDLE_SLEEP_SETTING.invalidKey };
        return renderIdleSleep({ keepField: true });
      }
      if (!idleSetting) return;
      if (minutes !== idleSetting.minutes) return saveIdleSleep({ on: idleSetting.on, minutes });
      // The saved value typed back after an invalid one: nothing to save, but the error goes.
      if (idleProblem) {
        idleProblem = null;
        renderIdleSleep();
      }
    },
  });
  idleLine = el('p', { class: 'settings-error', role: 'alert', id: 'settings-idleSleep-error' });
  return [
    el('div', { class: 'set-row' }, el('span', { class: 'set-label' }, rowLabel(row)), idleSwitch),
    el(
      'div',
      { class: 'set-row' },
      el('label', { class: 'set-label', for: 'settings-idleSleep-minutes', 'data-i18n': row.minutesKey }, t(row.minutesKey)),
      el('span', { class: 'set-field' }, idleMinutes, el('span', { 'data-i18n': row.unitKey, 'aria-hidden': 'true' }, t(row.unitKey))),
    ),
    idleLine,
  ];
}

async function readIdleSleep() {
  try {
    idleSetting = await api('GET', '/api/settings/idle-sleep');
    idleProblem = null;
  } catch (error) {
    idleProblem = { error: errorText(error) };
  }
  renderIdleSleep();
}

/** Saves `next` ({ on, minutes }); the server applies it at once. A refusal keeps the setting as it was. */
async function saveIdleSleep(next) {
  if (idleSaving) return;
  idleSaving = true;
  idleProblem = null;
  renderIdleSleep();
  try {
    idleSetting = await api('PUT', '/api/settings/idle-sleep', next);
  } catch (error) {
    idleProblem = { error: errorText(error) };
  } finally {
    idleSaving = false;
  }
  renderIdleSleep();
}

/** Draws the switch, the field (unless `keepField`: the user's text stays to be fixed) and the problem line. */
function renderIdleSleep({ keepField = false } = {}) {
  const view = idleSleepSwitchView(idleSetting, { busy: idleSaving });
  idleSwitch.setAttribute('aria-checked', String(view.checked));
  // While it saves the switch keeps the focus, so it is only aria-disabled then.
  idleSwitch.disabled = view.disabled && !view.busy;
  idleSwitch.setAttribute('aria-disabled', String(view.disabled));
  if (view.busy) idleSwitch.setAttribute('aria-busy', 'true');
  else idleSwitch.removeAttribute('aria-busy');
  idleWord.textContent = t(view.wordKey);
  idleMinutes.disabled = !idleSetting || idleSaving;
  if (!keepField) idleMinutes.value = view.minutes;
  idleMinutes.setAttribute('aria-invalid', String(!!idleProblem?.key));
  idleLine.textContent = idleProblem ? idleProblem.error ?? t(idleProblem.key) : '';
}

/* ---------- Sign out the other windows ---------- */

/** "Otras ventanas": its row with the button, and the line that says what the last sign-out did. */
function signOutParts() {
  const row = { id: 'signOut', ...SIGN_OUT_OTHERS };
  signOutButton = el(
    'button',
    { type: 'button', class: 'btn sm', 'aria-describedby': `settings-${row.id}-hint`, 'data-i18n': row.buttonKey, onclick: () => signOutOthers() },
    t(row.buttonKey),
  );
  signOutLine = el('p', { class: 'settings-result', role: 'status' });
  return [el('div', { class: 'set-row' }, el('span', { class: 'set-label' }, rowLabel(row)), signOutButton), signOutLine];
}

/** Asks, then clears every session but this window's; their terminals disconnect (src/server.ts). */
async function signOutOthers() {
  if (signingOut) return;
  const { title, message, confirmLabel, cancelLabel } = SIGN_OUT_OTHERS.confirm;
  const sure = await confirmDialog({ title: t(title), message: t(message), confirmLabel: t(confirmLabel), cancelLabel: t(cancelLabel), danger: true });
  if (!sure) return;
  signingOut = true;
  signOutButton.setAttribute('aria-busy', 'true');
  try {
    const { cleared } = await api('DELETE', '/api/session/others');
    signOutAnswer = { cleared };
  } catch (error) {
    signOutAnswer = { error: errorText(error) };
  } finally {
    signingOut = false;
    signOutButton.removeAttribute('aria-busy');
  }
  renderSignOut();
}

function renderSignOut() {
  if (!signOutAnswer) return void (signOutLine.textContent = '');
  signOutLine.classList.toggle('error', 'error' in signOutAnswer);
  if ('error' in signOutAnswer) return void (signOutLine.textContent = signOutAnswer.error);
  const { key, vars } = signOutResult(signOutAnswer.cleared);
  signOutLine.textContent = t(key, vars);
}

function renderTreeFollows() {
  const view = treeFollowsSwitchView(readTreeFollows(prefs));
  treeFollowsSwitch.setAttribute('aria-checked', String(view.checked));
  treeFollowsWord.textContent = t(view.wordKey);
}

function renderTheme() {
  for (const [value, pressed] of pressedChoices(SETTINGS_ROWS.find((row) => row.id === 'theme').choices, getTheme())) {
    sheet.querySelector(`button[data-theme-choice="${value}"]`)?.setAttribute('aria-pressed', String(pressed));
  }
}

function renderNight() {
  const { status, switching, error } = nightSwitchState();
  const view = nightSwitchView(status, { busy: switching });
  nightSwitch.setAttribute('aria-checked', String(view.checked));
  // While it saves the switch keeps the focus (toggleNight() ignores presses meanwhile), so it is
  // only aria-disabled then; without a status, or unavailable while off, it is disabled.
  nightSwitch.disabled = view.disabled && !view.busy;
  nightSwitch.setAttribute('aria-disabled', String(view.disabled));
  if (view.busy) nightSwitch.setAttribute('aria-busy', 'true');
  else nightSwitch.removeAttribute('aria-busy');
  nightWord.textContent = t(view.wordKey);
  nightError.textContent = error ?? '';
  $('#night-chip').hidden = !view.chip;
}

/* ---------- Open and close ---------- */

function setOpen(open, refocus) {
  sheet.hidden = !open;
  toggleButton.setAttribute('aria-expanded', String(open));
  if (open) [...sheet.querySelectorAll('button')].find((button) => !button.disabled && !button.closest('[hidden]'))?.focus();
  else if (refocus) toggleButton.focus();
}

function close(trigger, target) {
  const action = sheetCloses(trigger, {
    open: !sheet.hidden,
    inSheet: sheet.contains(target),
    onToggle: toggleButton.contains(target),
    // Turning the autopilot on opens a dialog over the sheet; a click there (or on a dialog
    // that just closed and is leaving the page) is not a click outside.
    inDialog: !target.isConnected || !!target.closest('dialog') || !!document.querySelector('dialog[open]'),
    focusInSheet: sheet.contains(document.activeElement),
  });
  if (action) setOpen(false, action.refocus);
}

/* ---------- Night status ---------- */

function startPolling() {
  if (timer || document.visibilityState !== 'visible') return;
  readNightStatus();
  timer = setInterval(readNightStatus, NIGHT_POLL_MS);
}

function stopPolling() {
  clearInterval(timer);
  timer = null;
}

export async function init() {
  toggleButton.addEventListener('click', () => setOpen(sheet.hidden, false));
  // Esc only while the focus is on the button or in the sheet: a terminal keeps its own Esc.
  toggleButton.parentElement.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close('escape', event.target);
  });
  document.addEventListener('click', (event) => close('click', event.target));
  sheet.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-theme-choice]');
    if (button) setTheme(button.dataset.themeChoice);
  });
  on('theme', renderTheme);
  on('night', renderNight);
  on('language', renderNight);
  on('language', renderTreeFollows);
  on('language', renderSignOut);
  on('language', () => renderIdleSleep({ keepField: true }));
  // Idle sleep applies in every mode.
  readIdleSleep();
  // Plain mode has no night shift (public/mode-model.js): its row hides and GET /api/night is never read.
  if (!showsExtra(state.config, 'night')) {
    nightSwitch.closest('.set-row').hidden = true;
    return;
  }
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? startPolling() : stopPolling()));
  startPolling();
}
