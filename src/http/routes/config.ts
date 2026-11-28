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
      // than 2.0.0 is offered with no attention and no resume, as it starts without its bridge. It answers at once
      // with what the server knows (ctx.opencodeVersion) and never runs opencode: until the first opencode terminal
      // needed the version, opencode is offered with its bridge, as for a version that could not be read.
      method: 'GET',
      path: '/api/agents',
      handler: async ({ res }) =>
        sendJson(res, 200, { agents: await offeredAgents({ agentCommand: ctx.config.agentCommand, withoutBridge: withoutBridge(ctx.opencodeVersion?.()) }) }),
    },
  ];
}

export const configRoutes: RouteModule = createConfigRoutes();
