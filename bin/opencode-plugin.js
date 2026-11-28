// Mirador's opencode plugin. Mirador copies it to
// <runtime>/mirador/herdr/opencode-plugin/index.js and starts opencode with `--standalone` and
// OPENCODE_CONFIG_CONTENT naming that folder (src/attention/opencode-plugin.ts), so opencode 2.0.0 or newer loads
// it (an older opencode gets neither, src/agents/opencode-version.ts) in
// that terminal's private server, which inherits the terminal's herdr variables. It follows the server's
// events (https://opencode.ai/docs/build/plugins/server/#events) and reports the agent's attention state
// as bin/claude-hook does, as one herdr report-metadata line to $HERDR_SOCKET_PATH for pane $HERDR_PANE_ID,
// from source mirador:attention:
//   session.execution.started                       working   clears blocked, prompt and finished
//   permission.asked                                waiting   prompt=<its message, or the action>
//   form.created (the question tool)                waiting   prompt=<its title>
//   permission.replied, form.replied/cancelled      working   clears blocked and prompt
//   session.execution.succeeded/failed, interrupted finished  finished=<turn id>; a superseded or shutdown interrupt changes nothing
// Only root sessions start or finish a turn and name session=<sessionID>, which Mirador records to resume
// with `--session <id>`; a subagent's session (session.created with a parentID) only waits. Like
// bin/claude-hook it must never get in the agent's way: it never throws into opencode and drops a report
// it cannot send within a second.
import { createConnection } from 'node:net';

const MAX_LINE_BYTES = 4096;
/** Mirador refuses a token value over 512 characters, so the message is cut before that. */
const MAX_MESSAGE = 500;
const TIMEOUT_MS = 1000;
const SOURCE = 'mirador:attention';
const PANE = /^[\w-]{1,64}$/;
/** As SESSION_ID in src/agents/catalog.ts: a letter or digit first, so never an option. */
const SESSION_ID = /^[A-Za-z0-9][\w-]{0,127}$/;
const DEFAULT_PROMPT = 'opencode needs your input';
const EVENTS = [
  'session.created',
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
  'permission.asked',
  'permission.replied',
  'form.created',
  'form.replied',
  'form.cancelled',
];
/** Interrupts that end nothing the user waits on: a new prompt took over, or opencode is closing. */
const QUIET_INTERRUPTS = new Set(['superseded', 'shutdown']);
const SEEN_LIMIT = 256;

// opencode may set the plugin up once per project location in one server; they share these, so each event
// (by its id) is reported once and every report gets a new seq.
const subagents = new Set();
const seen = new Set();
let lastSeq = 0;

const text = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE) : '');

/** The tokens and cleared tokens `event` reports, or null when it reports nothing. */
function reportOf(event, seq) {
  const data = event.data;
  if (typeof data !== 'object' || data === null) return null;
  const sessionID = event.type === 'form.created' ? data.form?.sessionID : data.sessionID;
  if (typeof sessionID !== 'string') return null;
  if (event.type === 'session.created') {
    if (typeof data.parentID === 'string') subagents.add(sessionID);
    return null;
  }
  const root = !subagents.has(sessionID);
  const session = root && SESSION_ID.test(sessionID) ? { session: sessionID } : {};
  switch (event.type) {
    case 'session.execution.started':
      return root ? { tokens: session, clear: ['blocked', 'prompt', 'finished'] } : null;
    case 'permission.asked': {
      const action = text(data.action);
      return { tokens: { ...session, prompt: text(data.message) || (action ? `opencode asks permission: ${action}` : DEFAULT_PROMPT) }, clear: ['blocked', 'finished'] };
    }
    case 'form.created':
      return { tokens: { ...session, prompt: text(data.form.title) || DEFAULT_PROMPT }, clear: ['blocked', 'finished'] };
    case 'permission.replied':
    case 'form.replied':
    case 'form.cancelled':
      return { tokens: session, clear: ['blocked', 'prompt'] };
    case 'session.execution.interrupted':
      if (QUIET_INTERRUPTS.has(data.reason)) return null;
    // falls through
    case 'session.execution.succeeded':
    case 'session.execution.failed':
      return root ? { tokens: { ...session, finished: String(seq) }, clear: ['blocked', 'prompt'] } : null;
    default:
      return null;
  }
}

/** True the first time an event id comes by (events without one always count). */
function firstSight(event) {
  if (typeof event.id !== 'string') return true;
  if (seen.has(event.id)) return false;
  seen.add(event.id);
  if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value);
  return true;
}

function send(socket, line) {
  const conn = createConnection(socket);
  const timer = setTimeout(() => conn.destroy(), TIMEOUT_MS);
  conn.on('error', () => {});
  conn.on('close', () => clearTimeout(timer));
  conn.on('connect', () => conn.end(line));
}

export default {
  id: 'mirador.attention',
  setup(ctx) {
    const pane = process.env.HERDR_PANE_ID;
    const socket = process.env.HERDR_SOCKET_PATH;
    if (!pane || !PANE.test(pane) || !socket) return undefined;
    const controller = new AbortController();
    const follow = async () => {
      for await (const event of ctx.event.subscribe({ types: EVENTS, signal: controller.signal })) {
        try {
          if (typeof event !== 'object' || event === null || !firstSight(event)) continue;
          // Numbered from the clock, as the bridge's reports are, and always past the last one.
          const seq = Math.max(Date.now(), lastSeq + 1);
          const report = reportOf(event, seq);
          if (!report) continue;
          lastSeq = seq;
          const line = JSON.stringify({ v: 1, cmd: 'report-metadata', pane, source: SOURCE, seq, ttlMs: null, ...report }) + '\n';
          if (Buffer.byteLength(line) <= MAX_LINE_BYTES) send(socket, line);
        } catch {
          // Best effort only: a report that cannot be built or sent is dropped.
        }
      }
    };
    follow().catch(() => {});
    return () => controller.abort();
  },
};
