import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { shellQuote } from '../terminals/registry.ts';

/**
 * Claude Code's attention bridge. Claude reads its hooks from its
 * settings, so Mirador writes its own settings file and passes it on each launch with
 * `--settings <file>` (the catalog's bridgeFlag), never touching `~/.claude` or a project's
 * `.claude`; Claude merges hooks across settings levels, so the user's own hooks still run
 * (https://code.claude.com/docs/en/hooks). Every hook runs bin/claude-hook with Mirador's node, which
 * reports through the herdr socket as the gentle-shell bridge does: a submitted prompt or a tool call
 * (before and after it runs) is working, a Notification that waits for an answer is waiting, Stop is
 * finished, and each report carries the hook's `session_id`, which Mirador records to resume with
 * `--resume <id>`. The working report expires after 10 minutes without a hook: Stop does not run when the
 * user interrupts a turn, and the agent then reads `unknown` instead of staying working.
 * The script also forwards the prompt, the final message, PostCompact's summary and SessionEnd's reason
 * to the server for "where it left off" (src/memory/left-off.ts), unless it runs with `--no-left-off`
 * (config `leftOff: false`). SessionEnd hooks share a short budget; the script gives up after one second.
 */
export const CLAUDE_HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'PostCompact', 'SessionEnd'] as const;
/**
 * Seconds Claude gives a hook; the script gives up after one. The hooks run in the foreground, so
 * Claude starts them in order and their reports (numbered from the clock) arrive in order.
 */
const HOOK_TIMEOUT_S = 5;

/** The settings that run `command` on every hook event Mirador follows, for any matcher. */
export function claudeSettings(command: string): { hooks: Record<string, Array<{ hooks: Array<{ type: 'command'; command: string; timeout: number }> }>> } {
  return { hooks: Object.fromEntries(CLAUDE_HOOK_EVENTS.map((event) => [event, [{ hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }] }]])) };
}

/**
 * Writes `<dir>/claude-settings.json` (mode 0600, in Mirador's 0700 herdr folder), whose hooks run
 * `hookPath` with `nodePath` (the agent's PATH may not have a node), and returns its path. With
 * `leftOff: false` the command carries `--no-left-off`: the hooks report attention only.
 */
export async function prepareClaudeSettings(dir: string, hookPath: string, nodePath = process.execPath, options: { leftOff?: boolean } = {}): Promise<string> {
  const file = join(dir, 'claude-settings.json');
  const command = `${shellQuote(nodePath)} ${shellQuote(hookPath)}${options.leftOff === false ? ` ${shellQuote('--no-left-off')}` : ''}`;
  await writeFile(file, `${JSON.stringify(claudeSettings(command), null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}
