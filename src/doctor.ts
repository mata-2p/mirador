import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, release, type as osType } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, onPath } from './agents/catalog.ts';
import { gentleAiStatePath, readInstalledAgents } from './agents/gentle-ai-state.ts';
import { opencodeDoctorNote, readOpencodeVersion } from './agents/opencode-version.ts';
import { configPath, loadConfig, type Mode } from './config.ts';
import { resolveMode } from './mode.ts';

/**
 * `node src/doctor.ts` (`pnpm run doctor`; `pnpm doctor` is pnpm's own command): what Mirador needs on this machine, present or missing.
 * Node 24+, node-pty and a browser opener
 * are required and decide the exit code; systemd, gentle-ai, the catalog agents and Engram only inform,
 * and so does the browser on Linux without a display ({@link noDisplay}). The opencode line names the opencode
 * agent terminals run and its version (src/agents/opencode-version.ts); one older than Mirador's bridge needs
 * gets a `warn` line instead of `ok`.
 * A missing gentle-shell, pi or Engram also gets a line under {@link NOT_FOUND} saying what Mirador does
 * without it and how to get it; it never changes the exit code.
 * `--report` adds a fenced block for bug reports: no home path, user
 * or host name, and nothing from the config but the mode. `--engram` runs only {@link checkEngram},
 * the Engram check install.sh shares with doctor: it prints the
 * URL and exits 0 when Engram answers there, 1 when it does not. `--browser` runs only
 * {@link checkBrowser}, which install.sh runs before installing: it prints the browser line's detail
 * and exits 0 when a browser opener is found, 1 when none is, with or without a display (install.sh
 * itself makes a missing one a warning without a display).
 */

/**
 * The Chromium-family browsers bin/mirador opens an app window in (`--app=URL`, a window without
 * browser UI), in its order; keep them in step with `open_window` there. Only this family has
 * `--app`: Firefox dropped its site-specific-browser mode in 2021 and Safari has no CLI equivalent.
 */
export const BROWSERS = ['chromium', 'chromium-browser', 'brave', 'brave-browser', 'google-chrome-stable', 'google-chrome', 'microsoft-edge-stable', 'microsoft-edge', 'vivaldi-stable', 'vivaldi'] as const;

/** The same family as macOS apps, which bin/mirador's `open_mac_window` tries in this order with `open -na`. */
export const MAC_APPS = ['Google Chrome', 'Brave Browser', 'Microsoft Edge', 'Vivaldi', 'Chromium'] as const;

/** The heading of the notices for a missing gentle-shell, pi or Engram. */
export const NOT_FOUND = 'Not found (optional; Mirador runs without them)';
/** Where gentle-shell, and pi with it, comes from (README.md). */
const GENTLE_SHELL_LINK = 'https://github.com/Gentleman-Programming/gentle-shell';

const MIN_NODE = 24;
const ENGRAM_TIMEOUT_MS = 1000;
const PNPM_TIMEOUT_MS = 5000;

/** What `--report` says about the machine. */
export interface SystemInfo {
  /** OS name and version, e.g. `CachyOS` or `macOS 15.1`. */
  os: string;
  kernel: string;
  arch: string;
}

export interface DoctorOptions {
  /** PATH, HOME, XDG_* and GENTLE_AI_HOME, and ENGRAM_PORT for the default Engram URL. */
  env?: NodeJS.ProcessEnv;
  /** `process.versions.node` unless given. */
  nodeVersion?: string;
  /** Loads node-pty; rejects when it cannot. */
  loadPty?: () => Promise<unknown>;
  /** Whether Engram answers at `url`. */
  probeEngram?: (url: string) => Promise<boolean>;
  /** Add the bug report block (`--report`). */
  report?: boolean;
  /** OS, kernel and architecture for the report; this machine's unless given. */
  system?: () => Promise<SystemInfo>;
  /** pnpm's version for the report, or null when pnpm is not on PATH. */
  pnpmVersion?: (env: NodeJS.ProcessEnv) => Promise<string | null>;
  /** `process.platform` unless given: darwin probes macOS apps, linux PATH binaries. */
  platform?: NodeJS.Platform;
  /** `os.release()` unless given; a Microsoft kernel on linux is WSL2. */
  kernelRelease?: string;
  /** Whether the macOS app `name` is installed; looks in /Applications and ~/Applications unless given. */
  macAppInstalled?: (name: string, env: NodeJS.ProcessEnv) => Promise<boolean>;
}

export interface DoctorReport {
  lines: string[];
  /** Every required item is present. */
  ok: boolean;
}

const require = createRequire(import.meta.url);

/** Any HTTP answer counts: a slow or absent Engram gives up after a second. */
async function engramAnswers(url: string): Promise<boolean> {
  try {
    await fetch(`${url}/health`, { signal: AbortSignal.timeout(ENGRAM_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

/**
 * The one Engram check, shared by doctor's Engram line and install.sh (`node src/doctor.ts --engram`):
 * whether Engram answers at the config's `engramUrl` (`127.0.0.1`, `ENGRAM_PORT` or 7437, by default;
 * the same default when the config cannot be read). It asks nothing but that URL.
 */
export async function checkEngram(options: Pick<DoctorOptions, 'env' | 'probeEngram'> = {}): Promise<{ url: string; answers: boolean }> {
  const env = options.env ?? process.env;
  const url = await loadConfig(configPath(env), env).then(
    (config) => config.engramUrl,
    () => `http://127.0.0.1:${env.ENGRAM_PORT || 7437}`,
  );
  return { url, answers: await (options.probeEngram ?? engramAnswers)(url) };
}

const run = (file: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env, timeout: PNPM_TIMEOUT_MS }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });

/** The distribution's pretty name on Linux, the product version on macOS. */
async function thisSystem(): Promise<SystemInfo> {
  let os = `${osType()} ${release()}`;
  if (process.platform === 'linux') {
    const osRelease = await readFile('/etc/os-release', 'utf8').catch(() => '');
    const field = (name: string): string | undefined => osRelease.match(new RegExp(`^${name}="?([^"\\n]*)"?$`, 'm'))?.[1];
    os = field('PRETTY_NAME') || [field('NAME') ?? 'Linux', field('VERSION_ID')].filter(Boolean).join(' ');
  } else if (process.platform === 'darwin') {
    os = `macOS ${(await run('sw_vers', ['-productVersion'], process.env).catch(() => 'unknown')).trim()}`;
  }
  return { os, kernel: release(), arch: process.arch };
}

/** Only a version number counts, so a wrapper that prints more cannot leak it into the report. */
async function pnpmOnPath(env: NodeJS.ProcessEnv): Promise<string | null> {
  if (!(await onPath('pnpm', env.PATH))) return null;
  const version = (await run('pnpm', ['--version'], env).catch(() => '')).trim();
  return /^\d+\.\d+\.\d+[\w.+-]*$/.test(version) ? version : 'unknown';
}

/** Error messages name files under the home folder: the report keeps the words, not the paths. */
const withoutPaths = (text: string): string => text.replace(/(?<![\w.-])(['"]?)(?:~|\/)[^\s'"]*\1/g, '<path>');

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

async function macAppInApplications(name: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  for (const dir of ['/Applications', join(env.HOME || homedir(), 'Applications')]) {
    if (await exists(join(dir, `${name}.app`))) return true;
  }
  return false;
}

interface Opener {
  /** What the report names: the browser, app or opener command. */
  name: string;
  detail: string;
}

/** A Microsoft kernel on linux is WSL2. */
const isWsl = (options: Pick<DoctorOptions, 'platform' | 'kernelRelease'>): boolean =>
  (options.platform ?? process.platform) === 'linux' && /microsoft/i.test(options.kernelRelease ?? release());

/**
 * Linux without a display: not WSL2, and DISPLAY and WAYLAND_DISPLAY unset or empty. bin/mirador then prints
 * a one-time link instead of opening a window (`open_window`), so the browser is not required, and
 * install.sh (`no_display`) makes a missing one a warning; keep the three tests in step.
 */
const noDisplay = (options: Pick<DoctorOptions, 'platform' | 'kernelRelease'>, env: NodeJS.ProcessEnv): boolean =>
  (options.platform ?? process.platform) === 'linux' && !isWsl(options) && !env.DISPLAY && !env.WAYLAND_DISPLAY;

/** What the browser line adds when {@link noDisplay}. */
const NOT_REQUIRED = 'not required without a display (DISPLAY and WAYLAND_DISPLAY are unset): mirador prints a one-time link to open in a browser instead';

const appWindow = (name: string): Opener => ({ name, detail: `app window (${name})` });
const defaultTab = (name: string): Opener => ({ name, detail: `tab in the default browser (${name})` });

/**
 * What bin/mirador opens Mirador with, in its order: the config's browser, the Chromium-family list
 * (macOS apps on darwin), on WSL2 wslview then Edge through powershell.exe, then a tab in the
 * default browser (xdg-open, or open on macOS). The detail names what was not found.
 */
async function browserOpener(configured: string | undefined, options: DoctorOptions, env: NodeJS.ProcessEnv): Promise<{ opener: Opener | null; detail: string }> {
  const platform = options.platform ?? process.platform;
  const mac = platform === 'darwin';
  const wsl = isWsl(options);
  const macApp = options.macAppInstalled ?? macAppInApplications;
  const has = (name: string) => onPath(name, env.PATH);
  if (configured && ((await has(configured)) || (mac && (await macApp(configured, env))))) return { opener: appWindow(configured), detail: appWindow(configured).detail };
  const note = configured ? `; the config's browser "${configured}" was not found` : '';
  const found = async (): Promise<Opener | null> => {
    for (const name of mac ? MAC_APPS : BROWSERS) if (mac ? await macApp(name, env) : await has(name)) return appWindow(name);
    if (wsl && (await has('wslview'))) return defaultTab('wslview');
    if (wsl && (await has('powershell.exe'))) return { name: 'powershell.exe', detail: 'app window (Microsoft Edge via powershell.exe)' };
    const tab = mac ? 'open' : 'xdg-open';
    return (await has(tab)) ? defaultTab(tab) : null;
  };
  const opener = await found();
  if (opener) return { opener, detail: opener.detail + note };
  if (mac) return { opener, detail: `no Chromium-family app (${MAC_APPS.join(', ')}) and no open on PATH${note}` };
  if (wsl) return { opener, detail: `no Chromium-family browser (${BROWSERS.join(', ')}), wslview, powershell.exe or xdg-open on PATH${note}` };
  return { opener, detail: `no Chromium-family browser (${BROWSERS.join(', ')}) and no xdg-open on PATH${note}` };
}

/**
 * The browser check alone, as on doctor's browser line: the config's `browser` first (an unreadable
 * config counts as none), then {@link browserOpener}'s order.
 */
export async function checkBrowser(options: Pick<DoctorOptions, 'env' | 'platform' | 'kernelRelease' | 'macAppInstalled'> = {}): Promise<{ found: boolean; detail: string }> {
  const env = options.env ?? process.env;
  const configured = await loadConfig(configPath(env), env).then(
    (config) => config.browser,
    () => undefined,
  );
  const browser = await browserOpener(configured, options, env);
  return { found: browser.opener !== null, detail: browser.detail };
}

/** A line's status: `ok`, `missing`, or `warn` (present but not as Mirador needs it, an opencode older than 2.0.0). */
type Status = 'ok' | 'missing' | 'warn';
/** `found` as a status: ok when found, else missing. */
const status = (found: boolean): Status => (found ? 'ok' : 'missing');
const item = (level: Status, label: string, detail: string): string => `  ${level.padEnd(8)} ${label}: ${detail}`;

export async function doctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const loadPty = options.loadPty ?? (async () => require('node-pty'));
  const missing: string[] = [];
  const required = (found: boolean, label: string, detail: string): string => {
    if (!found) missing.push(label);
    return item(status(found), label, detail);
  };

  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeOk = Number(nodeVersion.split('.')[0]) >= MIN_NODE;
  let ptyProblem: string | null = null;
  await loadPty().catch((error: unknown) => {
    ptyProblem = error instanceof Error ? error.message.split('\n')[0] : String(error);
  });
  // The config comes first: its `browser` wins over the list.
  const file = configPath(env);
  let mode: Mode = 'auto';
  let configuredBrowser: string | undefined;
  // The configured agentCommand: when it names opencode by path, that is the opencode agent terminals run.
  let agentCommand: string | undefined;
  const configLines: string[] = [];
  try {
    const config = await loadConfig(file, env);
    mode = config.mode;
    configuredBrowser = config.browser;
    agentCommand = config.agentCommand;
    configLines.push(`Config: ${file}${(await exists(file)) ? '' : ' (not found; defaults apply)'}`);
    for (const problem of [...config.workspaceProblems, ...config.launchProblems]) configLines.push(`  problem: ${problem}`);
  } catch (error) {
    configLines.push(`Config: ${file} (unreadable: ${error instanceof Error ? error.message : String(error)}; Mirador will not start)`);
  }
  const browser = await browserOpener(configuredBrowser, options, env);
  // Without a display the browser line is the first optional item and says why.
  const headless = noDisplay(options, env);
  const lines = [
    'Mirador doctor',
    '',
    'Required',
    required(nodeOk, 'Node', `v${nodeVersion} (${MIN_NODE} or newer${nodeOk ? '' : ' needed'})`),
    required(ptyProblem === null, 'node-pty', ptyProblem === null ? 'loads' : `does not load (${ptyProblem}); run pnpm install, or pnpm rebuild node-pty after a Node upgrade`),
    ...(headless ? [] : [required(browser.opener !== null, 'browser', browser.detail)]),
    '',
    'Optional',
    ...(headless ? [item(status(browser.opener !== null), 'browser', `${browser.detail}; ${NOT_REQUIRED}`)] : []),
  ];

  const systemdRun = await onPath('systemd-run', env.PATH);
  const bus = Boolean(env.DBUS_SESSION_BUS_ADDRESS) || (env.XDG_RUNTIME_DIR ? await exists(join(env.XDG_RUNTIME_DIR, 'bus')) : false);
  const scopes = systemdRun && bus;
  const systemdParts = [systemdRun ? 'systemd-run on PATH' : 'no systemd-run on PATH', bus ? 'user bus' : 'no user bus'];
  if ((options.platform ?? process.platform) === 'darwin') {
    // macOS has no systemd or cgroups: the server turns scopes off without probing (src/terminals/scopes.ts).
    lines.push(item('missing', 'systemd', 'not on macOS; terminals run without memory limits (limits not available on macOS)'));
  } else {
    lines.push(item(status(systemdRun || bus), 'systemd', `${systemdParts.join(', ')}${scopes ? '' : '; terminals run without scopes'}`));
  }

  const statePath = gentleAiStatePath(env);
  const state = await exists(statePath);
  const installed = await readInstalledAgents(env);
  lines.push(item(status(state), 'gentle-ai', state ? `${statePath} (installed agents: ${installed.join(', ') || 'none'})` : `no ${statePath}`));

  const agentsFound: string[] = [];
  let piFound = false;
  for (const agent of AGENTS) {
    let found: string | null = null;
    for (const name of [agent.binary, ...agent.aliases]) {
      if (await onPath(name, env.PATH)) {
        found = name;
        break;
      }
    }
    if (found) agentsFound.push(`${agent.id} (${found})`);
    if (found && agent.id === 'pi') piFound = true;
    const note = found && state && !installed.includes(agent.id) ? " (not in gentle-ai's installed agents)" : '';
    // opencode's line adds the opencode agent terminals run and its `--version`: one older than the bridge needs
    // starts without it and is a `warn`; one it cannot read keeps the bridge and the `ok`.
    const extra = found && agent.id === 'opencode' ? opencodeDoctorNote(await readOpencodeVersion(env, { agentCommand })) : null;
    const detail = found ? `${found} on PATH${note}${extra ? `; ${extra.text}` : ''}` : `${agent.binary} not on PATH`;
    lines.push(item(extra?.status ?? status(found !== null), `agent ${agent.id}`, detail));
  }

  const { url: engramUrl, answers: engram } = await checkEngram({ env, probeEngram: options.probeEngram });
  lines.push(item(status(engram), 'Engram', engram ? `${engramUrl} answers` : `no answer at ${engramUrl}; memory views stay empty`));

  const resolved = await resolveMode(mode, env);
  const notices: string[] = [];
  if (!(await onPath('gentle-shell', env.PATH))) {
    const lost = resolved === 'plain'
      ? 'Mirador runs in plain mode: one bash per folder, no memory views, night shift or MCP servers per project'
      : 'Mirador runs in full mode, but a gentle-shell agent cannot start';
    notices.push(`  gentle-shell: ${lost}; install it from ${GENTLE_SHELL_LINK}`);
  }
  // The catalog's pi entry: gentle-shell or pi on PATH.
  if (!piFound) notices.push(`  pi: no pi agent and no session restore for it; gentle-shell starts pi, install it from ${GENTLE_SHELL_LINK}`);
  if (!engram) notices.push('  Engram: memory views such as "where it left off" stay empty; start it with: engram serve (see docs/configuration.md#use)');
  if (notices.length) lines.push('', NOT_FOUND, ...notices);

  // The resolved mode by its visible name, full or plain; the
  // config value stays as written, since that is what the user sets.
  const modeLine = `${resolved === 'plain' ? 'plain' : 'full'} (config: ${mode})`;
  lines.push('', ...configLines, `Mode: ${modeLine}`, '');
  lines.push(missing.length ? `Missing required: ${missing.join(', ')}.` : 'All required items are present.');

  if (options.report) {
    const system = await (options.system ?? thisSystem)();
    const pnpm = await (options.pnpmVersion ?? pnpmOnPath)(env);
    lines.push(
      '',
      '```text',
      'Mirador doctor report',
      `OS: ${system.os}`,
      `kernel: ${system.kernel}`,
      `arch: ${system.arch}`,
      `Node: v${nodeVersion}`,
      `pnpm: ${pnpm ?? 'not found'}`,
      `node-pty: ${ptyProblem === null ? 'loads' : `does not load (${withoutPaths(ptyProblem)})`}`,
      `browser: ${browser.opener?.name ?? 'none'}`,
      `systemd scopes: ${scopes ? 'yes' : 'no'}`,
      `mode: ${modeLine}`,
      `agents on PATH: ${agentsFound.join(', ') || 'none'}`,
      '```',
    );
  }
  return { lines, ok: missing.length === 0 };
}

// Run directly (argv[1] may name the file through a symlink), not when a test imports it.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--engram')) {
    const engram = await checkEngram();
    process.stdout.write(`${engram.url}\n`);
    process.exitCode = engram.answers ? 0 : 1;
  } else if (args.includes('--browser')) {
    const browser = await checkBrowser();
    process.stdout.write(`${browser.detail}\n`);
    process.exitCode = browser.found ? 0 : 1;
  } else {
    const report = await doctor({ report: args.includes('--report') });
    process.stdout.write(`${report.lines.join('\n')}\n`);
    process.exitCode = report.ok ? 0 : 1;
  }
}
