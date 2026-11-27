import { IDLE_SLEEP_MINUTES, configPath, idleSleepMs, saveSettings } from '../../config.ts';
import { idleSleepOf } from '../../terminals/hibernate.ts';
import type { RouteModule } from '../context.ts';
import { HttpError, readJson, sendJson } from '../respond.ts';

/** The longest threshold Settings takes, in minutes (one week), as config `idleSleepMinutes`. */
const MAX_MINUTES = 10_080;

/** Idle sleep as Settings shows it: the switch, and the threshold in whole minutes. */
export interface IdleSleepSetting {
  on: boolean;
  minutes: number;
}

/**
 * Settings → idle sleep (#115). GET /api/settings/idle-sleep answers `{ on, minutes }`: off when config
 * `idleSleep` is false or the threshold is 0 (`idleSleepHours: 0`); `minutes` is `idleSleepMinutes`, else
 * `idleSleepHours` × 60, else 240 (shown when the threshold is 0). PUT takes `{ on, minutes }` (a whole
 * number from 1 to 10080), saves them as `idleSleep` and `idleSleepMinutes` in config.json (saveSettings:
 * every other key stays) and applies them at once to the running idle sleep (IdleSleep.setIdleMs), with no
 * restart. Anything else is a 400 `idle_sleep_invalid` and config.json is left as it was. `configFile` is a
 * test seam; the server saves to configPath().
 */
export function createIdleSleepRoutes(options: { configFile?: string } = {}): RouteModule {
  return (ctx) => {
    const threshold = idleSleepMs(ctx.config);
    let current: IdleSleepSetting = {
      on: threshold > 0,
      minutes: threshold > 0 ? Math.max(1, Math.round(threshold / 60_000)) : (ctx.config.idleSleepMinutes ?? IDLE_SLEEP_MINUTES),
    };
    return [
      {
        method: 'GET',
        path: '/api/settings/idle-sleep',
        handler: async ({ res }) => sendJson(res, 200, current),
      },
      {
        method: 'PUT',
        path: '/api/settings/idle-sleep',
        handler: async ({ req, res }) => {
          const body = await readJson(req);
          if (Object.keys(body).some((key) => key !== 'on' && key !== 'minutes')) throw new HttpError(400, 'only on and minutes can be saved', 'idle_sleep_invalid');
          if (typeof body.on !== 'boolean') throw new HttpError(400, 'on must be true or false', 'idle_sleep_invalid');
          const minutes = body.minutes;
          if (!Number.isInteger(minutes) || (minutes as number) < 1 || (minutes as number) > MAX_MINUTES) {
            throw new HttpError(400, `minutes must be a whole number from 1 to ${MAX_MINUTES}`, 'idle_sleep_invalid');
          }
          const next: IdleSleepSetting = { on: body.on, minutes: minutes as number };
          await saveSettings({ idleSleep: next.on, idleSleepMinutes: next.minutes }, options.configFile ?? configPath());
          current = next;
          idleSleepOf(ctx.terminals)?.setIdleMs(next.on ? next.minutes * 60_000 : 0);
          sendJson(res, 200, current);
        },
      },
    ];
  };
}

export const idleSleepRoutes: RouteModule = createIdleSleepRoutes();
