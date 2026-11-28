import { offeredAgents } from '../../agents/catalog.ts';
import { withoutBridge } from '../../agents/opencode-version.ts';
import { resolveMode } from '../../mode.ts';
import type { RouteModule } from '../context.ts';
import { sendJson } from '../respond.ts';

/** `env` is what `auto` mode looks at (GENTLE_AI_HOME/HOME and PATH); tests pass a scratch one. */
export function createConfigRoutes(options: { env?: NodeJS.ProcessEnv } = {}): RouteModule {
  const env = options.env ?? process.env;
  return (ctx) => [
    {
      // `mode` is resolved per request: the UI hides the gentle extras in plain.
      method: 'GET',
      path: '/api/config',
      handler: async ({ res }) =>
        sendJson(res, 200, { agentCommand: ctx.config.agentCommand, timeZone: ctx.config.timeZone, today: ctx.today(), mode: await resolveMode(ctx.config.mode, env) }),
    },
    {
      // The agents a folder can open, read from gentle-ai's state and PATH per request; an opencode older
      // than 2.0.0 is offered with no attention and no resume, as it starts without its bridge. So it waits for the
      // `opencode --version` the server reads at start (ctx.opencodeVersion), the whole list: a few hundred ms after
      // start, OPENCODE_VERSION_TIMEOUT_MS at most, and no wait once it is known or with no opencode found.
      method: 'GET',
      path: '/api/agents',
      handler: async ({ res }) =>
        sendJson(res, 200, { agents: await offeredAgents({ agentCommand: ctx.config.agentCommand, withoutBridge: withoutBridge(await ctx.opencodeVersion) }) }),
    },
  ];
}

export const configRoutes: RouteModule = createConfigRoutes();
