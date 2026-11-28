import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { readInstalledAgents } from './gentle-ai-state.ts';

/**
 * The terminal agents Mirador knows how to open, keyed by gentle-ai id.
 * IDE-only gentle-ai ids (cursor, vscode-copilot,
 * windsurf, kiro-ide, trae-ide) have no terminal agent and are left out on purpose.
 */
export interface AgentEntry {
  /** gentle-ai's id for the agent, as written in `installed_agents`. */
  readonly id: string;
  readonly label: string;
  /** The program looked up on PATH. */
  readonly binary: string;
  /** Other program names that start the same agent and take the same flags (pi behind gentle-shell). */
  readonly aliases: readonly string[];
  /** The argv that starts a fresh session, binary first. */
  readonly launch: readonly string[];
  /** The verified argv that reopens a session, with SESSION where it goes; null until verified. */
  readonly resume: readonly string[] | null;
  /**
   * What SESSION stands for: `file`, the session file its bridge reports (pi), or `id`, the session id
   * its hooks or plugin report (claude-code, opencode, antigravity), which must be a SESSION_ID so it never reads as an option.
   */
  readonly resumeKey: 'file' | 'id';
  /** How Mirador learns the agent is working, waiting or done. */
  readonly attention: 'none' | 'hooks';
  /** The flag that loads Mirador's attention bridge (`<flag> <bridge>`: pi's extension, claude's settings file, agy's hook folder); null without a bridge. */
  readonly bridgeFlag: string | null;
  /**
   * The environment variable that carries the bridge when it cannot go on the command line (opencode's
   * OPENCODE_CONFIG_CONTENT); `bridgeFlag` then goes alone. Absent for a bridge passed as `<flag> <bridge>`.
   */
  readonly bridgeEnv?: string;
}

/** Stands for the session file or id in an entry's `resume` argv. */
export const SESSION = '{session}';
/** A session id an agent's hooks report, as Mirador accepts it: a letter or digit first, so never an option. */
export const SESSION_ID = /^[A-Za-z0-9][\w-]{0,127}$/;

const launchOnly = (id: string, label: string, binary: string): AgentEntry => ({
  id, label, binary, aliases: [], launch: [binary], resume: null, resumeKey: 'id', attention: 'none', bridgeFlag: null,
});

// pi, claude-code, opencode and antigravity are verified here. The others start a fresh session with no attention;
// their resume flags from the research stay out, since without a bridge nothing reports the session to resume.
// kimi (Kimi Code CLI) reads `[[hooks]]` only from `$KIMI_CODE_HOME/config.toml` and installed plugins, with no
// flag, variable or project file that adds hooks for one launch (https://moonshotai.github.io/kimi-code/en/customization/hooks,
// /en/configuration/overrides), and KIMI_CODE_HOME moves the user's config, credentials and sessions with it
// (/en/configuration/env-vars). So kimi stays launch-only: no `--session <id>` without an id, and `-c` would take the
// folder's latest session, which another kimi terminal in the same folder may own.
export const AGENTS: readonly AgentEntry[] = [
  {
    id: 'pi',
    label: 'Pi (gentle-shell)',
    binary: 'gentle-shell',
    aliases: ['pi'],
    launch: ['gentle-shell'],
    resume: ['--session', SESSION],
    resumeKey: 'file',
    attention: 'hooks',
    bridgeFlag: '-e',
  },
  // The hooks come from a settings file Mirador writes and passes per launch (src/attention/claude-hooks.ts);
  // `--resume <session id>` per https://code.claude.com/docs/en/cli-reference.
  {
    id: 'claude-code',
    label: 'Claude Code',
    binary: 'claude',
    aliases: [],
    launch: ['claude'],
    resume: ['--resume', SESSION],
    resumeKey: 'id',
    attention: 'hooks',
    bridgeFlag: '--settings',
  },
  // opencode 2 runs plugins in its server, shared by every opencode of the user unless started with
  // `--standalone` (a private server that inherits the terminal's environment), so Mirador adds that flag and
  // names its plugin in OPENCODE_CONFIG_CONTENT (src/attention/opencode-plugin.ts). `--session <id>` continues a
  // session (https://opencode.ai/docs/cli/, packages/cli/src/commands/commands.ts in anomalyco/opencode). That needs
  // opencode 2.0.0 or newer; an older one starts with neither, like Codex (src/agents/opencode-version.ts).
  {
    id: 'opencode',
    label: 'opencode',
    binary: 'opencode',
    aliases: [],
    launch: ['opencode'],
    resume: ['--session', SESSION],
    resumeKey: 'id',
    attention: 'hooks',
    bridgeFlag: '--standalone',
    bridgeEnv: 'OPENCODE_CONFIG_CONTENT',
  },
  // agy reads hooks from `.agents/hooks.json` in each workspace folder, and `--add-dir` adds one per launch
  // (https://antigravity.google/docs/hooks, /docs/customization-discovery), so Mirador adds the folder holding its
  // hooks (src/attention/agy-hooks.ts). `--conversation <id>` resumes the conversation the hooks name
  // (https://antigravity.google/docs/cli/commands/resume); `-c` would take the folder's latest one instead.
  {
    id: 'antigravity',
    label: 'Antigravity',
    binary: 'agy',
    aliases: [],
    launch: ['agy'],
    resume: ['--conversation', SESSION],
    resumeKey: 'id',
    attention: 'hooks',
    bridgeFlag: '--add-dir',
  },
  launchOnly('codex', 'Codex', 'codex'),
  launchOnly('gemini-cli', 'Gemini CLI', 'gemini'),
  launchOnly('kimi', 'Kimi', 'kimi'),
];

/**
 * Anything that could move appended words away from the agent's own arguments:
 * command separators, pipes, redirections, subshells, command substitution,
 * comments and line continuations.
 */
const NOT_PLAIN = /[;&|<>()`#\\\n]|\$\(/;

/**
 * The catalog agent a configured command starts: a plain invocation (optionally with its
 * own flags) whose program, by name, is an entry's binary or alias. Anything Mirador could
 * not safely add words to is null.
 */
export function agentFor(command: string): AgentEntry | null {
  if (NOT_PLAIN.test(command)) return null;
  const [program] = command.trim().split(/\s+/);
  if (!program) return null;
  const name = basename(program);
  return AGENTS.find((agent) => agent.binary === name || agent.aliases.includes(name)) ?? null;
}

/** How an agent terminal of a chosen catalog agent starts. */
export interface AgentLaunch {
  /** The catalog id, kept on the terminal and on its open-agents record. */
  agent: string;
  /**
   * The command line of an agent other than the configured one. Absent for the configured
   * agent, which starts exactly as without an id, with Mirador's global agent args (its bridge).
   */
  agentCommand?: string;
}

/** How catalog agent `id` starts beside the configured `agentCommand`; null for an id outside the catalog. */
export function agentLaunch(id: string, agentCommand: string): AgentLaunch | null {
  const entry = AGENTS.find((agent) => agent.id === id);
  if (!entry) return null;
  return entry === agentFor(agentCommand) ? { agent: id } : { agent: id, agentCommand: entry.launch.join(' ') };
}

/** The first executable file `program` in PATH's absolute directories, or null. */
export async function whichOnPath(program: string, path: string | undefined): Promise<string | null> {
  for (const dir of (path ?? '').split(':')) {
    if (!dir || !isAbsolute(dir)) continue;
    const file = join(dir, program);
    try {
      if ((await stat(file)).isFile()) {
        await access(file, constants.X_OK);
        return file;
      }
    } catch {
      // Not here: try the next directory.
    }
  }
  return null;
}

/** Whether `program` is an executable file in one of PATH's absolute directories. */
export async function onPath(program: string, path: string | undefined): Promise<boolean> {
  return (await whichOnPath(program, path)) !== null;
}

/** An agent the user can open in a folder (GET /api/agents). */
export interface OfferedAgent {
  /** The catalog id, or null for a configured command outside the catalog. */
  id: string | null;
  label: string;
  /** The command line that starts it. */
  command: string;
  /** True for the config's `agentCommand`, which is always offered. */
  configured: boolean;
  attention: AgentEntry['attention'];
  /** Whether a closed session can be reopened; otherwise it starts fresh. */
  resume: boolean;
}

/**
 * The configured `agentCommand` first, as today, then gentle-ai's `installed_agents` ∩ the
 * catalog ∩ binaries on PATH, in catalog order. `env` supplies PATH and GENTLE_AI_HOME/HOME.
 * `withoutBridge` names the catalog ids that start without their bridge (an opencode older than 2.0.0,
 * src/agents/opencode-version.ts): they are offered with no attention and no resume, like Codex.
 */
export async function offeredAgents(options: { agentCommand: string; env?: NodeJS.ProcessEnv; withoutBridge?: ReadonlySet<string> }): Promise<OfferedAgent[]> {
  const env = options.env ?? process.env;
  const configured = agentFor(options.agentCommand);
  const limits = (agent: AgentEntry | null): Pick<OfferedAgent, 'attention' | 'resume'> =>
    agent && options.withoutBridge?.has(agent.id) ? { attention: 'none', resume: false } : { attention: agent?.attention ?? 'none', resume: agent?.resume != null };
  const offered: OfferedAgent[] = [{
    id: configured?.id ?? null,
    label: configured?.label ?? options.agentCommand,
    command: options.agentCommand,
    configured: true,
    ...limits(configured),
  }];
  const installed = new Set(await readInstalledAgents(env));
  for (const agent of AGENTS) {
    if (agent === configured || !installed.has(agent.id) || !(await onPath(agent.binary, env.PATH))) continue;
    offered.push({ id: agent.id, label: agent.label, command: agent.launch.join(' '), configured: false, ...limits(agent) });
  }
  return offered;
}
