import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { IDLE_SLEEP_HOURS, configPath, loadConfig, runtimeDir, saveSettings } from './config.ts';
import { agentLaunch } from './agents/catalog.ts';
import { resumeArgs } from './attention/agent-args.ts';
import { AttentionStore } from './attention/store.ts';
import { nightAttention, nightService, whenNightService } from './night/service.ts';
import { OpenAgents, openAgentsPath, provideOpenAgents, stopPreviousScopes } from './terminals/open-agents.ts';
import { IdleSleep } from './terminals/hibernate.ts';
import { InvalidFolderError } from './folders/tree.ts';
import { EngramClient, EngramUnavailableError } from './memory/engram.ts';
import { configureCallMeter, configurePiConcurrency, configurePiHold } from './memory/translate.ts';
import { formatDay, parseDay, type AppContext, type RouteModule } from './http/context.ts';
import { createWebBundle } from './http/bundle.ts';
import { HttpError, SECURITY_HEADERS, readJson, sendJson } from './http/respond.ts';
import { Router } from './http/router.ts';
import { bootstrapRoute } from './http/routes/bootstrap.ts';
import { signOutOthersRoute } from './http/routes/session.ts';
import { configRoutes } from './http/routes/config.ts';
import { summaryRoutes } from './http/routes/summary.ts';
import { clampSize, terminalRoutes } from './http/routes/terminals.ts';
import { treeRoutes } from './http/routes/tree.ts';
import { workspaceRoutes } from './http/routes/workspaces.ts';
// Wave 2: each unit adds its import on the line under its own marker (docs/extending.md).
// W3 overview
import { overviewRoutes } from './http/routes/overview.ts';

// W4 inbox
import { inboxRoutes } from './http/routes/inbox.ts';

// W5 files
import { fileRoutes } from './http/routes/files.ts';

// Night
import { createNightRoutes } from './http/routes/night.ts';
import { createDecider, engramFeedback } from './night/decider.ts';

// Night report
import { createNightReportRoutes, type NightStatusView } from './http/routes/night-report.ts';

// Profile
import { profileRoutes } from './http/routes/profile.ts';
import { resourceRoutes } from './http/routes/resources.ts';
import { CallBudget, CallTelemetry, callMeter, dayIn, jornadaOf, provideCallAccounting } from './night/budget.ts';
import { nightScheduler } from './night/schedule.ts';
import { ResourceProfiles, provideProfiles, resourceProfiles } from './profiles.ts';

// MCP per project
import { mcpRoutes } from './http/routes/mcp.ts';
// Plain-mode git: a folder's read-only git state and NOTES.md.
import { gitStatusRoutes } from './http/routes/git-status.ts';
// Changes panel: a folder's read-only diff against HEAD.
import { gitDiffRoutes } from './http/routes/git-diff.ts';

import {
  APP_PROTOCOL,
  LaunchNonces,
  SessionClosers,
  Sessions,
  bearerToken,
  createToken,
  isAllowedHost,
  isAllowedOrigin,
  launchNonceTtlMs,
  protocolToken,
  provideSessionClosers,
  tokensMatch,
} from './http/security.ts';
import { AGENT_RC } from './terminals/agent-rc.ts';
import { TerminalRegistry, type SpawnFn } from './terminals/registry.ts';
import { decideScopes, probeScopes, scopeOomKilled, stopScopes } from './terminals/scopes.ts';
import { ensureSpawnHelper } from './system/pty-helper.ts';
import { LaunchGate, limitsFromConfig, provideLaunchGate } from './system/memory-gate.ts';
import { runShutdownHooks, type ShutdownHook } from './system/shutdown-hooks.ts';
import { InvalidWorkspaceError, UnknownWorkspaceError, WorkspaceStore } from './workspaces/store.ts';

/**
 * The night shift's state for the report, read in-process from the registered
 * GET /api/night route (the night service lives inside the night routes). Set once the
 * router is built; null before.
 */
let readNightStatus: () => Promise<NightStatusView | null> = async () => null;

const require = createRequire(import.meta.url);
const pty = require('node-pty') as { spawn: SpawnFn };

/**
 * API features, each in src/http/routes/<feature>.ts. A new feature adds its
 * module here; routes run after the Host, Origin and session checks below.
 */
const ROUTE_MODULES: RouteModule[] = [
  configRoutes,
  workspaceRoutes,
  treeRoutes,
  terminalRoutes,
  summaryRoutes,
  // W3 overview
  overviewRoutes,

  // W4 inbox
  inboxRoutes,

  // W5 files
  fileRoutes,

  // Night, with the decider: a Claude model through the subscription, reading the user's past corrections from Engram.
  // Its model is read per call from the resource profile, where config `nightModel` still wins.
  createNightRoutes((ctx) => createDecider({ model: () => resourceProfiles(ctx.terminals)?.values().nightModel ?? ctx.config.nightModel, feedback: engramFeedback(ctx.engram) })),

  // Night report: judge, feedback to Engram, notifications and the morning summary (polls the night state each minute).
  createNightReportRoutes({ nightStatus: () => readNightStatus() }),

  // Profile: resource profiles, the Claude call budget and per-call telemetry.
  profileRoutes,
  // Resources: RAM and CPU of the terminals, the machine and the gentle-shells outside Mirador.
  resourceRoutes,

  // MCP per project: which MCP servers a folder's agents start, saved as `enabled: false` in its .pi/mcp.json.
  mcpRoutes,
  gitStatusRoutes,
  gitDiffRoutes,

];

/**
 * Capacity knobs read as optional config keys; each wins over the resource profile
 * (src/profiles.ts): `engramCacheMs`, `maxConcurrent`, `nightModel` and `nightBudget`.
 */
type CapacityKnobs = { engramCacheMs?: unknown; maxConcurrent?: unknown; nightModel?: unknown; nightBudget?: unknown };
/** Runs a registered GET route in-process (no session, no socket) and returns its 200 JSON answer, else null. */
async function routeJson(router: Router, path: string): Promise<unknown> {
  const found = router.match('GET', path);
  if (!found) return null;
  let status = 0;
  let body = '';
  const res = {
    headersSent: false,
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(chunk?: unknown) {
      body = chunk === undefined ? '' : String(chunk);
      return res;
    },
  };
  await found.route.handler({ req: {} as IncomingMessage, res: res as unknown as ServerResponse, url: new URL(`http://127.0.0.1${path}`), params: found.params });
  return status === 200 ? JSON.parse(body) : null;
}

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
// MIRADOR_PUBLIC_DIR is a test seam (test/bundle.test.ts): a scratch copy of public/ to edit or break.
const PUBLIC_DIR = process.env.MIRADOR_PUBLIC_DIR ? resolve(process.env.MIRADOR_PUBLIC_DIR) : join(APP_DIR, 'public');
const VENDOR: Record<string, string> = {
  '/vendor/xterm.mjs': 'node_modules/@xterm/xterm/lib/xterm.mjs',
  '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.mjs': 'node_modules/@xterm/addon-fit/lib/addon-fit.mjs',
  '/vendor/addon-web-links.mjs': 'node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs',
};
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  // The browser notifications' icon and badge (public/notify-*.png).
  '.png': 'image/png',
};

async function main(): Promise<void> {
  // `/` and /bundle/* come from memory (src/http/bundle.ts); the first build starts now, beside the boot.
  const bundle = createWebBundle({ publicDir: PUBLIC_DIR, appDir: APP_DIR, vendor: VENDOR, log: (message) => console.error(message) });
  void bundle.refresh();
  const config = await loadConfig();
  // The launch secret never leaves the 0600 state file; it only mints one-time launch nonces.
  const launchSecret = createToken();
  // Short TTL (LAUNCH_NONCE_TTL_MS): the nonce passes through the browser's argv until the window redeems it.
  // MIRADOR_LAUNCH_NONCE_TTL_MS is a test seam (test/server.test.ts) that can only shorten it.
  const nonces = new LaunchNonces(launchNonceTtlMs(process.env.MIRADOR_LAUNCH_NONCE_TTL_MS));
  const sessions = new Sessions(32);
  const port = Number(process.env.MIRADOR_PORT || config.port);
  const knobs = config as typeof config & CapacityKnobs;
  // The resource profile stored in <stateDir>/profile.json, with the config knobs on top.
  const profiles = await ResourceProfiles.load({
    overrides: { nightModel: knobs.nightModel, maxConcurrent: knobs.maxConcurrent, engramCacheMs: knobs.engramCacheMs, nightBudget: knobs.nightBudget },
  });
  const capacity = profiles.values();
  // One all-projects window serves the overview, activity and container summaries for `engramCacheMs`.
  const engram = new EngramClient(config.engramUrl, undefined, { cacheMs: capacity.engramCacheMs });
  configurePiConcurrency({ maxConcurrent: capacity.maxConcurrent });
  // Every Claude run (decider, judge, "Mejorar con IA") is charged to its budget before its process starts, and logged.
  const budget = new CallBudget({
    limits: () => {
      const values = profiles.values();
      return { night: values.nightBudget, improveDay: values.improveBudget };
    },
    today: () => dayIn(config.timeZone),
    // One count per jornada, ending when the night schedule's window ends (06:00 without one).
    nightOf: (since) => {
      const schedule = nightScheduler(terminals)?.schedule;
      return jornadaOf(config.timeZone, schedule?.enabled ? schedule.end : null, since);
    },
    now: Date.now,
    // No cap while the autopilot is on by hand; the schedule's night keeps it.
    uncapped: () => nightService(terminals)?.source === 'manual',
  });
  const telemetry = new CallTelemetry();
  configureCallMeter(callMeter(budget, telemetry));
  // A profile switch applies at once: the decider model, judge mode and budgets are read per call.
  profiles.onChange((values) => {
    configurePiConcurrency({ maxConcurrent: values.maxConcurrent });
    engram.setCacheMs(values.engramCacheMs);
  });

  const runDir = runtimeDir();
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  await chmod(runDir, 0o700);
  const agentRcFile = join(runDir, 'agent.bashrc');
  await writeFile(agentRcFile, AGENT_RC, { mode: 0o600 });

  // Each terminal in its own systemd user scope, so an OOM kill takes one terminal and not the server.
  // macOS has no systemd: scopes are off there without a probe (decideScopes).
  const scopes = await decideScopes({ config, env: process.env, probe: () => probeScopes(), platform: process.platform });
  console.error(scopes.message);
  // node-pty 1.1.0 ships its macOS spawn-helper without the execute bit: no terminal would start (src/system/pty-helper.ts).
  for (const line of await ensureSpawnHelper()) console.error(line);
  const terminals = new TerminalRegistry(pty.spawn, {
    shell: config.shell,
    agentCommand: config.agentCommand,
    agentRcFile,
    env: process.env,
    scrollbackLimit: 512 * 1024,
    scopes: scopes.enabled,
    stopScopes: (units) => stopScopes(units),
    oomKilled: (unit) => scopeOomKilled(unit),
  });
  // The agents open when Mirador last stopped or died, reopened once the server is up.
  const openAgents = await OpenAgents.load(openAgentsPath(), { owner: configPath() });
  openAgents.track(terminals);
  // The sleeping agents' routes reach the records through the registry.
  provideOpenAgents(terminals, openAgents);
  // Agents opened in a row (a batch, the restore) start in batches and only with memory to spare.
  for (const problem of config.launchProblems) console.error(`mirador: ${configPath()}: ${problem}`);
  const launches = new LaunchGate({ limits: limitsFromConfig(config.launches) });
  provideLaunchGate(terminals, launches);
  // While agents open, no Claude run (decider, judge, "Mejorar con IA") starts one more pi; each takes its fallback.
  configurePiHold(() => launches.status().active);
  // Route modules reach the profiles, the budget and the telemetry through the terminal registry.
  provideProfiles(terminals, profiles);
  provideCallAccounting(terminals, { budget, telemetry });
  // What "sign out the other windows" ends at once: the forgotten sessions' terminal sockets (below)
  // and inbox streams (src/http/routes/inbox.ts), so a lost phone stops at once. A session that only
  // falls out of the 32-session window keeps what it has open, as before.
  const closers = new SessionClosers();
  provideSessionClosers(terminals, closers);

  async function serveStatic(pathname: string, res: ServerResponse, acceptEncoding?: string): Promise<void> {
    const bundled = await bundle.serve(pathname, acceptEncoding);
    if (bundled) {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': bundled.type,
        'cache-control': bundled.cacheControl,
        vary: 'accept-encoding',
        'content-length': bundled.body.length,
        ...(bundled.encoding ? { 'content-encoding': bundled.encoding } : {}),
      });
      res.end(bundled.body);
      return;
    }
    let file: string;
    if (VENDOR[pathname]) {
      file = join(APP_DIR, VENDOR[pathname]);
    } else {
      file = normalize(join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
      if (!file.startsWith(PUBLIC_DIR + sep)) throw new HttpError(404, 'not found');
    }
    let body: Buffer;
    try {
      body = await readFile(file);
    } catch {
      throw new HttpError(404, 'not found');
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  }

  const { workspaces: savedWorkspaces, workspaceProblems, launchProblems: _launchProblems, ...settings } = config;
  for (const problem of workspaceProblems) console.error(`mirador: ${configPath()}: ${problem}; workspace changes will not be saved until it is fixed`);
  // Saving workspaces retires the pre-workspaces `root` key; every other saved key stays.
  const workspaces = new WorkspaceStore(savedWorkspaces, (list) => saveSettings({ workspaces: list }, configPath(), ['root']), {
    problems: workspaceProblems,
  });
  const shutdownHooks: ShutdownHook[] = [];
  const ctx: AppContext = {
    config: settings,
    workspaces,
    resolveFolder: (ws, rel) => workspaces.resolve(typeof ws === 'string' ? ws : '', typeof rel === 'string' ? rel : ''),
    terminals,
    engram,
    today: () => formatDay(new Date(), ctx.config.timeZone),
    parseDate: (value) => parseDay(value, ctx.config.timeZone),
    onShutdown: (fn) => shutdownHooks.push(fn),
  };
  ctx.onShutdown(() => bundle.dispose());
  ctx.onShutdown(async () => {
    await budget.flush();
    await telemetry.flush();
  });
  const router = new Router();
  for (const module of ROUTE_MODULES) for (const route of await module(ctx)) router.add(route);
  // The UI's start-up state in one request, from the config and workspaces routes registered above.
  router.add(bootstrapRoute((path) => routeJson(router, path)));
  // A link already handed out is the other windows' next way in, so the sign-out drops those too (#68).
  router.add(signOutOthersRoute(sessions, (tokens) => {
    closers.close(tokens);
    nonces.clear();
  }));
  readNightStatus = async () => {
    const status = await routeJson(router, '/api/night');
    return status && typeof status === 'object' ? (status as NightStatusView) : null;
  };
  // Lazy restore: each agent's attention state (the inbox's store) goes with its record, so the
  // next start knows which agents had finished their turn.
  const attention = nightAttention(terminals);
  if (attention instanceof AttentionStore) {
    attention.onAgentState((id, state) => void openAgents.recordState(id, state));
    // Claude Code's hooks, opencode's plugin and agy's hooks report its session id, which a restore or wake
    // resumes with `--resume <id>` (claude), `--session <id>` (opencode) or `--conversation <id>` (agy).
    attention.onSession((id, session) => void openAgents.recordSessionId(id, session));
  }
  // The bridges report each agent's pi session file through the night socket.
  whenNightService(terminals, (night) => {
    ctx.onShutdown(night.onSessionFile((id, file) => void openAgents.recordSession(id, file)));
    // Idle sleep: an agent finished for `idleSleepHours` saves its session through a Mirador note, then sleeps.
    if (!(attention instanceof AttentionStore)) return;
    const idle = new IdleSleep({
      registry: terminals,
      attention,
      openAgents,
      sendNote: (id, text, noteId, frame, from) => night.sendNote(id, text, noteId, frame, from),
      idleMs: (config.idleSleepHours ?? IDLE_SLEEP_HOURS) * 3_600_000,
      // Config `ownerName`: who the save note says wakes the agent ("the user" unset).
      ownerName: () => ctx.config.ownerName,
    });
    idle.start();
    ctx.onShutdown(() => idle.stop());
  });

  const server = createServer(async (req, res) => {
    try {
      if (!isAllowedHost(req.headers.host, port)) throw new HttpError(421, 'unexpected host');
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

      // The launcher (not a browser) trades the launch secret for a one-time window URL.
      if (req.method === 'POST' && url.pathname === '/bootstrap') {
        if (!tokensMatch(bearerToken(req.headers.authorization), launchSecret)) throw new HttpError(403, 'invalid launch secret');
        return sendJson(res, 200, { url: `http://127.0.0.1:${port}/#launch=${nonces.issue()}` });
      }
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && !isAllowedOrigin(req.headers.origin, port)) throw new HttpError(403, 'cross-origin request');
        if (req.method === 'POST' && url.pathname === '/api/session') {
          const body = await readJson(req);
          if (!nonces.consume(typeof body.nonce === 'string' ? body.nonce : undefined)) throw new HttpError(403, 'invalid or used launch link');
          return sendJson(res, 200, { token: sessions.create() });
        }
        if (!sessions.has(bearerToken(req.headers.authorization))) throw new HttpError(401, 'open Mirador with its launcher');
        const found = router.match(req.method ?? 'GET', url.pathname);
        if (!found) throw new HttpError(404, 'not found');
        await found.route.handler({ req, res, url, params: found.params });
        return;
      }
      if (req.method !== 'GET') throw new HttpError(405, 'method not allowed');
      await serveStatic(url.pathname, res, req.headers['accept-encoding']);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message, code: error.code });
      if (error instanceof InvalidFolderError) return sendJson(res, 400, { error: error.message, code: 'folder_invalid' });
      if (error instanceof UnknownWorkspaceError) return sendJson(res, 404, { error: error.message, code: 'workspace_not_found' });
      if (error instanceof InvalidWorkspaceError) return sendJson(res, 400, { error: error.message, code: error.code });
      if (error instanceof EngramUnavailableError) return sendJson(res, 503, { error: error.message });
      console.error(error);
      sendJson(res, 500, { error: 'internal error' });
    }
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    handleProtocols: (protocols) => (protocols.has(APP_PROTOCOL) ? APP_PROTOCOL : false),
  });
  server.on('upgrade', (req, socket, head) => {
    const id = req.url?.match(/^\/ws\/terminals\/([\w-]+)$/)?.[1];
    const offered = new Set((req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim()).filter(Boolean));
    const token = protocolToken(offered);
    const allowed =
      isAllowedHost(req.headers.host, port) &&
      isAllowedOrigin(req.headers.origin, port) &&
      offered.has(APP_PROTOCOL) &&
      sessions.has(token) &&
      !!id &&
      !!terminals.get(id);
    if (!allowed) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachTerminal(ws, id!, token!));
  });

  function attachTerminal(ws: WebSocket, id: string, token: string): void {
    let signedOut = false;
    const unregister = closers.add(token, () => {
      signedOut = true;
      ws.close(1008, 'signed out');
    });
    const send = (message: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(message));
    const attachment = terminals.attach(id, {
      onData: (d) => send({ t: 'o', d }),
      onExit: (code, info) => send({ t: 'x', code, info }),
    });
    send({ t: 's', d: attachment.scrollback, info: attachment.info });
    // Closed (by any window, or put to sleep): every window showing it drops it too ({t:'c'}), then
    // its socket closes. Not while Mirador stops: its windows keep the tabs and say the link is lost.
    // Put to sleep, the message says so ({t:'c', reason:'sleep'}) and each window shows a line.
    const unsubscribe = terminals.subscribe(({ type, info, reason }) => {
      if (type !== 'closed' || info.id !== id || stopping) return;
      send(reason ? { t: 'c', reason } : { t: 'c' });
      ws.close(1000, 'closed');
    });
    // Oversized or invalid frames surface here; without a listener they would crash the process.
    ws.on('error', () => ws.terminate());
    ws.on('message', (raw) => {
      let message: { t?: string; d?: unknown; c?: unknown; r?: unknown };
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      // A socket whose session was signed out is closing: it types nothing more.
      if (signedOut) return;
      if (typeof message !== 'object' || message === null || !terminals.get(id)) return;
      if (message.t === 'i' && typeof message.d === 'string') terminals.write(id, message.d);
      if (message.t === 'r') terminals.resize(id, clampSize(message.c, 80), clampSize(message.r, 24));
    });
    ws.on('close', () => {
      unregister();
      unsubscribe();
      attachment.detach();
    });
  }

  const statePath = join(runDir, 'state.json');
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    // Mirador's own stop is not the user closing the agents: they reopen at the next start.
    openAgents.keep();
    // Batches and the restore waiting for their turn give up now: nothing starts after this.
    launches.close();
    await runShutdownHooks(shutdownHooks);
    // With scopes, waits until nothing of the terminals runs any more (bin/mirador stop waits for this process).
    await terminals.closeAll();
    await openAgents.flush();
    await rm(statePath, { force: true });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Until the state file is written the start can still fail: exit so the launcher notices.
  let started = false;
  const failStart = (message: string): never => {
    console.error(`mirador: ${message}`);
    process.exit(1);
  };

  // Once started, terminals hold running agents: log an unexpected error instead of taking them all down.
  process.on('uncaughtException', (error) => {
    if (!started) failStart(`failed to start: ${error?.stack ?? error}`);
    console.error('uncaught error:', error);
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (started) return console.error('server error:', error);
    failStart(
      error.code === 'EADDRINUSE'
        ? `port ${port} on 127.0.0.1 is already in use (is Mirador already running? see bin/mirador status)`
        : `cannot listen on 127.0.0.1:${port}: ${error.message}`,
    );
  });

  server.listen(port, '127.0.0.1', async () => {
    try {
      // Written whole and renamed into place, so the launcher never reads a partial file.
      const pending = `${statePath}.${process.pid}.tmp`;
      await writeFile(pending, JSON.stringify({ pid: process.pid, port, launchSecret }) + '\n', { mode: 0o600 });
      await rename(pending, statePath);
    } catch (error) {
      failStart(`cannot write ${statePath}: ${(error as Error).message}`);
    }
    started = true;
    // The launch secret stays in the 0600 state file; never print it to the log.
    // The port it bound: the configured one, or the one the kernel picked for port 0 (tests).
    const bound = server.address();
    console.log(`Mirador listening on http://127.0.0.1:${typeof bound === 'object' && bound ? bound.port : port} (${workspaces.list().length} workspaces); open it with bin/mirador`);
    // Only now: every route has added its agent args and variables, and no other Mirador holds the port.
    openAgents
      .restore({
        registry: terminals,
        resolveFolder: (id, rel) => workspaces.resolve(id, rel),
        // The catalog agent's verified resume (`--session <file>` for gentle-shell or pi, `--resume <id>` for claude, `--session <id>` for opencode, `--conversation <id>` for agy); others start fresh.
        // A record's chosen agent is resumed by its own command; without one, the configured agentCommand.
        sessionArgs: (file, agent) => resumeArgs((agent && agentLaunch(agent, config.agentCommand)?.agentCommand) || config.agentCommand, file),
        agentLaunch: (agent) => agentLaunch(agent, config.agentCommand),
        gate: launches,
        // After a crash the previous agents may still run in their scopes: end them before reopening their sessions.
        endPrevious: scopes.enabled ? stopPreviousScopes() : undefined,
      })
      .then(({ restored, dropped }) => {
        if (restored || dropped) console.log(`mirador: reopened ${restored} agent(s), dropped ${dropped}`);
      })
      .catch((error) => console.error('mirador: restoring the open agents failed:', error));
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
