import { chmod, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * A named folder Mirador shows as one group in the sidebar. `folders` lists the
 * folders the user chose, relative to `root`; an empty list shows every first-level
 * folder. `expanded` lists the folders whose subfolders are shown.
 */
export interface Workspace {
  id: string;
  name: string;
  root: string;
  folders: string[];
  expanded: string[];
  /** Markdown guide for the night shift; absent when unset. */
  mission?: string;
  /** The saved project set: folders (relative to `root`) opened together with one click; absent when empty. */
  projects?: string[];
}

/**
 * Which face Mirador shows: gentle-deck, with the Gentle ecosystem
 * extras, or plain Mirador without them. `auto` picks one per request (src/mode.ts).
 */
export const MODES = ['auto', 'gentle-deck', 'plain'] as const;
export type Mode = (typeof MODES)[number];

export interface MiradorConfig {
  workspaces: Workspace[];
  port: number;
  engramUrl: string;
  agentCommand: string;
  /** Must be bash: agent terminals rely on `bash --rcfile`. */
  shell: string;
  ignore: string[];
  timeZone: string;
  /** Load Mirador's attention bridge into plain gentle-shell/pi agent commands (src/attention/agent-args.ts). */
  attentionBridge: boolean;
  /** gentle-deck, plain or auto (src/mode.ts); anything else is auto. */
  mode: Mode;
  /** Claude model id for night shift decisions and the judge through the Claude bridge; unset = the resource profile's (src/profiles.ts). */
  nightModel?: string;
  /** How long one all-projects Engram read is shared, in ms (unset = the resource profile's; MIRADOR_ENGRAM_CACHE_MS wins). */
  engramCacheMs?: number;
  /** Claude processes at once across the night decider, the judge and "Mejorar con IA"; unset = the resource profile's (src/profiles.ts). */
  maxConcurrent?: number;
  /** Decider, follow-up and judge calls per night (src/night/budget.ts); unset = the resource profile's. */
  nightBudget?: number;
  /** Run each terminal in its own systemd user scope when systemd-run works (src/terminals/scopes.ts); only false (or MIRADOR_SCOPES=0) turns it off. */
  scopes?: boolean;
  /** Night shift notification channels (src/night/notify.ts); each is on unless set to false. */
  notifications?: { desktop?: boolean; telegram?: boolean };
  /** How agents opened in a row start (src/system/memory-gate.ts); each key unset = its default. */
  launches?: Launches;
  /** Idle sleep (src/terminals/hibernate.ts): hours an agent's turn stays finished before it sleeps; 0 = off. `idleSleepMinutes` wins. */
  idleSleepHours?: number;
  /** Idle sleep's switch (Settings): only false turns it off. */
  idleSleep?: boolean;
  /** Idle sleep's threshold in whole minutes (Settings), 1 to 10080; set, it wins over `idleSleepHours`. */
  idleSleepMinutes?: number;
  /** The browser bin/mirador opens the app window with (a command on PATH or a macOS app name); unset = the Chromium-family list (src/doctor.ts BROWSERS, MAC_APPS). */
  browser?: string;
  /**
   * The owner's name as the night shift's and "Mejorar con IA"'s prompts, the texts agents receive and
   * the night reasons say it (ownerNameFrom); unset = DEFAULT_OWNER_NAME, so no prompt names anyone.
   */
  ownerName?: string;
  /**
   * "Where it left off" from Claude Code's hooks (src/memory/left-off.ts): only false turns it off; then the
   * hooks forward nothing and no record is written or read.
   */
  leftOff?: boolean;
  /** Days a local left-off record is kept before it is removed; unset or not valid = LEFT_OFF_DAYS. */
  leftOffDays?: number;
}

/** Agent launch pacing: agents per batch, settle after a batch, memory left free, longest wait for memory. */
export interface Launches {
  batchSize?: number;
  settleMs?: number;
  /** 0 never waits for memory; unset = max(2 GiB, 15 % of RAM). */
  reserveMb?: number;
  maxWaitMs?: number;
}

/** Each `launches` key with its whole-number range. */
const LAUNCH_RANGES: Record<keyof Launches, [number, number]> = {
  batchSize: [1, 50],
  settleMs: [0, 600_000],
  reserveMb: [0, 1_048_576],
  maxWaitMs: [0, 3_600_000],
};

/** The valid keys of a saved `launches`, and one line for each value left out. */
function savedLaunches(value: unknown): { launches: Launches; problems: string[] } {
  if (value === undefined || value === null) return { launches: {}, problems: [] };
  if (typeof value !== 'object' || Array.isArray(value)) return { launches: {}, problems: ['launches is not an object; the defaults apply'] };
  const launches: Launches = {};
  const problems: string[] = [];
  for (const [key, given] of Object.entries(value)) {
    const range = LAUNCH_RANGES[key as keyof Launches];
    if (!range) problems.push(`launches.${key} is not a known key; it is ignored`);
    else if (Number.isInteger(given) && given >= range[0] && given <= range[1]) launches[key as keyof Launches] = given;
    else problems.push(`launches.${key} must be a whole number from ${range[0]} to ${range[1]}; the default applies`);
  }
  return { launches, problems };
}

/** Hours an agent may stay finished before it sleeps (idle sleep), and the longest allowed. */
export const IDLE_SLEEP_HOURS = 4;
const MAX_IDLE_SLEEP_HOURS = 168;

/** The saved `idleSleepHours` when valid, else the default with one line saying so. */
function savedIdleSleep(value: unknown): { hours: number; problems: string[] } {
  if (value === undefined || value === null) return { hours: IDLE_SLEEP_HOURS, problems: [] };
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_IDLE_SLEEP_HOURS) return { hours: value, problems: [] };
  return { hours: IDLE_SLEEP_HOURS, problems: [`idleSleepHours must be a number of hours from 0 (off) to ${MAX_IDLE_SLEEP_HOURS}; the default (${IDLE_SLEEP_HOURS}) applies`] };
}

/** Idle sleep's default threshold in minutes (4 h), and the longest allowed (one week). */
export const IDLE_SLEEP_MINUTES = IDLE_SLEEP_HOURS * 60;
const MAX_IDLE_SLEEP_MINUTES = 10_080;

/** The saved `idleSleepMinutes` when it is a whole number of minutes in range; unset (absent or not valid) otherwise. */
function savedIdleSleepMinutes(value: unknown): { minutes?: number; problems: string[] } {
  if (value === undefined || value === null) return { problems: [] };
  if (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_IDLE_SLEEP_MINUTES) return { minutes: value as number, problems: [] };
  return { problems: [`idleSleepMinutes must be a whole number of minutes from 1 to ${MAX_IDLE_SLEEP_MINUTES}; idleSleepHours or the default (${IDLE_SLEEP_MINUTES}) applies`] };
}

/** The saved `idleSleep` switch: true unless it is false; a value that is not a boolean is reported. */
function savedIdleSleepSwitch(value: unknown): { on: boolean; problems: string[] } {
  if (value === undefined || value === null || typeof value === 'boolean') return { on: value !== false, problems: [] };
  return { on: true, problems: ['idleSleep must be true or false; the default (on) applies'] };
}

/**
 * How long an agent stays finished before it sleeps, in ms; 0 = off. Off when the switch (`idleSleep`) is
 * false; else `idleSleepMinutes` when set, else `idleSleepHours` (0 = off, as before), else 4 h.
 */
export function idleSleepMs(config: Pick<MiradorConfig, 'idleSleep' | 'idleSleepMinutes' | 'idleSleepHours'>): number {
  if (config.idleSleep === false) return 0;
  if (config.idleSleepMinutes !== undefined) return config.idleSleepMinutes * 60_000;
  return (config.idleSleepHours ?? IDLE_SLEEP_HOURS) * 3_600_000;
}

/** Days a local left-off record is kept (config `leftOffDays`), and the most allowed. */
export const LEFT_OFF_DAYS = 30;
const MAX_LEFT_OFF_DAYS = 3650;

/** The saved `leftOffDays` when it is a whole number of days in range, else the default with one line saying so. */
function savedLeftOffDays(value: unknown): { days: number; problems: string[] } {
  if (value === undefined || value === null) return { days: LEFT_OFF_DAYS, problems: [] };
  if (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_LEFT_OFF_DAYS) return { days: value as number, problems: [] };
  return { days: LEFT_OFF_DAYS, problems: [`leftOffDays must be a whole number of days from 1 to ${MAX_LEFT_OFF_DAYS}; the default (${LEFT_OFF_DAYS}) applies`] };
}

/** The saved `mode` when it is one of MODES, else auto with one line saying so. */
function savedMode(value: unknown): { mode: Mode; problems: string[] } {
  if (value === undefined) return { mode: 'auto', problems: [] };
  if (MODES.includes(value as Mode)) return { mode: value as Mode, problems: [] };
  return { mode: 'auto', problems: ['mode must be "auto", "gentle-deck" or "plain"; auto applies'] };
}

/** The saved `browser` when it is a non-empty string, else unset (the Chromium-family list) with one line saying so. */
function savedBrowser(value: unknown): { browser?: string; problems: string[] } {
  if (value === undefined || value === null) return { problems: [] };
  if (typeof value === 'string' && value.trim()) return { browser: value.trim(), problems: [] };
  return { problems: ['browser must be a command on PATH or a macOS app name; the Chromium-family list applies'] };
}

/** Who the prompts name when config `ownerName` is unset or not valid: nobody in particular. */
export const DEFAULT_OWNER_NAME = 'the user';
const MAX_OWNER_NAME = 60;

/** A valid `ownerName`, trimmed: 1-60 characters on one line, no control or format characters, no < or > (prompt tags); else null. */
function validOwnerName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || Array.from(name).length > MAX_OWNER_NAME || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]/u.test(name)) return null;
  return name;
}

/** The name the prompts use for config `ownerName`: the configured name when valid, else DEFAULT_OWNER_NAME. */
export function ownerNameFrom(value: unknown): string {
  return validOwnerName(value) ?? DEFAULT_OWNER_NAME;
}

/** `name` at the start of a sentence ("the user" → "The user"; a configured name stays as written). */
export function ownerAtStart(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** The saved `ownerName` when valid, else unset (the neutral default) with one line saying so. */
function savedOwnerName(value: unknown): { ownerName?: string; problems: string[] } {
  if (value === undefined || value === null) return { problems: [] };
  const name = validOwnerName(value);
  if (name) return { ownerName: name, problems: [] };
  return { problems: [`ownerName must be a name of 1 to ${MAX_OWNER_NAME} characters on one line, without < or >; "${DEFAULT_OWNER_NAME}" applies`] };
}

/**
 * Why a saved `shell` cannot start agent terminals. They run
 * `bash --rcfile <agent.bashrc> -i`, so a shell that is not bash breaks only the agent
 * terminal, while every other terminal kind (plain shells, the git window) still works.
 * The value is therefore kept and only reported, so a user who set `zsh` on purpose keeps
 * their plain terminals.
 */
function shellProblems(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string' && /(^|[/\\])bash(\.exe)?$/.test(value.trim())) return [];
  return ['shell is not bash, so agent terminals cannot start (they run `bash --rcfile`); other terminals are unaffected'];
}

/** The config as loaded, plus what Mirador could not read in its `workspaces`. */
export interface LoadedConfig extends MiradorConfig {
  /**
   * Why workspace changes must not be saved: entries Mirador cannot read or duplicate
   * ids. Saving would drop or overwrite them, so the store refuses changes while any is
   * listed (see WorkspaceStore). Empty when the file is fine.
   */
  workspaceProblems: string[];
  /** Values of `launches`, `idleSleepHours`, `idleSleep`, `idleSleepMinutes`, `mode`, `browser`, `ownerName` and `leftOffDays` left out because they are not valid; logged at startup. */
  launchProblems: string[];
}

/** What the config file may hold: every key optional, plus the pre-workspaces `root`. */
type SavedConfig = Partial<MiradorConfig> & { root?: string };

const DEFAULT_IGNORE = ['node_modules', 'bin', 'obj', 'dist', 'build', 'target', 'coverage', '__pycache__'];

export function configPath(env = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'mirador', 'config.json');
}

export function runtimeDir(env = process.env): string {
  return join(env.XDG_RUNTIME_DIR || join(homedir(), '.cache'), 'mirador');
}

/** Data that outlives a restart (logs, the call budget): $XDG_STATE_HOME/mirador, as bin/mirador uses. */
export function stateDir(env = process.env): string {
  return join(env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state'), 'mirador');
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function devWorkspace(root: string): Workspace {
  return { id: 'dev', name: 'Dev', root, folders: [], expanded: [] };
}

async function defaults(env: NodeJS.ProcessEnv): Promise<MiradorConfig> {
  const home = env.HOME || homedir();
  const dev = join(home, 'Dev');
  return {
    workspaces: [devWorkspace((await isDirectory(dev)) ? dev : home)],
    port: 4545,
    engramUrl: `http://127.0.0.1:${env.ENGRAM_PORT || 7437}`,
    agentCommand: 'gentle-shell',
    shell: '/bin/bash',
    ignore: DEFAULT_IGNORE,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    attentionBridge: true,
    mode: 'auto',
  };
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/**
 * Saved workspaces with their lists filled in (null when the file has none), and what
 * could not be read: entries without an id, name or root, a value that is not a list,
 * duplicate ids (only the first shows). Those are shown nowhere and reported instead.
 */
function savedWorkspaces(value: unknown): { workspaces: Workspace[] | null; problems: string[] } {
  if (value === undefined || value === null) return { workspaces: null, problems: [] };
  if (!Array.isArray(value)) return { workspaces: null, problems: ['workspaces is not a list'] };
  const problems: string[] = [];
  const workspaces: Workspace[] = [];
  value.forEach((w, index) => {
    if (!w || typeof w.id !== 'string' || typeof w.name !== 'string' || typeof w.root !== 'string') {
      problems.push(`workspaces[${index}] has no id, name or root`);
    } else if (workspaces.some((other) => other.id === w.id)) {
      if (!problems.includes(`workspace id "${w.id}" appears more than once`)) problems.push(`workspace id "${w.id}" appears more than once`);
    } else {
      workspaces.push({
        id: w.id,
        name: w.name,
        root: w.root,
        folders: strings(w.folders),
        expanded: strings(w.expanded),
        ...(typeof w.mission === 'string' && w.mission ? { mission: w.mission } : {}),
        ...(strings(w.projects).length ? { projects: strings(w.projects) } : {}),
      });
    }
  });
  return { workspaces, problems };
}

export async function loadConfig(path = configPath(), env = process.env): Promise<LoadedConfig> {
  const base = await defaults(env);
  let saved: SavedConfig;
  try {
    saved = JSON.parse(await readFile(path, 'utf8')) as SavedConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { ...base, launches: {}, idleSleepHours: IDLE_SLEEP_HOURS, idleSleep: true, leftOff: true, leftOffDays: LEFT_OFF_DAYS, workspaceProblems: [], launchProblems: [] };
  }
  // Before workspaces, the config held one `root`: it becomes the Dev workspace.
  const { root, workspaces, browser: browserValue, ownerName: ownerValue, idleSleep: switchValue, idleSleepMinutes: minutesValue, ...rest } = saved;
  const loaded = savedWorkspaces(workspaces);
  const migrated = loaded.workspaces ?? (typeof root === 'string' ? [devWorkspace(root)] : base.workspaces);
  const launches = savedLaunches(rest.launches);
  const idleSleep = savedIdleSleep(rest.idleSleepHours);
  const idleSwitch = savedIdleSleepSwitch(switchValue);
  const idleMinutes = savedIdleSleepMinutes(minutesValue);
  const mode = savedMode(rest.mode);
  const browser = savedBrowser(browserValue);
  const owner = savedOwnerName(ownerValue);
  const leftOffDays = savedLeftOffDays(rest.leftOffDays);
  const shellIssue = shellProblems(rest.shell);
  // Only an explicit false turns the attention bridge off.
  return {
    ...base,
    ...rest,
    workspaces: migrated,
    attentionBridge: rest.attentionBridge !== false,
    mode: mode.mode,
    launches: launches.launches,
    idleSleepHours: idleSleep.hours,
    idleSleep: idleSwitch.on,
    ...(idleMinutes.minutes !== undefined ? { idleSleepMinutes: idleMinutes.minutes } : {}),
    // Only an explicit false turns the left-off capture off.
    leftOff: rest.leftOff !== false,
    leftOffDays: leftOffDays.days,
    ...(browser.browser ? { browser: browser.browser } : {}),
    ...(owner.ownerName ? { ownerName: owner.ownerName } : {}),
    workspaceProblems: loaded.problems,
    launchProblems: [
      ...launches.problems,
      ...idleSleep.problems,
      ...idleSwitch.problems,
      ...idleMinutes.problems,
      ...mode.problems,
      ...browser.problems,
      ...owner.problems,
      ...leftOffDays.problems,
      ...shellIssue,
    ],
  };
}

/**
 * Merges `changes` into the saved file and deletes the `remove` keys, leaving
 * every other key as the user wrote it, so defaults (port, Engram URL, time zone)
 * keep following the code. Writes a temp file and renames it, so a crash never
 * leaves half a config. A symlinked config stays a symlink (its target is
 * replaced) and the file keeps its mode.
 */
export async function saveSettings(changes: Partial<MiradorConfig>, path = configPath(), remove: string[] = []): Promise<void> {
  let saved: Record<string, unknown> = {};
  let target = path;
  let mode: number | undefined;
  try {
    target = await realpath(path);
    mode = (await stat(target)).mode & 0o7777;
    saved = JSON.parse(await readFile(target, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const key of remove) delete saved[key];
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ ...saved, ...changes }, null, 2) + '\n', mode === undefined ? {} : { mode });
    // writeFile applies the umask; the saved file keeps exactly the mode it had.
    if (mode !== undefined) await chmod(temp, mode);
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

export { isDirectory };
