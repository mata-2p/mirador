import type { TerminalEvent, TerminalInfo } from '../terminals/registry.ts';
import type { BlockedKind, ProgramState, ProgramStatusReport } from './osc7501.ts';

/**
 * What agent terminals report through Mirador's herdr stand-in (see herdr.ts).
 * Every report is a `herdr pane report-metadata` call the shim forwards as one
 * JSON line. Reports are data from processes in the terminal: they are
 * size-limited, validated and only ever shown as text.
 */

/**
 * The attention bridge (gentle-shell-bridge.ts) reports from this source, with
 * one token per case, so the cases stay apart:
 * - `blocked`: gentle-ai's `herdr:blocked` label (guarded command, questionnaire, choice);
 * - `prompt`: the title of any pi dialog the agent waits on (`ui_prompt_start`);
 * - `finished`: an id for the turn that just ended (`agent_settled`).
 *
 * Claude Code's hook (bin/claude-hook), opencode's plugin (bin/opencode-plugin.js) and agy's hook (bin/agy-hook)
 * report the same three from their events, plus `session`: the session id it resumes with (onSession).
 */
export const ATTENTION_SOURCE = 'mirador:attention';
export const BLOCKED_TOKEN = 'blocked';
export const PROMPT_TOKEN = 'prompt';
export const FINISHED_TOKEN = 'finished';
export const SESSION_TOKEN = 'session';
const FINISHED_LABEL = 'Finished';
/** gentle-shell's own herdr reporter: the in-progress Todo title, split over two tokens. */
export const ACTIVITY_SOURCE = 'gentle:activity';
const ACTIVITY_TOKENS = ['summary', 'summary2'];
/**
 * What a terminal's program says itself with OSC 7501 (the Program Status Protocol, osc7501.ts),
 * read by the terminal registry from the pty output (programStatus). While a terminal holds any
 * such record, its top record (oscTop) decides the agent's state and card over the hook reports
 * above, except that a hook wait (`blocked` or `prompt`) wins over a top record that ranks below
 * error: working, done or idle. An OSC `blocked` or `error` keeps deciding, so a
 * hook wait that arrives after an OSC `blocked` adds no second card. An OSC `done`, `idle` or
 * `clear`, or the end of an OSC `blocked` (the program saw the answer), ends the hook wait.
 * Once it holds no record (never reported, or `state=clear`), the hooks decide as before.
 *
 * Per turn: once an OSC `blocked` of kind permission has ended, a hook `prompt` that arrives
 * before the next turn starts is the late twin of that answered dialog (Claude's permission
 * Notification comes about 5.5 s after its OSC blocked), so it is not stored (Pane.permissionAnswered).
 * A hook `blocked` (gentle's question) is never suppressed.
 */
export const OSC_SOURCE = 'osc:7501';
/** Records one terminal keeps (the protocol asks for at least 64); the least recently updated goes first. */
const MAX_OSC_RECORDS = 64;
/** Which record speaks for the terminal when several are live: the one that needs the user most. */
const OSC_RANK: Record<ProgramState, number> = { idle: 1, done: 2, working: 3, error: 4, blocked: 5 };
/** The lowest OSC_RANK a hook wait does not override: an OSC error or blocked decides over it. */
const OSC_OVER_HOOK_WAIT = OSC_RANK.error;
/** idle and done are both "nothing runs": an idle agent waits for its next instruction, with no card. */
const OSC_AGENT_STATE: Record<ProgramState, AgentAttentionState> = { idle: 'finished', done: 'finished', working: 'working', error: 'error', blocked: 'waiting' };
const BLOCKED_LABEL = 'Awaiting input';
const ERROR_LABEL = 'Error';

export const MAX_LINE_BYTES = 4096;
const MAX_TOKENS = 8;
const MAX_RAW_VALUE = 512;
const MAX_SHOWN_VALUE = 160;
/**
 * Sources a pane keeps. The bridge and gentle-shell always have their slot; any other
 * source (a process in the terminal can report anything) gets at most two, so it
 * cannot crowd them out.
 */
const RESERVED_SOURCES = new Set([ATTENTION_SOURCE, ACTIVITY_SOURCE]);
const MAX_OTHER_SOURCES = 2;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * The bridge and gentle-shell number reports from the clock: Date.now() when they
 * start, +1 per report, one report (one shim process) at a time, so their seq stays at
 * or just above the clock. A seq more than MAX_SEQ_AHEAD past the later of the clock and
 * that source's stored seq is refused and never stored: a source on first contact is
 * capped by the clock, and a known one keeps counting on from its stored seq after the
 * clock steps back. A stored seq more than PLAUSIBLE_AHEAD past the clock was not sent
 * by them, or came before a step back: the next report at the clock replaces that
 * source's state, so reports that push the stored seq ahead cannot lock them out.
 */
const MAX_SEQ_AHEAD = 60_000;
const PLAUSIBLE_AHEAD = 1_000;

const PANE = /^[\w-]{1,64}$/;
const SOURCE = /^[a-z][\w.:-]{0,63}$/i;
const TOKEN = /^[a-z][\w-]{0,31}$/i;
/* eslint-disable no-control-regex */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁯﻿]/g;
/* eslint-enable no-control-regex */

/**
 * One terminal that needs the user, as GET /api/inbox answers it. `blocked` and
 * `prompt` wait for an answer; `finished` waits for a review and ranks below them.
 */
export interface AttentionItem {
  terminalId: string;
  workspaceId: string;
  rel: string;
  title: string;
  kind: 'blocked' | 'prompt' | 'finished' | 'error';
  /** Why it waits: the gentle-ai label, the dialog title, the OSC 7501 message, "Awaiting input", "Finished" or "Error". */
  label: string;
  /** The open dialog's title when a gentle-ai blocker has one; an OSC 7501 done or error message. */
  detail: string | null;
  /** OSC 7501 blocked only, when the program said: what it needs (approval, an answer, a login). */
  blockedKind?: BlockedKind;
  /** ISO time it started waiting (for an answer, or since the turn ended). */
  since: string;
  /** What the agent was working on (gentle-shell's active Todo), when it said so. */
  activity: string | null;
  /** What Mirador's night shift is doing or did for this terminal; absent when nothing. */
  night?: NightCard;
}

/** A night state as cards show it: never terminal output or memory text, only capped labels and reasons. */
export interface NightCard {
  state: 'deciding' | 'resolved' | 'deferred';
  /** What it was about: a dialog question, a finished agent's follow-up, or an execution note. */
  flow: NightFlow;
  /** Resolved: the chosen labels, the instruction sent, or the note delivered (≤ 120 characters); else ''. */
  summary: string;
  /** Deferred: the night service's rule id (`low-confidence`, `sensitive:push`…). */
  rule?: string;
  /** Deferred: why, in English (≤ 200 characters). */
  reason?: string;
  /** When this state began (ISO). */
  at: string;
}

export type NightFlow = 'question' | 'follow-up' | 'note';

/**
 * What an agent is doing as its reports tell (lazy restore):
 * - `waiting`: a `blocked` or `prompt` token (it waits for the user's answer);
 * - `finished`: a `finished` token, seen by the user or not (its turn is over, nothing runs);
 * - `working`: the bridge reported and holds no token (a turn under way, or a session that has
 *   not finished a turn yet: the bridge reports both the same way), or gentle-shell reports an
 *   in-progress Todo;
 * - `error`: its program reported OSC 7501 `state=error` (failed and stopped); hooks never say it;
 * - `unknown`: nothing reported yet (no bridge, or not yet started).
 * An OSC 7501 record, while one is live, decides instead of the hooks: blocked → waiting,
 * working → working, done and idle → finished, error → error (OSC_AGENT_STATE); but a hook
 * `blocked` or `prompt` token makes it `waiting` over a working, done or idle record.
 */
export type AgentAttentionState = 'working' | 'waiting' | 'finished' | 'error' | 'unknown';

/**
 * What the night service says about one terminal (NightService.onTerminalState). `cleared`:
 * a flow ended with nothing to show (its agent moved on, or its bridge left).
 */
export interface NightTerminalState {
  terminalId: string;
  state: NightCard['state'] | 'cleared';
  flow: NightFlow;
  summary: string;
  rule?: string;
  reason?: string;
  at: string;
}

/** How long a night note stays once its card is gone, unless the user sees the terminal first. */
export const NIGHT_NOTE_MS = 10 * 60_000;
const MAX_NIGHT_SUMMARY = 120;
const MAX_NIGHT_REASON = 200;
const MAX_NIGHT_RULE = 64;
const NIGHT_STATES = new Set(['deciding', 'resolved', 'deferred', 'cleared']);
const NIGHT_FLOWS = new Set(['question', 'follow-up', 'note']);

/** A pane's night state, with the card it rode on (kept for the note once that card is gone). */
interface PaneNight {
  card: NightCard;
  /** Store time it began, for the note's expiry. */
  atMs: number;
  /** It rode on a waiting card: once that card is gone, a deciding or deferred state goes with it. */
  bound: boolean;
  /**
   * The card it rode on, or what it stands for when none: a question with the answers (label ''),
   * a follow-up or a note with the finished (a note to an agent that had not finished: label '').
   */
  kind: AttentionItem['kind'];
  label: string;
  detail: string | null;
  since: string;
}

interface Report {
  pane: string;
  source: string;
  seq: number;
  ttlMs: number | null;
  tokens: Array<[string, string]>;
  clear: string[];
}

interface SourceState {
  seq: number;
  tokens: Map<string, string>;
  expiresAt: number | null;
}

/** One OSC 7501 record (the protocol's records, one per id; '' is the root). */
interface OscRecord {
  state: ProgramState;
  kind: BlockedKind | null;
  /** The decoded msg, cleaned like a hook label; null without one. */
  msg: string | null;
  /** Store time this state began: a report repeating the record's state keeps it. */
  since: number;
  /** A done or error record the user already saw (dismiss): its card stays hidden. */
  seen: boolean;
}

interface Pane {
  info: TerminalInfo;
  sources: Map<string, SourceState>;
  /** OSC_SOURCE: records by id, least recently updated first. */
  osc: Map<string, OscRecord>;
  answerSince: number | null;
  finished: { turn: string; since: number } | null;
  /** The finished turn the user already saw: it stays hidden even if reported again. */
  seenTurn: string | null;
  night: PaneNight | null;
  /** The state its last change told its listeners (onAgentState). */
  state: AgentAttentionState;
  /**
   * An OSC `blocked` of kind permission ended in this turn, so a hook `prompt` is suppressed (receive).
   * `closed`: the turn has since ended (OSC done or idle, or the hooks' `finished`, Claude's Stop).
   *
   * Turn boundaries, as the user set them: the suppression
   * lasts until the next turn STARTS, which is the first OSC `working` after one of those closing
   * signals; the closing signals alone do not end it, because the late Notification can come after the
   * turn ended. A `working` with no closing signal before it is the same turn (the one right
   * after the approval). The hooks cannot mark a turn start: bin/claude-hook sends UserPromptSubmit and
   * PostToolUse as the same report (clear blocked, prompt and finished). The agent leaving (the prompt
   * mark, programPrompt; or the terminal ending, which drops the pane) and an OSC `clear` reset it at once.
   * null: nothing to suppress.
   */
  permissionAnswered: { closed: boolean } | null;
}

/* eslint-disable no-control-regex */
/**
 * What a terminal sends by itself, not the user: focus in/out, cursor position,
 * device attributes, mode and keyboard-protocol reports, window size, colour
 * (OSC) and DCS replies, and mouse reports.
 */
const TERMINAL_REPLIES = /\x1b\[[IO]|\x1b\[\d+;\d+R|\x1b\[[?>=]?[\d;]*c|\x1b\[\?[\d;]*\$y|\x1b\[\?\d*u|\x1b\[[\d;]*t|\x1b\[<[\d;]*[Mm]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\/g;
/* eslint-enable no-control-regex */

/** True when terminal input holds something the user typed or pasted, not only automatic terminal replies. */
export function isTyping(data: string): boolean {
  return data.replace(TERMINAL_REPLIES, '').length > 0;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Plain one-line text: control, bidi and zero-width characters become spaces; capped. */
function clean(value: string, max = MAX_SHOWN_VALUE): string {
  const text = value.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

/**
 * Answers first (blocked, prompt and error), then finished turns; longest wait first in each. The
 * one inbox ordering: the browser's "needs you" group shows items in this order as received
 * (public/features/inbox-model.js inboxGroups) instead of sorting them again.
 */
function sortItems(items: AttentionItem[]): AttentionItem[] {
  const rank = (item: AttentionItem) => (item.kind === 'finished' ? 1 : 0); // an error waits with the answers
  return items.sort((a, b) => rank(a) - rank(b) || a.since.localeCompare(b.since) || a.terminalId.localeCompare(b.terminalId));
}

/** The report in `line`, or null when anything about it is off. Never throws. */
function parse(line: string): Report | null {
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.v !== 1 || value.cmd !== 'report-metadata') return null;
  const { pane, source, seq, ttlMs = null, tokens = {}, clear = [] } = value;
  if (typeof pane !== 'string' || !PANE.test(pane)) return null;
  if (typeof source !== 'string' || !SOURCE.test(source)) return null;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return null;
  if (ttlMs !== null && (typeof ttlMs !== 'number' || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS)) return null;
  if (!isRecord(tokens) || !Array.isArray(clear)) return null;
  const entries = Object.entries(tokens);
  if (entries.length > MAX_TOKENS || clear.length > MAX_TOKENS) return null;
  for (const [key, text] of entries) {
    if (!TOKEN.test(key) || typeof text !== 'string' || text.length > MAX_RAW_VALUE) return null;
  }
  if (!clear.every((key) => typeof key === 'string' && TOKEN.test(key))) return null;
  return { pane, source, seq, ttlMs, tokens: entries as Array<[string, string]>, clear: clear as string[] };
}

/**
 * Which agent terminals are waiting for the user, fed by terminal lifecycle events
 * (`track`) and herdr reports (`receive`). Only running agent terminals count;
 * a terminal that exits or closes is forgotten with everything it reported.
 *
 * Night states (`night`) ride on the terminal's waiting card. A terminal with a
 * night state and no card is a night note (`nightNotes`): a question still being decided
 * or deferred before its dialog opens, or a result whose card is gone (the agent moved
 * on). A deciding or deferred state that rode on a card leaves with it; a result stays
 * NIGHT_NOTE_MS, or until the user sees the terminal (`dismiss`).
 */
export class AttentionStore {
  private readonly panes = new Map<string, Pane>();
  private readonly listeners = new Set<(items: AttentionItem[], nightNotes: AttentionItem[], states: Record<string, AgentAttentionState>) => void>();
  private readonly stateListeners = new Set<(terminalId: string, state: AgentAttentionState) => void>();
  private readonly sessionListeners = new Set<(terminalId: string, session: string) => void>();
  private readonly now: () => number;
  private last = '[[],[],{}]';
  /** Pushes the change when the next report expires (its herdr TTL). */
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private expiryAt: number | null = null;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Feed with TerminalRegistry.subscribe. */
  track(event: TerminalEvent): void {
    const { info } = event;
    if (event.type === 'created') {
      if (info.kind === 'agent' && info.status === 'running') this.panes.set(info.id, { info: { ...info }, sources: new Map(), osc: new Map(), answerSince: null, finished: null, seenTurn: null, night: null, state: 'unknown', permissionAnswered: null });
    } else {
      this.panes.delete(info.id);
    }
    this.changed();
  }

  /** Applies one report line. True when it was valid, current and for a running agent terminal. */
  receive(line: string): boolean {
    const report = parse(line);
    const pane = report && this.panes.get(report.pane);
    if (!report || !pane) return false;
    const now = this.now();
    let state = pane.sources.get(report.source);
    if (report.seq > Math.max(now, state?.seq ?? now) + MAX_SEQ_AHEAD) return false;
    if (state && report.seq <= state.seq) {
      const recovers = state.seq > now + PLAUSIBLE_AHEAD && report.seq <= now + PLAUSIBLE_AHEAD;
      if (!recovers) return false;
      // What that source held came from whoever sent the implausible seq: start over.
      state.tokens = new Map();
    }
    if (!state) {
      const others = [...pane.sources.keys()].filter((source) => !RESERVED_SOURCES.has(source)).length;
      if (!RESERVED_SOURCES.has(report.source) && others >= MAX_OTHER_SOURCES) return false;
      state = { seq: report.seq, tokens: new Map(), expiresAt: null };
      pane.sources.set(report.source, state);
    }
    state.seq = report.seq;
    const hooks = report.source === ATTENTION_SOURCE;
    // The late permission Notification of a dialog OSC already saw answered, this turn. Only a
    // prompt that arrives alone is dropped; one sent with a blocked keeps its text on that card.
    const latePrompt = hooks && pane.permissionAnswered !== null && !report.tokens.some(([key]) => key === BLOCKED_TOKEN);
    for (const key of report.clear) state.tokens.delete(key);
    for (const [key, raw] of report.tokens) {
      if (latePrompt && key === PROMPT_TOKEN) continue;
      const text = clean(raw);
      if (text) state.tokens.set(key, text);
      else state.tokens.delete(key);
    }
    state.expiresAt = report.ttlMs === null ? null : this.now() + report.ttlMs;
    const session = report.source === ATTENTION_SOURCE && report.tokens.some(([key]) => key === SESSION_TOKEN) ? this.token(pane, ATTENTION_SOURCE, SESSION_TOKEN) : null;
    const answer = this.token(pane, ATTENTION_SOURCE, BLOCKED_TOKEN) ?? this.token(pane, ATTENTION_SOURCE, PROMPT_TOKEN);
    if (answer === null) pane.answerSince = null;
    else pane.answerSince ??= this.now();
    const turn = this.token(pane, ATTENTION_SOURCE, FINISHED_TOKEN);
    if (turn === null) pane.finished = null;
    else if (pane.finished?.turn !== turn) pane.finished = { turn, since: this.now() };
    // The hooks' Stop closes the turn; the suppression still holds until the next one starts.
    if (hooks && pane.permissionAnswered && report.tokens.some(([key]) => key === FINISHED_TOKEN)) pane.permissionAnswered.closed = true;
    this.changed();
    if (session !== null) {
      for (const listener of this.sessionListeners) {
        try {
          listener(report.pane, session);
        } catch (error) {
          console.error('agent session listener failed:', error);
        }
      }
    }
    return true;
  }

  /**
   * Applies one OSC 7501 report its program printed (TerminalRegistry.onStatus; validated by
   * osc7501.ts): it replaces the record with its id, or `clear` removes that record and every one
   * beneath it (all of them without an id). True when it was for a running agent terminal.
   *
   * Only the root record (id '') ends a hook wait with its `done`, `idle` or `clear`:
   * a child's `done` or `idle` leaves the wait open, and so does a `clear` scoped to an id,
   * unless it removes the blocked top and no other record stays blocked (that blocked
   * was the wait, the same test as a blocked top that ends below).
   */
  programStatus(terminalId: string, report: ProgramStatusReport): boolean {
    const pane = this.panes.get(terminalId);
    if (!pane || !isRecord(report) || typeof report.id !== 'string') return false;
    if (report.state === 'clear') {
      const before = this.oscTop(pane);
      for (const id of [...pane.osc.keys()]) if (report.id === '' || id === report.id || id.startsWith(`${report.id}/`)) pane.osc.delete(id);
      pane.permissionAnswered = null;
      // A root clear ends the hook wait; a scoped one ends it only when the blocked top went with it.
      if (report.id === '' || (before?.state === 'blocked' && this.oscTop(pane)?.state !== 'blocked')) this.endHookWait(pane);
      this.changed();
      return true;
    }
    if (!Object.hasOwn(OSC_RANK, report.state)) return false;
    const before = this.oscTop(pane);
    const previous = pane.osc.get(report.id);
    const same = previous?.state === report.state;
    const record: OscRecord = {
      state: report.state,
      kind: report.state === 'blocked' && report.kind ? report.kind : null,
      msg: typeof report.msg === 'string' ? clean(report.msg) || null : null,
      since: same ? previous!.since : this.now(),
      seen: same ? previous!.seen : false,
    };
    pane.osc.delete(report.id);
    pane.osc.set(report.id, record);
    while (pane.osc.size > MAX_OSC_RECORDS) pane.osc.delete(pane.osc.keys().next().value!);
    this.trackPermissionTurn(pane, previous, record);
    // The root record's done and idle say nothing waits any more (a child's say only that child
    // stopped, so they leave the wait open); a blocked top that ends, from any id, was answered, and
    // a hook wait under it was the same wait (Claude reports its permission by both, OSC first).
    const rootStopped = report.id === '' && (report.state === 'done' || report.state === 'idle');
    if (rootStopped || (before?.state === 'blocked' && this.oscTop(pane)?.state !== 'blocked')) this.endHookWait(pane);
    this.changed();
    return true;
  }

  /**
   * A new shell prompt began in terminal `terminalId` (OSC 133 A): as the protocol says, its working
   * and blocked OSC 7501 records go; done, error and idle stay. True for a running agent terminal.
   * Agent terminals mark every prompt their bash draws (src/terminals/agent-rc.ts), so this is also
   * how an agent that exits or dies without a last report loses its working or blocked record.
   *
   * The prompt also ends the wait its hooks reported: this terminal's `blocked`
   * and `prompt` tokens go, so the card leaves instead of showing (and notifying) again. Only this
   * terminal's: every hook report names the one terminal it came from (`pane`, the HERDR_PANE_ID of
   * that pty, herdr.ts), and Mirador never attributes a report by folder, so the prompt of a terminal
   * never touches another terminal in the same folder. A finished turn stays.
   *
   * Unless it holds a finished turn, this terminal's last hook report no longer stands either (it
   * expires now), whether or not a wait was open: a turn cut without Stop (an
   * interrupt, a crash) left the hooks' `working` with no expiry, and the agent that left reads
   * `unknown`, not `working`, until its next report. Same per-terminal attribution as above.
   */
  programPrompt(terminalId: string): boolean {
    const pane = this.panes.get(terminalId);
    if (!pane) return false;
    for (const [id, record] of [...pane.osc]) if (record.state === 'working' || record.state === 'blocked') pane.osc.delete(id);
    pane.permissionAnswered = null; // the agent left: the rule starts over
    this.endHookWait(pane);
    const hooks = pane.sources.get(ATTENTION_SOURCE);
    if (hooks && this.token(pane, ATTENTION_SOURCE, FINISHED_TOKEN) === null) hooks.expiresAt = this.now();
    this.changed();
    return true;
  }

  /**
   * The turn bookkeeping for one OSC report whose `record` replaced `previous` (see Pane.permissionAnswered):
   * the first `working` after a closing signal starts the next turn and ends the suppression; a permission
   * `blocked` that ends starts it; `done` and `idle` close the turn without ending it.
   */
  private trackPermissionTurn(pane: Pane, previous: OscRecord | undefined, record: OscRecord): void {
    const permission = (r: OscRecord | undefined) => r?.state === 'blocked' && r.kind === 'permission';
    if (record.state === 'working' && pane.permissionAnswered?.closed) pane.permissionAnswered = null;
    if (permission(previous) && !permission(record)) pane.permissionAnswered = { closed: false };
    if ((record.state === 'done' || record.state === 'idle') && pane.permissionAnswered) pane.permissionAnswered.closed = true;
  }

  /**
   * Ends the wait the hooks reported (their `blocked` and `prompt` tokens): a prompt mark (programPrompt)
   * or an OSC 7501 report that says the program waits no more (programStatus). True when one was there.
   */
  private endHookWait(pane: Pane): boolean {
    const hooks = pane.sources.get(ATTENTION_SOURCE);
    if (!hooks || !this.hookWaits(pane)) return false;
    hooks.tokens.delete(BLOCKED_TOKEN);
    hooks.tokens.delete(PROMPT_TOKEN);
    pane.answerSince = null;
    return true;
  }

  /**
   * The user saw the terminal (activated it, typed into it): its finished turn
   * (and an OSC 7501 done or error) leaves the inbox. A terminal waiting for an
   * answer is never dismissed. True when something was dismissed.
   */
  dismiss(terminalId: string): boolean {
    const pane = this.panes.get(terminalId);
    if (!pane) return false;
    let dismissed = false;
    // A result, or a note with no card yet, has been seen; a deferral on a card stays with that card.
    if (pane.night && (pane.night.card.state === 'resolved' || (!pane.night.bound && pane.night.card.state === 'deferred'))) {
      pane.night = null;
      dismissed = true;
    }
    if (pane.finished && pane.seenTurn !== pane.finished.turn) {
      pane.seenTurn = pane.finished.turn;
      dismissed = true;
    }
    for (const record of pane.osc.values()) {
      if ((record.state === 'done' || record.state === 'error') && !record.seen) {
        record.seen = true;
        dismissed = true;
      }
    }
    if (dismissed) this.changed();
    return dismissed;
  }

  /**
   * Applies what the night service says about a terminal (NightService.onTerminalState).
   * True when it was well-formed and for a running agent terminal.
   */
  night(update: NightTerminalState): boolean {
    const pane = isRecord(update) && typeof update.terminalId === 'string' ? this.panes.get(update.terminalId) : undefined;
    if (!pane || !NIGHT_STATES.has(update.state) || !NIGHT_FLOWS.has(update.flow)) return false;
    if (update.state === 'cleared') {
      if (pane.night?.card.state === 'deciding') pane.night = null;
      this.changed();
      return true;
    }
    const now = this.now();
    const card: NightCard = { state: update.state, flow: update.flow, summary: typeof update.summary === 'string' ? clean(update.summary, MAX_NIGHT_SUMMARY) : '', at: new Date(now).toISOString() };
    if (update.state === 'deferred') {
      if (typeof update.rule === 'string' && clean(update.rule, MAX_NIGHT_RULE)) card.rule = clean(update.rule, MAX_NIGHT_RULE);
      if (typeof update.reason === 'string' && clean(update.reason, MAX_NIGHT_REASON)) card.reason = clean(update.reason, MAX_NIGHT_REASON);
    }
    const waiting = this.waiting(pane);
    pane.night = waiting
      ? { card, atMs: now, bound: true, kind: waiting.kind, label: waiting.label, detail: waiting.detail, since: new Date(waiting.since).toISOString() }
      : pane.night && pane.night.card.state !== 'resolved'
        // Still no card: keep where the earlier state showed it.
        ? { ...pane.night, card, atMs: now }
        : { card, atMs: now, bound: false, kind: update.flow === 'question' ? 'prompt' : 'finished', label: update.flow === 'follow-up' ? FINISHED_LABEL : '', detail: null, since: card.at };
    this.changed();
    return true;
  }

  /** Terminals waiting for the user: answers first, then finished turns; longest wait first in each. */
  items(): AttentionItem[] {
    const items: AttentionItem[] = [];
    for (const pane of this.panes.values()) {
      const item = this.waiting(pane);
      if (!item) continue;
      const activity = this.activity(pane);
      const { id, workspaceId, rel, title } = pane.info;
      const shown: AttentionItem = { terminalId: id, workspaceId, rel, title, ...item, since: new Date(item.since).toISOString(), activity };
      const night = this.liveNight(pane);
      if (night) shown.night = { ...night.card };
      items.push(shown);
    }
    return sortItems(items);
  }

  /**
   * Night notes: terminals with a night state but no waiting card, shaped like the card
   * they had (or stand for), with `night` always set. Same order as items().
   */
  nightNotes(): AttentionItem[] {
    const notes: AttentionItem[] = [];
    for (const pane of this.panes.values()) {
      const night = this.liveNight(pane);
      if (!night || this.waiting(pane) || (night.bound && night.card.state !== 'resolved')) continue;
      const { id, workspaceId, rel, title } = pane.info;
      notes.push({ terminalId: id, workspaceId, rel, title, kind: night.kind, label: night.label, detail: night.detail, since: night.since, activity: this.activity(pane), night: { ...night.card } });
    }
    return sortItems(notes);
  }

  /** Calls `listener` with the new items, night notes and agent states whenever any of them changes. Returns an unsubscribe function. */
  subscribe(listener: (items: AttentionItem[], nightNotes: AttentionItem[], states: Record<string, AgentAttentionState>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** What agent `terminalId` is doing (AgentAttentionState); `unknown` for a terminal it does not follow. */
  agentState(terminalId: string): AgentAttentionState {
    const pane = this.panes.get(terminalId);
    if (!pane) return 'unknown';
    const osc = this.oscDecides(pane);
    if (osc) return OSC_AGENT_STATE[osc.state];
    if (this.hookWaits(pane)) return 'waiting';
    if (this.token(pane, ATTENTION_SOURCE, FINISHED_TOKEN) !== null) return 'finished';
    const attention = pane.sources.get(ATTENTION_SOURCE);
    if ((attention && (attention.expiresAt === null || attention.expiresAt > this.now())) || this.activity(pane)) return 'working';
    return 'unknown';
  }

  /**
   * Every followed terminal's state, by id: what a window uses when an agent has no inbox card.
   *
   * The inbox alone cannot say this. A card leaves the inbox once it is read or answered, and the
   * agent goes on being finished or in error; the sidebar, tabs and panes read this instead (#12).
   */
  agentStates(): Record<string, AgentAttentionState> {
    const states: Record<string, AgentAttentionState> = {};
    for (const id of this.panes.keys()) {
      const state = this.agentState(id);
      // Only the states a window cannot already assume. Its fallback for an agent it has no entry
      // for is working, so 'working' and 'unknown' add nothing; naming them would make a fresh
      // terminal, or an activity line, push a message whose cards did not change.
      if (state === 'waiting' || state === 'finished' || state === 'error') states[id] = state;
    }
    return states;
  }

  /**
   * Why agent `terminalId` must not be put to sleep for idling even though its turn is finished (idle
   * sleep), or null: `todo` while gentle-shell reports
   * an in-progress Todo, `night` while the night shift decides something for it or left it for the user.
   */
  idleHold(terminalId: string): 'todo' | 'night' | null {
    const pane = this.panes.get(terminalId);
    if (!pane) return null;
    if (this.activity(pane)) return 'todo';
    const night = this.liveNight(pane);
    return night && night.card.state !== 'resolved' ? 'night' : null;
  }

  /** Calls `listener` whenever a running agent's state changes (not when it opens or goes). Returns an unsubscribe function. */
  onAgentState(listener: (terminalId: string, state: AgentAttentionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /**
   * Calls `listener` with the session id each report of a running agent's hooks names (the `session`
   * token, unvalidated; claude-code's `session_id`, opencode's `sessionID`, agy's `conversationId`). Returns an unsubscribe function.
   */
  onSession(listener: (terminalId: string, session: string) => void): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  /** The pane's waiting card, before it is shaped as an item; null when it waits for nothing. */
  private waiting(pane: Pane): (Pick<AttentionItem, 'kind' | 'label' | 'detail' | 'blockedKind'> & { since: number }) | null {
    const osc = this.oscDecides(pane);
    if (osc) {
      if (osc.state === 'blocked') return { kind: 'blocked', label: osc.msg ?? BLOCKED_LABEL, detail: null, since: osc.since, ...(osc.kind ? { blockedKind: osc.kind } : {}) };
      if (osc.seen) return null;
      if (osc.state === 'error') return { kind: 'error', label: ERROR_LABEL, detail: osc.msg, since: osc.since };
      if (osc.state === 'done') return { kind: 'finished', label: FINISHED_LABEL, detail: osc.msg, since: osc.since };
      return null;
    }
    const blocked = this.token(pane, ATTENTION_SOURCE, BLOCKED_TOKEN);
    const prompt = this.token(pane, ATTENTION_SOURCE, PROMPT_TOKEN);
    const finished = pane.finished && this.token(pane, ATTENTION_SOURCE, FINISHED_TOKEN) !== null && pane.finished.turn !== pane.seenTurn ? pane.finished : null;
    if (blocked !== null && pane.answerSince !== null) return { kind: 'blocked', label: blocked, detail: prompt, since: pane.answerSince };
    if (prompt !== null && pane.answerSince !== null) return { kind: 'prompt', label: prompt, detail: null, since: pane.answerSince };
    if (finished) return { kind: 'finished', label: FINISHED_LABEL, detail: null, since: finished.since };
    return null;
  }

  /** The OSC 7501 record that decides the pane's state and card: its top one, unless a hook wait outranks it. */
  private oscDecides(pane: Pane): OscRecord | null {
    const top = this.oscTop(pane);
    return top && OSC_RANK[top.state] < OSC_OVER_HOOK_WAIT && this.hookWaits(pane) ? null : top;
  }

  /** The hooks report a wait for the user's answer (a `blocked` or `prompt` token). */
  private hookWaits(pane: Pane): boolean {
    return this.token(pane, ATTENTION_SOURCE, BLOCKED_TOKEN) !== null || this.token(pane, ATTENTION_SOURCE, PROMPT_TOKEN) !== null;
  }

  /** The OSC 7501 record that speaks for the pane (highest OSC_RANK, longest in its state); null with none. */
  private oscTop(pane: Pane): OscRecord | null {
    let top: OscRecord | null = null;
    for (const record of pane.osc.values()) {
      if (!top || OSC_RANK[record.state] > OSC_RANK[top.state] || (OSC_RANK[record.state] === OSC_RANK[top.state] && record.since < top.since)) top = record;
    }
    return top;
  }

  private activity(pane: Pane): string | null {
    return ACTIVITY_TOKENS.map((key) => this.token(pane, ACTIVITY_SOURCE, key)).filter((text) => text !== null).join(' ') || null;
  }

  /** The pane's night state unless its note time is over (a result, or a state that never found a card). */
  private liveNight(pane: Pane): PaneNight | null {
    const night = pane.night;
    if (!night) return null;
    return this.nightExpiry(night) !== null && this.nightExpiry(night)! <= this.now() ? null : night;
  }

  /** When a night state stops showing by itself, or null while it lives as long as its card. */
  private nightExpiry(night: PaneNight): number | null {
    return night.card.state === 'resolved' || !night.bound ? night.atMs + NIGHT_NOTE_MS : null;
  }

  /** Binds night states to the card that appeared, drops the ones whose card or time is gone. */
  private settleNight(): void {
    for (const pane of this.panes.values()) {
      const night = pane.night;
      if (!night) continue;
      if (!this.liveNight(pane)) {
        pane.night = null;
        continue;
      }
      const waiting = this.waiting(pane);
      if (waiting) {
        Object.assign(night, { bound: true, kind: waiting.kind, label: waiting.label, detail: waiting.detail, since: new Date(waiting.since).toISOString() });
      } else if (night.bound && night.card.state !== 'resolved') {
        pane.night = null;
      }
    }
  }

  private token(pane: Pane, source: string, key: string): string | null {
    const state = pane.sources.get(source);
    if (!state || (state.expiresAt !== null && state.expiresAt <= this.now())) return null;
    return state.tokens.get(key) ?? null;
  }

  /** Arms one timer for the earliest report still to expire, so its expiry reaches subscribers. */
  private scheduleExpiry(): void {
    const now = this.now();
    let next: number | null = null;
    for (const pane of this.panes.values()) {
      for (const state of pane.sources.values()) {
        if (state.expiresAt !== null && state.expiresAt > now && (next === null || state.expiresAt < next)) next = state.expiresAt;
      }
      const noteEnd = pane.night ? this.nightExpiry(pane.night) : null;
      if (noteEnd !== null && noteEnd > now && (next === null || noteEnd < next)) next = noteEnd;
    }
    if (next === this.expiryAt) return;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.expiryAt = next;
    if (next === null) return;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.expiryAt = null;
      this.changed();
    }, next - now);
    this.expiryTimer.unref?.();
  }

  private changed(): void {
    this.settleNight();
    this.scheduleExpiry();
    for (const [id, pane] of this.panes) {
      const state = this.agentState(id);
      if (state === pane.state) continue;
      pane.state = state;
      for (const listener of this.stateListeners) {
        try {
          listener(id, state);
        } catch (error) {
          console.error('agent state listener failed:', error);
        }
      }
    }
    const items = this.items();
    const nightNotes = this.nightNotes();
    // The states are part of what a window reads, so a state that changes while no card does still
    // reaches it (#12).
    const states = this.agentStates();
    const snapshot = JSON.stringify([items, nightNotes, states]);
    if (snapshot === this.last) return;
    this.last = snapshot;
    for (const listener of this.listeners) {
      try {
        listener(items, nightNotes, states);
      } catch (error) {
        console.error('inbox listener failed:', error);
      }
    }
  }
}
