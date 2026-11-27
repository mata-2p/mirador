import { appendFile, chmod, lstat, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runGit } from '../folders/git-status.ts';

/**
 * Per-project MCP servers. pi starts every enabled server
 * of gentle-shell's `<agentDir>/mcp.json` plus the servers of a trusted project's `.pi/mcp.json`,
 * where an entry without `command`, `url` or `type` only overrides `enabled`, `exposure` and
 * `toolExposure` of the user server with that name (pi docs/mcp.md). Mirador reads both files and,
 * when the user turns servers off for a folder, writes only `"enabled": false` into that folder's
 * `.pi/mcp.json`. It never writes under the agent dir and never changes how agents start.
 *
 * Files a save can write, and the guard of each:
 * - `<folder>/.pi/mcp.json`: the folder comes from ctx.resolveFolder (inside the workspace root);
 *   `.pi` and the file must not be symlinks; an existing file that is not a JSON object of servers
 *   is refused and left as it was; the rest of its content is kept; temp file + rename.
 * - `<folder>/.pi/`: created only when a save has something to write.
 * - the repo's `info/exclude` (`git rev-parse --git-path info/exclude`): one line appended, only when
 *   the file is untracked and not ignored, never twice; existing lines are kept.
 */

/** Idle memory of each server in one agent, measured once on 2026-10-29 (MB); others are unknown. */
export const MCP_MEMORY_MB: Readonly<Record<string, number>> = Object.freeze({
  markitdown: 180,
  azure: 230,
  codegraph: 180,
  context7: 110,
  bicep: 85,
});

export const PROJECT_MCP_FILE = '.pi/mcp.json';

export type McpGitState = 'tracked' | 'ignored' | 'untracked' | 'none' | 'unknown';
export type McpTrust = 'trusted' | 'untrusted' | 'unknown';

export interface McpServerView {
  name: string;
  /** `project` when the project file declares the server (it then replaces a user entry of that name). */
  source: 'user' | 'project';
  /** Whether agents in this folder start it. */
  enabled: boolean;
  /** Off for every project in the user file: an `enabled: false` override cannot turn it on, so saving leaves it alone. */
  locked: boolean;
  description: string | null;
  estimatedMb: number | null;
}

export interface ProjectMcpView {
  file: typeof PROJECT_MCP_FILE;
  exists: boolean;
  /** The project file in git: tracked, ignored, untracked and not ignored, no repo, or git failed. */
  git: McpGitState;
  /** Whether pi reads the project file here (pi docs/security.md): its saved decision, else `defaultProjectTrust`. */
  trust: McpTrust;
  userConfig: 'ok' | 'missing' | 'invalid';
  servers: McpServerView[];
}

export interface SavedProjectMcp extends ProjectMcpView {
  saved: { written: boolean; excluded: boolean };
}

/** `code`: `mcp_invalid` (unknown server names), `mcp_unreadable` (not a JSON object of servers), `mcp_not_regular` (symlink or not a file). */
export class McpFileError extends Error {
  code: 'mcp_invalid' | 'mcp_unreadable' | 'mcp_not_regular';
  constructor(code: McpFileError['code'], message: string) {
    super(message);
    this.name = 'McpFileError';
    this.code = code;
  }
}

/**
 * gentle-shell's agent dir: a configured path, else the rule its launcher follows (as
 * gentleShellRuntime in src/memory/translate.ts): GENTLE_SHELL_HOME or ~/.gentle-shell/agent.
 */
export function gentleShellAgentDir(configured: unknown, env = process.env): string {
  if (typeof configured === 'string' && configured.trim()) return resolve(configured.trim());
  return env.GENTLE_SHELL_HOME || join(env.HOME || homedir(), '.gentle-shell', 'agent');
}

// pi accepts only these characters in server names.
const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_DESCRIPTION = 200;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const declares = (entry: Json) => 'command' in entry || 'url' in entry || 'type' in entry;
const description = (entry: Json | undefined) =>
  typeof entry?.description === 'string' && entry.description.trim() ? entry.description.trim().slice(0, MAX_DESCRIPTION) : null;

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

const parse = (raw: string): unknown => JSON.parse(raw.replace(/^\uFEFF/, ''));

/** The user servers of `<agentDir>/mcp.json`, read only. */
async function userServers(agentDir: string): Promise<{ state: ProjectMcpView['userConfig']; servers: Json }> {
  let raw: string | null;
  try {
    raw = await readText(join(agentDir, 'mcp.json'));
  } catch {
    return { state: 'invalid', servers: {} };
  }
  if (raw === null) return { state: 'missing', servers: {} };
  try {
    const doc = parse(raw);
    if (!isObject(doc) || (doc.mcpServers !== undefined && !isObject(doc.mcpServers))) return { state: 'invalid', servers: {} };
    return { state: 'ok', servers: (doc.mcpServers as Json | undefined) ?? {} };
  } catch {
    return { state: 'invalid', servers: {} };
  }
}

interface ProjectFile {
  path: string;
  /** null when there is no file. */
  raw: string | null;
  doc: Json;
}

/** The project file, refused (never repaired) when it is a symlink, not a file, or not a JSON object of servers. */
async function readProjectFile(folder: string): Promise<ProjectFile> {
  const dir = join(folder, '.pi');
  const path = join(dir, 'mcp.json');
  for (const [target, kind] of [[dir, 'directory'], [path, 'file']] as const) {
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, raw: null, doc: {} };
      throw error;
    }
    if (info.isSymbolicLink() || (kind === 'directory' ? !info.isDirectory() : !info.isFile())) {
      throw new McpFileError('mcp_not_regular', `${PROJECT_MCP_FILE} is a symlink or not a regular ${kind}`);
    }
  }
  const raw = await readFile(path, 'utf8');
  let doc: unknown;
  try {
    doc = parse(raw);
  } catch {
    throw new McpFileError('mcp_unreadable', `${PROJECT_MCP_FILE} is not valid JSON`);
  }
  if (!isObject(doc) || (doc.mcpServers !== undefined && !isObject(doc.mcpServers))) {
    throw new McpFileError('mcp_unreadable', `${PROJECT_MCP_FILE} is not a JSON object with an mcpServers object`);
  }
  return { path, raw, doc };
}

/** The servers agents in the folder would see: the user ones in file order, then those only the project declares. */
function listServers(user: Json, project: Json): McpServerView[] {
  const servers: McpServerView[] = [];
  const entry = (from: Json, name: string) => (Object.hasOwn(from, name) && isObject(from[name]) ? (from[name] as Json) : undefined);
  for (const name of Object.keys(user)) {
    const own = entry(user, name);
    if (!SERVER_NAME.test(name) || !own) continue;
    const override = entry(project, name);
    if (override && declares(override)) continue; // Listed below as the project's.
    const userOff = own.enabled === false;
    const enabled = typeof override?.enabled === 'boolean' ? override.enabled : !userOff;
    servers.push({ name, source: 'user', enabled, locked: userOff && override?.enabled !== true, description: description(own), estimatedMb: MCP_MEMORY_MB[name] ?? null });
  }
  for (const name of Object.keys(project)) {
    const own = entry(project, name);
    if (!SERVER_NAME.test(name) || !own || !declares(own)) continue;
    servers.push({ name, source: 'project', enabled: own.enabled !== false, locked: false, description: description(own), estimatedMb: MCP_MEMORY_MB[name] ?? null });
  }
  return servers;
}

/* ---------- git ---------- */

// GIT_DIR and friends from Mirador's own environment must not point git at another repo; English
// messages, since "not a git repository" is matched below.
const gitEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), LC_ALL: 'C' });

/**
 * Through the shared hardened runner (src/folders/git-status.ts): no optional locks
 * (GIT_OPTIONAL_LOCKS=0), fsmonitor off, no shell, cut after 5 s or 64 KiB of output.
 */
const git = (folder: string, args: string[]) => runGit(folder, gitEnv(), args, 64 * 1024);

interface GitInfo {
  state: McpGitState;
  /** Path of the folder inside the repo, with a trailing slash ('' at the root). */
  prefix: string;
}

/** Read-only: rev-parse, ls-files and check-ignore; `.git/index` is never rewritten. */
async function gitInfo(folder: string): Promise<GitInfo> {
  const top = await git(folder, ['rev-parse', '--show-prefix']);
  if (top.code !== 0) return { state: top.code === 128 && /not a git repository/i.test(top.stderr) ? 'none' : 'unknown', prefix: '' };
  const prefix = top.stdout.replace(/\n$/, '');
  if ((await git(folder, ['ls-files', '--error-unmatch', '--', PROJECT_MCP_FILE])).code === 0) return { state: 'tracked', prefix };
  const ignored = await git(folder, ['check-ignore', '-q', '--', PROJECT_MCP_FILE]);
  return { state: ignored.code === 0 ? 'ignored' : ignored.code === 1 ? 'untracked' : 'unknown', prefix };
}

/** A gitignore pattern for exactly this path from the repo root: wildcards, backslashes and trailing spaces escaped. */
function excludePattern(prefix: string): string {
  return `/${prefix}${PROJECT_MCP_FILE}`.replace(/[\\*?[\]]/g, '\\$&').replace(/ +$/, (spaces) => spaces.replace(/ /g, '\\ '));
}

/** Appends the project file to the repo's info/exclude unless that line is there; true when it appended. */
async function excludeLocally(folder: string, prefix: string): Promise<boolean> {
  const where = await git(folder, ['rev-parse', '--git-path', 'info/exclude']);
  if (where.code !== 0) return false;
  const exclude = resolve(folder, where.stdout.replace(/\n$/, ''));
  const pattern = excludePattern(prefix);
  let current = '';
  try {
    const info = await lstat(exclude);
    if (!info.isFile()) return false;
    current = await readFile(exclude, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(dirname(exclude), { recursive: true });
  }
  if (current.split(/\r?\n/).some((line) => line.trim() === pattern)) return false;
  await appendFile(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}${pattern}\n`);
  return true;
}

/* ---------- trust ---------- */

/**
 * pi's trust for the folder, read only: the nearest true/false in `<agentDir>/trust.json` for the
 * folder or a parent (canonical paths, null meaning no decision), else `defaultProjectTrust` in
 * `<agentDir>/settings.json` ("always" or "never"). Anything else, or a file Mirador cannot read,
 * is unknown: pi would ask, or an extension may decide.
 */
async function projectTrust(agentDir: string, folder: string): Promise<McpTrust> {
  try {
    const raw = await readText(join(agentDir, 'trust.json'));
    const saved = raw === null ? {} : parse(raw);
    if (!isObject(saved)) return 'unknown';
    for (let dir = folder; ; dir = dirname(dir)) {
      const decision = Object.hasOwn(saved, dir) ? saved[dir] : undefined;
      if (decision === true) return 'trusted';
      if (decision === false) return 'untrusted';
      if (dirname(dir) === dir) break;
    }
    const settingsRaw = await readText(join(agentDir, 'settings.json'));
    const settings = settingsRaw === null ? {} : parse(settingsRaw);
    const fallback = isObject(settings) ? settings.defaultProjectTrust : undefined;
    return fallback === 'always' ? 'trusted' : fallback === 'never' ? 'untrusted' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/* ---------- read and save ---------- */

export interface ProjectMcpOptions {
  /** Real path of the project folder, from ctx.resolveFolder. */
  folder: string;
  agentDir: string;
}

async function view(options: ProjectMcpOptions, file: ProjectFile): Promise<ProjectMcpView> {
  const user = await userServers(options.agentDir);
  return {
    file: PROJECT_MCP_FILE,
    exists: file.raw !== null,
    git: (await gitInfo(options.folder)).state,
    trust: await projectTrust(options.agentDir, options.folder),
    userConfig: user.state,
    servers: listServers(user.servers, (file.doc.mcpServers as Json | undefined) ?? {}),
  };
}

export async function readProjectMcp(options: ProjectMcpOptions): Promise<ProjectMcpView> {
  return view(options, await readProjectFile(options.folder));
}

/**
 * The command line (`command`, then its `args`) of every stdio server an agent in the folder may start:
 * those of the user file and those the project file declares, on or off, the same two files
 * readProjectMcp reads. Idle sleep tells an agent's own MCP servers apart by them
 * (src/terminals/background-work.ts). Only read; a file that cannot be read gives none, and it never throws.
 */
export async function mcpServerCommands(options: ProjectMcpOptions): Promise<string[][]> {
  const user = (await userServers(options.agentDir)).servers;
  const project = await readProjectFile(options.folder).then((file) => (file.doc.mcpServers as Json | undefined) ?? {}, () => ({}) as Json);
  const commands: string[][] = [];
  for (const servers of [user, project]) {
    for (const entry of Object.values(servers)) {
      if (!isObject(entry) || typeof entry.command !== 'string' || !entry.command.trim()) continue;
      const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : [];
      commands.push([entry.command.trim(), ...args]);
    }
  }
  return commands;
}

/**
 * Applies `disabled` (every listed server not in it is wanted on) to the project file. Turning a
 * server off sets `enabled: false` on its entry, or adds a bare `{ "enabled": false }` override;
 * turning it on removes that `enabled` again (and a bare override as a whole). Returns whether
 * anything changed. Locked servers are never touched.
 */
function applySelection(doc: Json, servers: McpServerView[], disabled: Set<string>): boolean {
  const entries = (isObject(doc.mcpServers) ? doc.mcpServers : {}) as Json;
  let changed = false;
  for (const server of servers) {
    if (server.locked) continue;
    const off = disabled.has(server.name);
    const entry = Object.hasOwn(entries, server.name) && isObject(entries[server.name]) ? (entries[server.name] as Json) : null;
    if (off && server.enabled) {
      if (entry) entry.enabled = false;
      else entries[server.name] = { enabled: false };
      changed = true;
    } else if (!off && !server.enabled && entry?.enabled === false) {
      if (server.source === 'user' && Object.keys(entry).length === 1) delete entries[server.name];
      else delete entry.enabled;
      changed = true;
    }
  }
  if (changed) doc.mcpServers = entries;
  return changed;
}

/** The indent the file already uses (a tab or N spaces), 2 spaces for a new one. */
function indentOf(raw: string | null): string | number {
  const first = raw?.match(/\n([ \t]+)\S/)?.[1];
  if (!first) return 2;
  return first.startsWith('\t') ? '\t' : first.length;
}

/** Temp file in the same folder, the old mode kept, renamed over the file. */
async function writeAtomic(path: string, content: string, folder: string): Promise<void> {
  const dir = dirname(path);
  let mode: number | undefined;
  try {
    mode = (await stat(path)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await mkdir(dir, { mode: (await stat(folder)).mode & 0o777 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const temp = join(dir, `.mcp.json.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temp, content, { flag: 'wx', ...(mode === undefined ? {} : { mode }) });
    if (mode !== undefined) await chmod(temp, mode);
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

// Saves of one project file run one at a time, so two windows cannot interleave read and write.
const queues = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  queues.set(key, next);
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => undefined);
  return next;
}

/** Saves which listed servers are off in the folder; `disabled` must name listed servers only. */
export function saveProjectMcp(options: ProjectMcpOptions & { disabled: string[] }): Promise<SavedProjectMcp> {
  return serialized(options.folder, async () => {
    const file = await readProjectFile(options.folder);
    const before = await view(options, file);
    const known = new Set(before.servers.map((server) => server.name));
    const unknown = options.disabled.filter((name) => !known.has(name));
    if (unknown.length) throw new McpFileError('mcp_invalid', `not a listed MCP server: ${unknown.join(', ')}`);
    if (!applySelection(file.doc, before.servers, new Set(options.disabled))) return { ...before, saved: { written: false, excluded: false } };

    const git = await gitInfo(options.folder);
    const bom = file.raw?.startsWith('\uFEFF') ? '\uFEFF' : '';
    const newline = file.raw === null || file.raw.endsWith('\n') ? '\n' : '';
    await writeAtomic(file.path, bom + JSON.stringify(file.doc, null, indentOf(file.raw)) + newline, options.folder);
    const excluded = git.state === 'untracked' ? await excludeLocally(options.folder, git.prefix) : false;
    return { ...(await view(options, await readProjectFile(options.folder))), saved: { written: true, excluded } };
  });
}
