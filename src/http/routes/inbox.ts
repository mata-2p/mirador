import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeArgs, bridgeEnvProvider } from '../../attention/agent-args.ts';
import { prepareAgyHooks } from '../../attention/agy-hooks.ts';
import { prepareClaudeSettings } from '../../attention/claude-hooks.ts';
import { herdrEnvProvider, herdrPaths, prepareHerdrDir } from '../../attention/herdr.ts';
import { prepareOpencodePlugin } from '../../attention/opencode-plugin.ts';
import { listenForReports } from '../../attention/socket.ts';
import { AttentionStore, isTyping, type AttentionItem } from '../../attention/store.ts';
import { openAgentsOf } from '../../terminals/open-agents.ts';
import { LEFT_OFF_DAYS, runtimeDir, stateDir } from '../../config.ts';
import { LEFT_OFF_MAX_LINE_BYTES, LeftOffStore, leftOffDir } from '../../memory/left-off.ts';
import { provideNightAttention, whenNightService } from '../../night/service.ts';
import type { RouteModule } from '../context.ts';
import { HttpError, SECURITY_HEADERS, sendJson, sendNoContent } from '../respond.ts';
import { bearerToken, sessionClosers } from '../security.ts';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SHIM = join(APP_DIR, 'bin', 'herdr-shim');
const BRIDGE = join(APP_DIR, 'src', 'attention', 'gentle-shell-bridge.ts');
const CLAUDE_HOOK = join(APP_DIR, 'bin', 'claude-hook');
const OPENCODE_PLUGIN = join(APP_DIR, 'bin', 'opencode-plugin.js');
const AGY_HOOK = join(APP_DIR, 'bin', 'agy-hook');
const MAX_STREAMS = 16;
const HEARTBEAT_MS = 25_000;
/** How often an open stream re-checks the number of sleeping agents, so a forget in another window lands in a second. */
const SLEEPING_POLL_MS = 1_000;

/**
 * W4 attention inbox: agent terminals that wait for the user (a permission, a
 * question, a choice). Mirador stands in for herdr in agent terminals (see
 * src/attention/herdr.ts); if the socket cannot be opened (or another Mirador
 * serves it) the inbox stays empty and terminals start without the herdr
 * variables, exactly as before.
 *
 * GET /api/inbox              → { items: AttentionItem[], nightNotes: AttentionItem[] } (item kinds:
 *                               blocked, prompt, finished, and error from an OSC 7501 report)
 * GET /api/inbox/stream       → NDJSON: `{ items, nightNotes }` now and on every change, `{}` as a heartbeat.
 *                               A streamed fetch() body, because EventSource cannot send the token.
 * POST /api/inbox/:id/seen    → 204: the user activated terminal `id`, so its finished turn and its
 *                               night result leave the inbox (an agent waiting for an answer stays).
 *
 * Night states: `item.night` says what the night shift is doing or did for that card;
 * `nightNotes` are terminals with a night state and no card (see AttentionStore.night).
 */
export const inboxRoutes: RouteModule = async (ctx) => {
  const store = new AttentionStore();
  // The night shift reads which agents finished and what they work on.
  provideNightAttention(ctx.terminals, store);
  // The night routes register after this module: hear the night service once it exists.
  whenNightService(ctx.terminals, (night) => {
    const off = night.onTerminalState((state) => store.night(state));
    ctx.onShutdown(off);
  });
  for (const info of ctx.terminals.list()) store.track({ type: 'created', info });
  ctx.terminals.subscribe((event) => store.track(event));
  // OSC 7501: what an agent's program says itself in its output wins over its hooks (store.programStatus);
  // a new shell prompt (OSC 133 A) ends its working and blocked records and that terminal's hook wait
  // (store.programPrompt): the agent rcfile marks every prompt (src/terminals/agent-rc.ts), so they also
  // end when the agent exits or dies.
  ctx.terminals.onStatus((id, event) => (event.type === 'prompt' ? store.programPrompt(id) : store.programStatus(id, event.report)));
  // Typing into a terminal means the user is looking at it: its finished turn is seen.
  ctx.terminals.onInput((id, data) => {
    if (isTyping(data)) store.dismiss(id);
  });

  // "Where it left off" without Engram: Claude Code's hooks send `left-off` lines on the same socket
  // (src/memory/left-off.ts); this server validates and writes them. Expired records go now.
  const leftOff = new LeftOffStore({
    dir: leftOffDir(stateDir()),
    days: ctx.config.leftOffDays ?? LEFT_OFF_DAYS,
    enabled: ctx.config.leftOff !== false,
    terminal: (id) => ctx.terminals.get(id),
  });
  await leftOff.sweep().catch((error) => console.error(`mirador: expired left-off records could not be removed: ${(error as NodeJS.ErrnoException)?.code ?? 'error'}`));
  ctx.onShutdown(() => leftOff.flush());

  const paths = herdrPaths(runtimeDir());
  try {
    // A left-off line is read by its own store; every other line is an attention report (4096 bytes at most).
    const socket = await listenForReports(paths.socketPath, (line) => leftOff.receive(line) ?? store.receive(line), { maxLineBytes: LEFT_OFF_MAX_LINE_BYTES });
    ctx.onShutdown(async () => {
      socket.close();
      await rm(paths.socketPath, { force: true });
    });
    await prepareHerdrDir(paths, SHIM);
    ctx.terminals.addEnvProvider(herdrEnvProvider(paths));
    // The bridge tells Mirador when the agent waits; gentle-shell alone only reports its Todo title.
    // Claude Code's bridge is its hooks, in a settings file passed per launch.
    // opencode's is a plugin, named in its environment and loaded by the private server `--standalone` starts.
    // agy's is its hooks, in the `.agents/hooks.json` of a workspace folder added per launch with `--add-dir`.
    // kimi has none: its hooks live only in the user's own kimi config and plugins (src/agents/catalog.ts).
    const bridges = {
      pi: BRIDGE,
      'claude-code': await prepareClaudeSettings(paths.dir, CLAUDE_HOOK, process.execPath, { leftOff: ctx.config.leftOff !== false }),
      opencode: await prepareOpencodePlugin(paths.dir, OPENCODE_PLUGIN),
      antigravity: await prepareAgyHooks(paths.dir, AGY_HOOK),
    };
    ctx.terminals.addAgentArgs(bridgeArgs(ctx.config.agentCommand, bridges, ctx.config.attentionBridge));
    ctx.terminals.addEnvProvider(bridgeEnvProvider(ctx.config.agentCommand, bridges, ctx.config.attentionBridge));
    // claude, opencode or agy chosen beside another configured agent gets its bridge too.
    ctx.terminals.addChosenAgentArgs('claude-code', bridgeArgs('claude', bridges, ctx.config.attentionBridge));
    ctx.terminals.addChosenAgentArgs('opencode', bridgeArgs('opencode', bridges, ctx.config.attentionBridge));
    ctx.terminals.addChosenAgentArgs('antigravity', bridgeArgs('agy', bridges, ctx.config.attentionBridge));
  } catch (error) {
    console.error('attention inbox disabled, the herdr socket could not be opened:', error);
  }

  let streams = 0;
  return [
    { method: 'GET', path: '/api/inbox', handler: ({ res }) => sendJson(res, 200, { items: store.items(), nightNotes: store.nightNotes() }) },
    {
      method: 'POST',
      path: '/api/inbox/:id/seen',
      handler: ({ res, params }) => {
        store.dismiss(params.id);
        sendNoContent(res);
      },
    },
    {
      method: 'GET',
      path: '/api/inbox/stream',
      handler: ({ req, res }) => {
        if (streams >= MAX_STREAMS) throw new HttpError(429, 'too many inbox streams', 'inbox_busy');
        streams++;
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
        // `sleeping`: how many agents sleep right now. Another window can forget one (DELETE
        // /api/terminals/sleeping/:id) without touching the inbox, so a window watching only this
        // stream needs a reason to re-read the list; the count is that reason and costs one number
        // per message (#91).
        const sleepingCount = () => openAgentsOf(ctx.terminals)?.sleeping().length ?? 0;
        const send = (items: AttentionItem[], nightNotes: AttentionItem[]) =>
          res.write(JSON.stringify({ items, nightNotes, sleeping: sleepingCount() }) + '\n');
        send(store.items(), store.nightNotes());
        // Re-read on a short tick rather than on the heartbeat: a window that watches this stream
        // only learns about a forget elsewhere within a second, not within 25. The message is one
        // number, and only when it changed.
        let lastSleeping = sleepingCount();
        const sleepingTick = setInterval(() => {
          const count = sleepingCount();
          if (count === lastSleeping) return;
          lastSleeping = count;
          res.write(JSON.stringify({ sleeping: count }) + '\n');
        }, SLEEPING_POLL_MS);
        const unsubscribe = store.subscribe(send);
        const heartbeat = setInterval(() => res.write('{}\n'), HEARTBEAT_MS);
        let open = true;
        const stop = () => {
          if (!open) return;
          open = false;
          unsubscribe();
          clearInterval(heartbeat);
          clearInterval(sleepingTick);
          unregister();
          streams--;
        };
        // "Sign out the other windows" ends the stream of every session it forgets: nothing more is sent.
        const token = bearerToken(req.headers.authorization);
        const unregister =
          (token &&
            sessionClosers(ctx.terminals)?.add(token, () => {
              stop();
              res.end();
            })) ||
          (() => {});
        res.once('close', stop);
      },
    },
  ];
};
