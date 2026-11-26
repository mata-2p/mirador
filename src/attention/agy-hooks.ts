import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { shellQuote } from '../terminals/registry.ts';

/**
 * agy's (Antigravity CLI) attention bridge. agy reads hooks from
 * `~/.gemini/config/hooks.json`, from plugins, and from `.agents/hooks.json` in each workspace folder: the
 * folder it starts in and each one added with `--add-dir` (https://antigravity.google/docs/hooks,
 * https://antigravity.google/docs/customization-discovery). So Mirador never touches `~/.gemini` or a
 * project's `.agents`: it writes its hooks into a folder of its own and starts agy with `--add-dir <folder>`
 * (the catalog's bridgeFlag); hooks from every location run, so the user's own still do. Each hook runs
 * bin/agy-hook with Mirador's node and the event's name, since agy's payload does not carry it; the script
 * reports through the herdr socket as bin/claude-hook does: a model call or a tool is working, a question or a
 * permission request waiting, Stop finished, each with the payload's `conversationId`, which Mirador records
 * to resume with `--conversation <id>`. The working report expires after 10 minutes without a hook, so every
 * model call and finished tool (PreInvocation, PostInvocation, PostToolUse for any tool) refreshes it: agy sends
 * no hook when the user interrupts a turn (Esc), and the agent then reads `unknown` instead of staying working.
 * PreToolUse runs only for the tools that wait for an answer: the script answers it `{"decision":"allow"}`, and
 * for every tool that could bypass agy's own permission policy. SessionStart is left out: a report would mark
 * an agent that has not started a turn as working, and the PreInvocation that follows it names the same
 * conversation.
 */
export const AGY_HOOK_EVENTS = ['PreInvocation', 'PreToolUse', 'PostToolUse', 'PostInvocation', 'Stop'] as const;
/** The tools that wait for an answer (https://antigravity.google/docs/hooks#supported-tools); PreToolUse runs for them only. */
export const AGY_WAITING_TOOLS = 'ask_question|ask_permission';
/** PostToolUse's matcher: an empty one matches every tool. */
const EVERY_TOOL = '';
/** The hook group's name in hooks.json, as `/hooks` lists it. */
const GROUP = 'mirador-attention';
/** Seconds agy gives a hook (it defaults to 30); the script gives up after one. */
const HOOK_TIMEOUT_S = 5;

type Handler = { type: 'command'; command: string; timeout: number };

/** The hooks.json that runs `command <event>` on every event Mirador follows. */
export function agyHooks(command: string): Record<string, Record<string, Array<Handler | { matcher: string; hooks: Handler[] }>>> {
  const handler = (event: string): Handler => ({ type: 'command', command: `${command} ${event}`, timeout: HOOK_TIMEOUT_S });
  const matcher = (event: string) => (event === 'PreToolUse' ? AGY_WAITING_TOOLS : event === 'PostToolUse' ? EVERY_TOOL : null);
  const entries = (event: string) => {
    const tools = matcher(event);
    return tools === null ? [handler(event)] : [{ matcher: tools, hooks: [handler(event)] }];
  };
  return { [GROUP]: Object.fromEntries(AGY_HOOK_EVENTS.map((event) => [event, entries(event)])) };
}

/**
 * Writes `<dir>/agy-workspace/.agents/hooks.json` (folders 0700, the file 0600, in Mirador's 0700 herdr
 * folder), whose hooks run `hookPath` with `nodePath` (the agent's PATH may not have a node), and returns the
 * folder agy adds with `--add-dir`. It holds nothing else: agy shows it to the agent as a workspace folder.
 */
export async function prepareAgyHooks(dir: string, hookPath: string, nodePath = process.execPath): Promise<string> {
  const folder = join(dir, 'agy-workspace');
  const agents = join(folder, '.agents');
  await mkdir(agents, { recursive: true, mode: 0o700 });
  for (const path of [folder, agents]) await chmod(path, 0o700);
  const file = join(agents, 'hooks.json');
  await writeFile(file, `${JSON.stringify(agyHooks(`${shellQuote(nodePath)} ${shellQuote(hookPath)}`), null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return folder;
}
