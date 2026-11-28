import { spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { cleanEnv, TERMINAL_VARS } from '../terminals/registry.ts';
import { agentFor, whichOnPath } from './catalog.ts';

/**
 * The first opencode Mirador's bridge works with (#124): opencode 2.0.0 has `--standalone` and `--session` on its
 * root command, reads OPENCODE_CONFIG_CONTENT in the server it starts, and loads V2 plugins (`setup(ctx)`, with
 * `ctx.event.subscribe` and the session.execution.*, permission.* and form.* events bin/opencode-plugin.js
 * follows). opencode 1.x has neither `--standalone` nor that plugin API: it prints its help and exits. The
 * source: opencode's v2.0.0 tag, packages/cli/src/commands/commands.ts (ServerParams.standalone, the root session flag).
 */
export const OPENCODE_BRIDGE_VERSION = '2.0.0';
/**
 * How long `opencode --version` may take: opencode 1.19.6 answers in about 0.6 s here, but a `pnpm dlx` wrapper
 * on a cold cache downloads opencode first. Past it the version
 * is unreadable, which keeps the bridge. Tests pass a shorter `timeoutMs`.
 */
export const OPENCODE_VERSION_TIMEOUT_MS = 15_000;
/** How long the agent bash may take to load its startup files and print its PATH. */
export const AGENT_PATH_TIMEOUT_MS = 5000;
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

/** The first `major.minor.patch`, with its `-pre-release` suffix if any, in `text`. */
function versionIn(text: string): { numbers: [number, number, number]; text: string } | null {
  const match = /(?<![\d.])(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z][0-9A-Za-z.-]*)?/.exec(text);
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
function runBounded(file: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number; what: string; signal?: AbortSignal }): Promise<{ stdout: string } | { reason: string }> {
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
      child = spawn(file, args, { env: options.env, cwd: options.cwd, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
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

const PATH_MARK = /<mirador-path>([^\n]*)<\/mirador-path>/g;

/**
 * The PATH an agent terminal's bash gets: `shell -i -c` loads the same startup files as the agent bash
 * (`bash --rcfile agent.bashrc -i`, whose rcfile loads ~/.bashrc; src/terminals/agent-rc.ts) with the terminal's
 * environment (TerminalRegistry.create), then prints PATH between marks, so whatever ~/.bashrc prints is
 * skipped. It runs no agent: MIRADOR_AGENT_COMMAND is never set. Null, so the server's PATH applies, without a
 * HOME (the shell would read the account's own ~/.bashrc), or when the shell fails, ends before printing or takes
 * longer than `timeoutMs`.
 */
export async function agentShellPath(shell: string, env: NodeJS.ProcessEnv, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string | null> {
  if (!env.HOME || !isAbsolute(env.HOME)) return null;
  const printPath = `printf '\\n<mirador-path>%s</mirador-path>\\n' "$PATH"`;
  const outcome = await runBounded(shell, ['-i', '-c', printPath], {
    env: { ...cleanEnv(env), ...TERMINAL_VARS },
    cwd: env.HOME,
    timeoutMs: options.timeoutMs ?? AGENT_PATH_TIMEOUT_MS,
    what: 'the agent shell',
    signal: options.signal,
  });
  if ('reason' in outcome) return null;
  const marks = [...outcome.stdout.matchAll(PATH_MARK)];
  return marks.length ? marks[marks.length - 1][1] : null;
}

/** Where readOpencodeVersion looks for the opencode an agent terminal runs. */
export interface OpencodeLookup {
  /** The configured agentCommand: when it is opencode named by a path, that file is the one read. */
  agentCommand?: string;
  /** The agent terminals' shell (config `shell`): opencode is looked up on the PATH it leaves (agentShellPath). */
  shell?: string;
  timeoutMs?: number;
  /** Ends a read still running when it aborts (the server stops), so no `opencode --version` outlives the server. */
  signal?: AbortSignal;
}

/**
 * The opencode an agent terminal runs and the PATH it runs with: the configured `agentCommand`'s program when that
 * starts opencode by path (`~/` is HOME, as bash expands it), else the `opencode` on the agent shell's PATH (or
 * `env.PATH` without a shell, or when the shell gives none). A relative path is a string: each folder resolves it.
 */
async function locateOpencode(env: NodeJS.ProcessEnv, lookup: OpencodeLookup): Promise<{ file: string | null; relative?: string; path: string | undefined }> {
  const path = (lookup.shell ? await agentShellPath(lookup.shell, env, { signal: lookup.signal }) : null) ?? env.PATH;
  const program = lookup.agentCommand && agentFor(lookup.agentCommand)?.id === 'opencode' ? lookup.agentCommand.trim().split(/\s+/)[0] : '';
  if (program.includes('/')) {
    if (program.startsWith('~/') && env.HOME) return { file: join(env.HOME, program.slice(2)), path };
    if (isAbsolute(program)) return { file: program, path };
    return { file: null, relative: program, path };
  }
  return { file: await whichOnPath('opencode', path), path };
}

/**
 * Reads `opencode --version` of the opencode an agent terminal runs (locateOpencode): run directly (no shell),
 * with `env` and the agent's PATH, the first version on its stdout. One that has not finished within `timeoutMs`
 * is ended with its whole process group and counts as unreadable; so does a `0.0.0-…` development build. Any
 * other pre-release compares by its `x.y.z`.
 */
export async function readOpencodeVersion(env: NodeJS.ProcessEnv, lookup: OpencodeLookup = {}): Promise<OpencodeVersion> {
  const located = await locateOpencode(env, lookup);
  if (located.relative) return { state: 'unreadable', file: located.relative, reason: 'agentCommand names opencode by a relative path, which each folder resolves on its own' };
  const file = located.file;
  if (!file) return { state: 'absent' };
  const outcome = await runBounded(file, ['--version'], { env: { ...env, PATH: located.path }, timeoutMs: lookup.timeoutMs ?? OPENCODE_VERSION_TIMEOUT_MS, what: 'opencode --version', signal: lookup.signal });
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

/** A version that could not be read, and that the bridge stays: also shared by doctor and the log. */
const unreadableText = (version: { reason: string; file: string }): string => `could not read the version of ${version.file} (${version.reason})`;

/**
 * What `mirador doctor` adds to its opencode line for `version` (null for none found), and whether that line is
 * a `warn`: only an opencode older than the bridge is.
 */
export function opencodeDoctorNote(version: OpencodeVersion): { warn: boolean; text: string } | null {
  if (version.state === 'absent') return null;
  if (version.state === 'unreadable') return { warn: false, text: `${unreadableText(version)}; Mirador starts it with its bridge, which needs opencode ${OPENCODE_BRIDGE_VERSION} or newer` };
  if (version.state === 'old') return { warn: true, text: `${oldOpencodeText(version)}; Mirador starts it without attention or resume` };
  return { warn: false, text: `${named(version)}, with Mirador's bridge` };
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
      this.log(`mirador: ${unreadableText(version)}; opencode agents start with Mirador's bridge as before, which needs opencode ${OPENCODE_BRIDGE_VERSION} or newer`);
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
