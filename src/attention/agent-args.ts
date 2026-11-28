import { AGENTS, SESSION, SESSION_ID, agentFor, type AgentEntry } from '../agents/catalog.ts';
import type { EnvProvider } from '../terminals/registry.ts';

/**
 * The catalog agent an agent terminal (or its open-agents record) runs: the one chosen by catalog id
 * (`agent`), else the configured `agentCommand`'s (agentFor); null for a command outside the catalog or an
 * id Mirador no longer knows. The rule that gives a terminal its bridge (bridgeArgs for the configured
 * agent, addChosenAgentArgs for a chosen one, bridgeEnvProvider), so it is also what makes a sleeper
 * Claude Code when forgetting it removes the folder's left-off record (DELETE /api/terminals/sleeping/:id).
 */
export function terminalAgent(agent: string | null | undefined, agentCommand: string): AgentEntry | null {
  return agent ? (AGENTS.find((entry) => entry.id === agent) ?? null) : agentFor(agentCommand);
}

/**
 * `<flag> <bridge>` when Mirador can load its attention bridge into `agentCommand`:
 * a plain invocation of a catalog agent with a bridge (gentle-shell or pi, `-e`; claude,
 * `--settings`; agy, `--add-dir`), optionally with its own flags. `bridges` gives each agent's bridge by catalog
 * id; a lone path is the gentle-shell bridge, for pi only. An agent whose bridge rides in its
 * environment (catalog `bridgeEnv`, opencode) gets its flag alone, and bridgeEnvProvider the rest.
 * Any other command is left exactly as configured, and so is everything when `enabled` (config
 * `attentionBridge`) is false.
 */
export function bridgeArgs(agentCommand: string, bridges: string | Readonly<Record<string, string>>, enabled = true): string[] {
  if (!enabled) return [];
  const agent = agentFor(agentCommand);
  if (!agent?.bridgeFlag) return [];
  const bridge = typeof bridges === 'string' ? (agent.id === 'pi' ? bridges : undefined) : bridges[agent.id];
  if (!bridge) return [];
  return agent.bridgeEnv ? [agent.bridgeFlag] : [agent.bridgeFlag, bridge];
}

/**
 * The environment that carries the bridge of an agent whose catalog entry has a `bridgeEnv` (opencode),
 * for agent terminals that run it: chosen by id, or the configured `agentCommand` when no id was given,
 * exactly where bridgeArgs adds its flag. Every other terminal, and all of them when `enabled` is false,
 * gets nothing.
 */
export function bridgeEnvProvider(agentCommand: string, bridges: Readonly<Record<string, string>>, enabled = true): EnvProvider {
  return (info) => {
    if (!enabled || info.kind !== 'agent') return {};
    const agent = terminalAgent(info.agent, agentCommand);
    const bridge = agent?.bridgeEnv ? bridges[agent.id] : undefined;
    return agent?.bridgeEnv && bridge ? { [agent.bridgeEnv]: bridge } : {};
  };
}

/**
 * The words that reopen `session` in `agentCommand`: the catalog agent's verified resume
 * argv (`--session <file>` for gentle-shell or pi, `--resume <id>` for claude, `--session <id>` for
 * opencode, `--conversation <id>` for agy). None for any other command, or for a session its agent cannot take (an id-resumed agent
 * given anything but a SESSION_ID, such as a pi session file; a file-resumed one given a SESSION_ID, not
 * a path), which then starts a fresh session. So does an agent `withoutBridge` names by catalog id (an opencode
 * older than 2.0.0, src/agents/opencode-version.ts): without its bridge it has no verified resume.
 */
export function resumeArgs(agentCommand: string, session: string, withoutBridge?: ReadonlySet<string>): string[] {
  const agent = agentFor(agentCommand);
  if (!agent?.resume || withoutBridge?.has(agent.id) || (agent.resumeKey === 'id') !== SESSION_ID.test(session)) return [];
  return agent.resume.map((word) => (word === SESSION ? session : word));
}
