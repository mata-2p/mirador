import type { OpencodeVersion } from '../agents/opencode-version.ts';
import type { MiradorConfig } from '../config.ts';
import type { EngramClient } from '../memory/engram.ts';
import type { TerminalRegistry } from '../terminals/registry.ts';
import type { ResolvedFolder, WorkspaceStore } from '../workspaces/store.ts';
import type { Route } from './router.ts';
import { HttpError } from './respond.ts';

/** Everything a route module shares with the rest of the server. Built once in server.ts. */
export interface AppContext {
  /** Settings from ~/.config/mirador/config.json. Workspaces live in `workspaces`, not here. */
  readonly config: Readonly<Omit<MiradorConfig, 'workspaces'>>;
  /** The workspaces: list, get, add, update, remove (each change is validated and saved). */
  workspaces: WorkspaceStore;
  /**
   * Resolves folder `rel` of workspace `ws` (query or body values as received).
   * The only way a route may turn client input into a filesystem path: unknown
   * workspace → 404, a path outside its root → 400.
   */
  resolveFolder(ws: unknown, rel: unknown): Promise<ResolvedFolder>;
  terminals: TerminalRegistry;
  engram: EngramClient;
  /** Today's date (YYYY-MM-DD) in the configured time zone. */
  today(): string;
  /** A `date` query parameter, or today; anything but YYYY-MM-DD is a 400. */
  parseDate(value: string | null): string;
  /** Runs `fn` on SIGINT/SIGTERM before the process exits (close sockets, child processes). */
  onShutdown(fn: () => void | Promise<void>): void;
  /**
   * `opencode --version` as far as the server knows it now (src/agents/opencode-version.ts): undefined until the
   * first opencode terminal needed it (opencodeReady). It never starts a read. An `old` one starts without its bridge
   * and is offered with no attention or resume; undefined is offered with the bridge, as before. Absent in tests.
   */
  opencodeVersion?(): OpencodeVersion | undefined;
  /**
   * Work a route module needs done once opencode's version is read (its bridge): no opencode terminal starts before
   * it is done (opencodeReady). Absent in tests: then the route module does it at once, for no known version.
   */
  whenOpencodeRead?(work: (version: OpencodeVersion) => Promise<void>): void;
  /**
   * What an agent terminal of catalog id `agent` (absent or null: the configured agentCommand) waits for before it
   * starts: when it runs opencode and the version is not known yet, the read (begun by this call, once per server
   * life) and whenOpencodeRead's work; null when it may start now. Absent in tests.
   */
  opencodeReady?(agent?: string | null): Promise<void> | null;
  /** True once the server's stop began (SIGINT/SIGTERM): a request that waited starts nothing more. Absent in tests. */
  stopping?(): boolean;
}

/** A feature's server half: it receives the shared context and returns its routes. */
export type RouteModule = (ctx: AppContext) => Route[] | Promise<Route[]>;

// Building an Intl.DateTimeFormat costs far more than formatting with one: keep one per time zone.
const dayFormats = new Map<string, Intl.DateTimeFormat>();

export function formatDay(date: Date, timeZone: string): string {
  let format = dayFormats.get(timeZone);
  if (!format) {
    // en-CA formats dates as YYYY-MM-DD.
    format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormats.set(timeZone, format);
  }
  return format.format(date);
}

export function parseDay(value: string | null, timeZone: string): string {
  if (!value) return formatDay(new Date(), timeZone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, 'date must be YYYY-MM-DD');
  return value;
}
