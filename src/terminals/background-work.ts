import { readdir, readFile, readlink, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { terminalAgent } from '../attention/agent-args.ts';
import { mcpServerCommands } from '../mcp/project-mcp.ts';
import { DEFAULT_ROOTS, ProcessTable, scopeDir, type ResourceRoots } from '../system/resources.ts';
import type { TerminalRegistry } from './registry.ts';

/**
 * Background work an agent left running, read before idle sleep closes it (src/terminals/hibernate.ts,
 * #115). Only read from /proc and the scope's cgroup: nothing here signals a process.
 *
 * Where each process sits decides:
 * - The terminal's pty child is its bash (`agent.bashrc`), which runs the agent; with scopes it is also
 *   the scope root (`systemd-run --scope` execs in place). That bash, and any shell between it and the
 *   first program below it (a wrapper script), only launch the agent.
 * - **Own process:** the agent (that first program), or a descendant of it whose chain up to the agent
 *   holds no shell (`sh`, `bash`, `dash`, `zsh`, `fish`): agents start MCP servers and helpers directly
 *   (`npx`, `node`, `uvx`, `python`, a binary). Also own: a process whose command line, or the script of
 *   the `sh -c` that runs it, is an MCP server configured for that agent (`mcp`), and all below it. And
 *   own: everything below a shell the agent started whose stdin and stdout are both a pipe or a socket
 *   (`/proc/<pid>/fd/0` and `/1`), as a stdio MCP server's are (`bash start.sh`, `sh -c '…; exit'`; Claude
 *   Code hands its servers socket pairs). A tool shell is not: Claude Code's background Bash has stdin
 *   `/dev/null` and its output in a file (checked live with Claude Code 2.1.332).
 * - **Background work (a):** a process in the scope's `cgroup.procs` that does not descend from the pty
 *   child: orphaned when the shell that started it exited (`npm run dev &`). One that started after the
 *   process table was read is followed up through its status files: below the pty child it is classed
 *   as the rest of the tree.
 * - **Background work (b):** a descendant of the agent through a shell, alive while its turn is finished
 *   (the only time this runs): a finished turn runs no tool, so it is a background job, unless the first
 *   such shell is wired to the agent as a stdio MCP server (above).
 * - Without scopes (`scope` null) only (b) can be seen: orphans leave the tree untracked (#1).
 * - Without /proc (macOS) nothing can be read: the check is skipped (null), so the agent sleeps as idle
 *   sleep did before this check.
 * - A check that cannot be completed (a read error, or more than MAX_PROCESSES processes, so the tree may
 *   be cut) answers `unchecked`: the agent stays open, since work that cannot be verified is not stopped.
 *
 * Each reason has a stable `top`, its identity while it lasts: the orphan whose parent is not an orphan of
 * the scope (a), or the first shell below the agent (b). A loop or a polling job runs a new child every
 * round; its top stays.
 *
 * What it answers is the program's name only, the comm the kernel keeps (`/proc/<pid>/status` Name), and
 * its pid: never an argument, since a command line can carry keys or connection strings.
 */

export const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'dash', 'zsh', 'fish']);

/** Processes read per check, at most (as the resource samples). */
const MAX_PROCESSES = 5000;
/** Ancestors followed from a process up to the pty child. */
const MAX_DEPTH = 64;
/** Longest program name shown; the kernel's comm is 15 bytes. */
const MAX_NAME = 32;

export interface BackgroundWork {
  /** The program's name (comm), never its arguments. */
  name: string;
  pid: number;
  /** 'orphan' (a: in the scope, outside the agent's tree) or 'shell' (b: below a shell the agent started). */
  kind: 'orphan' | 'shell';
  /** The pid of the work's stable top: the topmost orphan (a) or the first shell below the agent (b). */
  top: number;
}

/** The check could not be completed: what failed ('read', 'truncated'; IdleSleep adds 'error') and why, with no argument. */
export interface BackgroundUnchecked {
  unchecked: string;
  reason: string;
}

/** Background work, a check that could not be completed, or null when nothing keeps the agent awake. */
export type BackgroundResult = BackgroundWork | BackgroundUnchecked | null;

export const isUnchecked = (result: BackgroundResult): result is BackgroundUnchecked => result !== null && 'unchecked' in result;

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;
const errorReason = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface BackgroundScan {
  roots?: ResourceRoots;
  /** The user whose manager holds the scope. */
  uid?: number;
  /** The terminal's pty child. */
  pid: number;
  /** Its scope unit (`mirador-agent-<id>.scope`), null without scopes. */
  scope: string | null;
  /** Command lines (`command`, then `args`) of the MCP servers configured for that agent. */
  mcp?: string[][];
}

const programName = (name: string | null | undefined) => {
  const clean = (name ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().replace(/^-/, '');
  return clean ? clean.slice(0, MAX_NAME) : null;
};

/** The words of a shell script, as a shell splits a simple command: quotes and backslashes honoured, nothing expanded. */
export function shellWords(script: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < script.length; i++) {
    const c = script[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < script.length && '"\\$`'.includes(script[i + 1])) word += script[++i];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      word ??= '';
    } else if (c === '\\' && i + 1 < script.length) {
      word = (word ?? '') + script[++i];
    } else if (/\s/.test(c)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? '') + c;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

/** The command a process runs: its argv, or the words of the script a shell runs with `-c` (an `exec` before it dropped). */
function commandOf(argv: string[]): string[] {
  const flag = argv.findIndex((arg, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(arg));
  if (!SHELLS.has(basename(argv[0] ?? '')) || flag < 0 || argv[flag + 1] === undefined) return argv;
  const words = shellWords(argv[flag + 1]);
  return words[0] === 'exec' ? words.slice(1) : words;
}

/** A pipe or a socket, as `/proc/<pid>/fd/<n>` names one. */
const CONNECTED = /^(pipe|socket):\[\d+\]$/;

const normal = (words: string[]) => (words.length ? [basename(words[0]), ...words.slice(1)].join('\0') : '');

/** Whether `argv` (or the `sh -c` script it runs) is one of the configured MCP servers' command lines. */
export function matchesMcp(argv: string[], mcp: string[][]): boolean {
  if (!argv.length || !mcp.length) return false;
  const mine = new Set([normal(argv), normal(commandOf(argv))]);
  return mcp.some((server) => mine.has(normal(server)) || mine.has(normal(commandOf(server))));
}

/**
 * What keeps the agent awake, null when nothing does or there is no /proc, or `unchecked` when the check
 * could not be completed. Never throws.
 */
export async function findBackgroundWork(scan: BackgroundScan): Promise<BackgroundResult> {
  try {
    return await scanFor(scan);
  } catch (error) {
    return { unchecked: 'read', reason: errorReason(error) };
  }
}

async function scanFor(scan: BackgroundScan): Promise<BackgroundResult> {
  const roots = scan.roots ?? DEFAULT_ROOTS;
  const mcp = scan.mcp ?? [];
  // No /proc (macOS): nothing to read, so nothing is checked. Any other failure to list it throws.
  try {
    await readdir(roots.proc);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
  const table = new ProcessTable(roots.proc);
  await table.load(MAX_PROCESSES);
  if (table.truncated) return { unchecked: 'truncated', reason: `more than ${MAX_PROCESSES} processes, so its process tree may be incomplete` };
  if (!table.byPid.has(scan.pid)) {
    // Gone: the terminal is ending. Still there: its status could not be read.
    const gone = await stat(join(roots.proc, String(scan.pid))).then(
      () => false,
      (error) => (errorCode(error) === 'ENOENT' ? true : Promise.reject(error)),
    );
    return gone ? null : { unchecked: 'read', reason: `cannot read the status of its terminal's process (PID ${scan.pid})` };
  }
  const tree = new Set(table.tree(scan.pid));
  // Processes missing from the table (started after it was read): their name and parent, from their status file; null once gone.
  const late = new Map<number, { name: string | null; ppid: number | undefined } | null>();
  const statusOf = async (pid: number) => {
    const known = table.byPid.get(pid);
    if (known) return { name: known.name, ppid: known.ppid };
    if (!late.has(pid)) {
      const text = await readFile(join(roots.proc, String(pid), 'status'), 'utf8').catch(() => null);
      const ppid = text?.match(/^PPid:\s+(\d+)/m)?.[1];
      late.set(pid, text === null ? null : { name: text.match(/^Name:\t(.*)$/m)?.[1] ?? null, ppid: ppid === undefined ? undefined : Number(ppid) });
    }
    return late.get(pid)!;
  };
  const ppidOf = (pid: number) => table.byPid.get(pid)?.ppid ?? late.get(pid)?.ppid;
  // Whether a process missing from the table runs below the pty child: followed up through status files.
  const inTree = async (pid: number) => {
    let at = (await statusOf(pid))?.ppid;
    for (let depth = 0; at !== undefined && at > 0 && depth < MAX_DEPTH; depth++) {
      if (tree.has(at)) return true;
      at = (await statusOf(at))?.ppid;
    }
    return false;
  };
  const nameOf = (pid: number) => programName(table.byPid.get(pid)?.name ?? late.get(pid)?.name);
  const isShell = (pid: number) => SHELLS.has(nameOf(pid) ?? '');
  const argvs = new Map<number, Promise<string[]>>();
  const argv = (pid: number) => {
    if (!argvs.has(pid)) argvs.set(pid, table.argv(pid));
    return argvs.get(pid)!;
  };
  const anyMcp = async (pids: number[]) => {
    for (const pid of pids) if (matchesMcp(await argv(pid), mcp)) return true;
    return false;
  };
  // A stdio MCP server's transport: its stdin and stdout both a pipe or a socket.
  const fd = (pid: number, n: number) => readlink(join(roots.proc, String(pid), 'fd', String(n))).catch(() => '');
  const stdioServer = async (pid: number) => CONNECTED.test(await fd(pid, 0)) && CONNECTED.test(await fd(pid, 1));
  const found: BackgroundWork[] = [];

  // Started after the table was read, below the pty child: classed with the tree in (b).
  const lateInTree: number[] = [];

  // (a) In the scope, outside the tree: orphans. No scope unit (ENOENT): none to read; any other read error throws.
  if (scan.scope && scan.uid !== undefined) {
    const procs = await readFile(join(scopeDir(roots, scan.uid, scan.scope), 'cgroup.procs'), 'utf8').catch((error) =>
      errorCode(error) === 'ENOENT' ? '' : Promise.reject(error),
    );
    const orphans: number[] = [];
    for (const line of procs.split('\n')) {
      const pid = Number(line.trim());
      if (!Number.isInteger(pid) || pid <= 0 || tree.has(pid)) continue;
      await statusOf(pid);
      // Gone since cgroup.procs was read.
      if (!nameOf(pid)) continue;
      if (!table.byPid.has(pid) && (await inTree(pid))) lateInTree.push(pid);
      else orphans.push(pid);
    }
    const orphaned = new Set(orphans);
    for (const pid of orphans) {
      if (await anyMcp([pid])) continue;
      let top = pid;
      for (let depth = 0, up = ppidOf(top); up !== undefined && orphaned.has(up) && depth < MAX_DEPTH; depth++, up = ppidOf(top)) top = up;
      found.push({ name: nameOf(pid)!, pid, kind: 'orphan', top });
    }
  }

  // (b) Below the agent through a shell.
  for (const pid of [...tree, ...lateInTree]) {
    if (pid === scan.pid) continue;
    const chain: number[] = [];
    for (let at: number | undefined = pid, depth = 0; at !== undefined && at !== scan.pid && depth < MAX_DEPTH; depth++) {
      chain.unshift(at);
      at = ppidOf(at);
    }
    // The launching shells, down to the agent: chain[agent].
    let agent = 0;
    while (agent < chain.length && isShell(chain[agent])) agent++;
    if (agent >= chain.length) continue;
    const below = chain.slice(agent + 1);
    const shell = below.find(isShell);
    if (shell === undefined) continue;
    if (await anyMcp(below)) continue;
    if (await stdioServer(shell)) continue;
    const name = nameOf(pid);
    if (name) found.push({ name, pid, kind: 'shell', top: shell });
  }

  // One reason, the same at every check while it lasts: orphans, then the oldest top; within it the program
  // rather than the shell that runs it, then the oldest pid.
  found.sort(
    (a, b) =>
      Number(a.kind === 'shell') - Number(b.kind === 'shell') || a.top - b.top || Number(SHELLS.has(a.name)) - Number(SHELLS.has(b.name)) || a.pid - b.pid,
  );
  return found[0] ?? null;
}

export interface BackgroundCheckOptions {
  registry: Pick<TerminalRegistry, 'get' | 'processOf'>;
  roots?: ResourceRoots;
  uid?: number;
  /** Config `agentCommand`: the agent a terminal without a catalog id runs. */
  agentCommand: string;
  /** gentle-shell's agent dir (gentleShellAgentDir in src/mcp/project-mcp.ts), read at each check. */
  agentDir: () => string;
}

/**
 * IdleSleep's `background` check for terminal `id`. A Pi agent's MCP servers are the ones Mirador reads
 * for its folder (gentle-shell's `mcp.json` and the folder's `.pi/mcp.json`, mcpServerCommands); Mirador
 * reads no MCP config of the other agents, which start their servers directly anyway.
 */
export function backgroundCheck(options: BackgroundCheckOptions): (id: string) => Promise<BackgroundResult> {
  const uid = options.uid ?? process.getuid?.();
  return async (id) => {
    const info = options.registry.get(id);
    const where = options.registry.processOf(id);
    if (!info || !where) return null;
    const pi = terminalAgent(info.agent, options.agentCommand)?.id === 'pi';
    const mcp = pi ? await mcpServerCommands({ folder: info.cwd, agentDir: options.agentDir() }).catch(() => []) : [];
    return findBackgroundWork({ roots: options.roots, uid, pid: where.pid, scope: where.scope, mcp });
  };
}
