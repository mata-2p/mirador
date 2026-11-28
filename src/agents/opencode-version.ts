import { spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { agentFor, whichOnPath } from './catalog.ts';

/**
 * The first opencode Mirador's bridge works with (#124): opencode 2.0.0 has `--standalone` and `--session` on its
 * root command, reads OPENCODE_CONFIG_CONTENT in the server it starts, and loads V2 plugins (`setup(ctx)`, with
 * `ctx.event.subscribe` and the session.execution.*, permission.* and form.* events bin/opencode-plugin.js
 * follows). opencode 1.x has neither `--standalone` nor that plugin API: it prints its help and exits. The
 * source: opencode's v2.0.0 tag, packages/cli/src/commands/commands.ts (ServerParams.standalone, the root session flag).
 * They are root-command flags there, and its parser (effect 4.0.0-rc.112, unstable/cli) reads a command's flags in any
 * order, also after other flags or a directory argument, so Mirador appending them after the user's own words works
 * from 2.0.0 on; opencode 2.2.0's "Accept --server and --standalone anywhere" (#58505) is about subcommands.
 */
export const OPENCODE_BRIDGE_VERSION = '2.0.0';
/**
 * How long `opencode --version` may take: opencode 1.19.6 answers in about 0.6 s here, but a `pnpm dlx` wrapper
 * on a cold cache downloads opencode first. Past it the version
 * is unreadable, which keeps the bridge. Tests pass a shorter `timeoutMs`.
 */
export const OPENCODE_VERSION_TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 4096;

/**
 * What `opencode --version` says about `file`, the opencode an agent terminal runs: none found (`absent`); `old`,
 * older than {@link OPENCODE_BRIDGE_VERSION} (no bridge); `ok`, that version or newer; `unreadable`, no release
 * version could be read (the bridge stays, as before).
 */
export type OpencodeVersion =
  | { state: 'absent' }
  | { state: 'old' | 'ok'; version: string; file: string }
  | { state: 'unreadable'; reason: string; file: string };

/**
 * The last `major.minor.patch`, with its `-pre-release` suffix if any, in `text`: a wrapper may print its own
 * version before opencode's.
 */
function versionIn(text: string): { numbers: [number, number, number]; text: string } | null {
  const match = [...text.matchAll(/(?<![\d.])(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z][0-9A-Za-z.-]*)?/g)].at(-1);
  return match ? { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], text: match[0] } : null;
}

const older = (a: readonly number[], b: readonly number[]): boolean => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};

/**
 * Runs `file args` directly (no shell) with `env`, and gives its stdout once it exits 0. One that has not finished
 * within `timeoutMs`, or still running when `signal` aborts (the server stops), is ended with its whole process
 * group (a wrapper script's children too); that, an exit other than 0 or a spawn error gives a reason naming
 * `what` instead.
 */
function runBounded(file: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number; what: string; signal?: AbortSignal }): Promise<{ stdout: string } | { reason: string }> {
  const { what, timeoutMs, signal } = options;
  if (signal?.aborted) return Promise.resolve({ reason: `${what} was not run: Mirador is stopping` });
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const settle = (value: { stdout: string } | { reason: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => {
      endGroup();
      settle({ reason: `${what} was stopped: Mirador is stopping` });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { env: options.env, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    } catch (error) {
      resolve({ reason: `${what} could not run (${(error as NodeJS.ErrnoException).code ?? 'error'})` });
      return;
    }
    const endGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      endGroup();
      settle({ reason: `${what} did not answer within ${timeoutMs} ms` });
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString('utf8').slice(0, MAX_OUTPUT - stdout.length);
    });
    child.on('error', (error: NodeJS.ErrnoException) => settle({ reason: `${what} could not run (${error.code ?? 'error'})` }));
    child.on('close', (code, signal) => {
      endGroup();
      if (code === 0) settle({ stdout });
      else settle({ reason: code === null ? `${what} ended on ${signal}` : `${what} exited with code ${code}` });
    });
  });
}

/** Where readOpencodeVersion looks for the opencode an agent terminal runs. */
export interface OpencodeLookup {
  /** The configured agentCommand: when it is opencode named by a path, that file is the one read. */
  agentCommand?: string;
  timeoutMs?: number;
  /** Ends a read still running when it aborts (the server stops), so no `opencode --version` outlives the server. */
  signal?: AbortSignal;
}

/**
 * The opencode an agent terminal runs: the configured `agentCommand`'s program when that starts opencode by path
 * (`~/` is HOME, as bash expands it), else the `opencode` on Mirador's own PATH (`env.PATH`). A ~/.bashrc that puts
 * another opencode first is not followed: running it at every start costs more than it gives (docs/extending.md
 * says to configure `agentCommand` with the full path then). A relative path is a string: each folder resolves it.
 */
async function locateOpencode(env: NodeJS.ProcessEnv, lookup: OpencodeLookup): Promise<{ file: string | null; relative?: string }> {
  const program = lookup.agentCommand && agentFor(lookup.agentCommand)?.id === 'opencode' ? lookup.agentCommand.trim().split(/\s+/)[0] : '';
  if (program.includes('/')) {
    if (program.startsWith('~/') && env.HOME) return { file: join(env.HOME, program.slice(2)) };
    if (isAbsolute(program)) return { file: program };
    return { file: null, relative: program };
  }
  return { file: await whichOnPath('opencode', env.PATH) };
}

/**
 * Reads `opencode --version` of the opencode an agent terminal runs (locateOpencode): run directly (no shell),
 * with `env`, the last version on its stdout. One that has not finished within `timeoutMs` is ended with its
 * whole process group and counts as unreadable; so does a `0.0.0-…` development build. Any other pre-release
 * compares by its `x.y.z`.
 */
export async function readOpencodeVersion(env: NodeJS.ProcessEnv, lookup: OpencodeLookup = {}): Promise<OpencodeVersion> {
  const located = await locateOpencode(env, lookup);
  if (located.relative) return { state: 'unreadable', file: located.relative, reason: 'agentCommand names opencode by a relative path, which each folder resolves on its own' };
  const file = located.file;
  if (!file) return { state: 'absent' };
  const outcome = await runBounded(file, ['--version'], { env, timeoutMs: lookup.timeoutMs ?? OPENCODE_VERSION_TIMEOUT_MS, what: 'opencode --version', signal: lookup.signal });
  if ('reason' in outcome) return { state: 'unreadable', reason: outcome.reason, file };
  const found = versionIn(outcome.stdout);
  if (!found) return { state: 'unreadable', reason: 'opencode --version printed no version', file };
  if (found.text.startsWith('0.0.0-')) return { state: 'unreadable', reason: `opencode --version printed a development build (${found.text}), not a release`, file };
  return { state: older(found.numbers, versionIn(OPENCODE_BRIDGE_VERSION)!.numbers) ? 'old' : 'ok', version: found.text, file };
}

/** Whether Mirador's bridge goes with opencode: every version but an `old` one (unreadable keeps it, as before). */
export const opencodeBridged = (version: OpencodeVersion | undefined): boolean => version?.state !== 'old';

/** The catalog ids that start without their bridge for `version`: opencode when it is `old`, else none. */
export const withoutBridge = (version: OpencodeVersion | undefined): ReadonlySet<string> => new Set(opencodeBridged(version) ? [] : ['opencode']);

/** Which opencode was read: `opencode <version> (<file>)`. */
const named = (version: { version: string; file: string }): string => `opencode ${version.version} (${version.file})`;

/** What an opencode older than the bridge is and lacks: the words `mirador doctor` and the server's log share. */
export const oldOpencodeText = (version: { version: string; file: string }): string =>
  `${named(version)} is older than ${OPENCODE_BRIDGE_VERSION}, the first opencode with --standalone and the plugin API Mirador's bridge needs`;

/** A version that could not be read, and that the bridge stays: the words `mirador doctor` and the server's log share. */
export const unreadableOpencodeText = (version: { reason: string; file: string }): string =>
  `could not read the version of ${version.file} (${version.reason}); opencode agents start with Mirador's bridge as before, which needs opencode ${OPENCODE_BRIDGE_VERSION} or newer`;

/**
 * What `mirador doctor` adds to its opencode line for `version` (null for none found), and that line's status:
 * `warn` only for an opencode older than the bridge.
 */
export function opencodeDoctorNote(version: OpencodeVersion): { status: 'ok' | 'warn'; text: string } | null {
  if (version.state === 'absent') return null;
  if (version.state === 'unreadable') return { status: 'ok', text: unreadableOpencodeText(version) };
  if (version.state === 'old') return { status: 'warn', text: `${oldOpencodeText(version)}; Mirador starts it without attention or resume` };
  return { status: 'ok', text: `${named(version)}, with Mirador's bridge` };
}

/**
 * The server's log lines about the opencode it found, each written at most once per server run: `start`, the first
 * opencode agent started without the bridge; `resume`, the first opencode session it does not resume; and,
 * once at start, a version it could not read.
 */
export class OpencodeNotices {
  private readonly said = new Set<string>();
  private readonly version: OpencodeVersion;
  private readonly log: (line: string) => void;

  constructor(version: OpencodeVersion, log: (line: string) => void = (line) => console.log(line)) {
    this.version = version;
    this.log = log;
    if (version.state === 'unreadable') {
      this.log(`mirador: ${unreadableOpencodeText(version)}`);
    }
  }

  /** An opencode agent terminal started. */
  started(): void {
    if (this.version.state !== 'old') return;
    this.once('start', `mirador: ${oldOpencodeText(this.version)}: opencode agents start without it (no attention, no resume, no idle sleep); update opencode to ${OPENCODE_BRIDGE_VERSION} or newer`);
  }

  /** An opencode session that would have been resumed is not. */
  notResumed(): void {
    if (this.version.state !== 'old') return;
    this.once('resume', `mirador: ${named(this.version)} is older than ${OPENCODE_BRIDGE_VERSION}, which resuming an opencode session from Mirador needs: a reopened or woken opencode agent starts a fresh session (no --session)`);
  }

  private once(kind: string, line: string): void {
    if (this.said.has(kind)) return;
    this.said.add(kind);
    this.log(line);
  }
}
