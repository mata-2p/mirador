import { spawn } from 'node:child_process';
import { whichOnPath } from './catalog.ts';

/**
 * The first opencode Mirador's bridge works with (#124): opencode 2.0.0 has `--standalone` and `--session` on its
 * root command, reads OPENCODE_CONFIG_CONTENT in the server it starts, and loads V2 plugins (`setup(ctx)`, with
 * `ctx.event.subscribe` and the session.execution.*, permission.* and form.* events bin/opencode-plugin.js
 * follows). opencode 1.x has neither `--standalone` nor that plugin API: it prints its help and exits. The
 * source: opencode's v2.0.0 tag, packages/cli/src/commands/commands.ts (ServerParams.standalone, the root session flag).
 */
export const OPENCODE_BRIDGE_VERSION = '2.0.0';
/** How long `opencode --version` may take: opencode 1.19.6 answers in about 0.6 s here. */
export const OPENCODE_VERSION_TIMEOUT_MS = 5000;
const MAX_OUTPUT = 4096;

/**
 * What `opencode --version` says: no opencode on PATH; `old`, older than {@link OPENCODE_BRIDGE_VERSION} (no
 * bridge); `ok`, that version or newer; `unreadable`, no version could be read (the bridge stays, as before).
 */
export type OpencodeVersion =
  | { state: 'absent' }
  | { state: 'old' | 'ok'; version: string }
  | { state: 'unreadable'; reason: string };

/** The first `major.minor.patch` in `text`, as numbers. */
function versionIn(text: string): [number, number, number] | null {
  const match = /(?<![\d.])(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

const older = (a: readonly number[], b: readonly number[]): boolean => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};

/**
 * Runs the `opencode` found on `env.PATH` (absolute directories only, as onPath) with `--version`, directly (no
 * shell), with `env`, and reads the first version on its stdout. One that has not finished within `timeoutMs` is
 * ended with its whole process group (a wrapper script's children too) and counts as unreadable.
 */
export async function readOpencodeVersion(env: NodeJS.ProcessEnv, options: { timeoutMs?: number } = {}): Promise<OpencodeVersion> {
  const file = await whichOnPath('opencode', env.PATH);
  if (!file) return { state: 'absent' };
  const timeoutMs = options.timeoutMs ?? OPENCODE_VERSION_TIMEOUT_MS;
  const outcome = await new Promise<{ stdout: string } | { reason: string }>((resolve) => {
    let stdout = '';
    let settled = false;
    const settle = (value: { stdout: string } | { reason: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, ['--version'], { env, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    } catch (error) {
      resolve({ reason: `opencode --version could not run (${(error as NodeJS.ErrnoException).code ?? 'error'})` });
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
      settle({ reason: `opencode --version did not answer within ${timeoutMs} ms` });
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString('utf8').slice(0, MAX_OUTPUT - stdout.length);
    });
    child.on('error', (error: NodeJS.ErrnoException) => settle({ reason: `opencode --version could not run (${error.code ?? 'error'})` }));
    child.on('close', (code, signal) => {
      endGroup();
      if (code === 0) settle({ stdout });
      else settle({ reason: code === null ? `opencode --version ended on ${signal}` : `opencode --version exited with code ${code}` });
    });
  });
  if ('reason' in outcome) return { state: 'unreadable', reason: outcome.reason };
  const found = versionIn(outcome.stdout);
  if (!found) return { state: 'unreadable', reason: 'opencode --version printed no version' };
  const version = found.join('.');
  return { state: older(found, versionIn(OPENCODE_BRIDGE_VERSION)!) ? 'old' : 'ok', version };
}

/** Whether Mirador's bridge goes with opencode: every version but an `old` one (unreadable keeps it, as before). */
export const opencodeBridged = (version: OpencodeVersion | undefined): boolean => version?.state !== 'old';

/** The catalog ids that start without their bridge for `version`: opencode when it is `old`, else none. */
export const withoutBridge = (version: OpencodeVersion | undefined): ReadonlySet<string> => new Set(opencodeBridged(version) ? [] : ['opencode']);

/** What an opencode older than the bridge lacks, for `mirador doctor` and the server's log. */
export const OLD_OPENCODE_LACKS = "the first with --standalone and the plugin API Mirador's bridge needs";

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
      this.log(`mirador: could not read opencode's version (${version.reason}); opencode agents start with Mirador's bridge as before, which needs opencode ${OPENCODE_BRIDGE_VERSION} or newer`);
    }
  }

  /** An opencode agent terminal started. */
  started(): void {
    if (this.version.state !== 'old') return;
    this.once('start', `mirador: opencode ${this.version.version} is older than ${OPENCODE_BRIDGE_VERSION}, the first opencode with --standalone and the plugin API Mirador's bridge needs: opencode agents start without it (no attention, no resume, no idle sleep); update opencode to ${OPENCODE_BRIDGE_VERSION} or newer`);
  }

  /** An opencode session that would have been resumed is not. */
  notResumed(): void {
    if (this.version.state !== 'old') return;
    this.once('resume', `mirador: opencode ${this.version.version} is older than ${OPENCODE_BRIDGE_VERSION}, which resuming an opencode session from Mirador needs: a reopened or woken opencode agent starts a fresh session (no --session)`);
  }

  private once(kind: string, line: string): void {
    if (this.said.has(kind)) return;
    this.said.add(kind);
    this.log(line);
  }
}
