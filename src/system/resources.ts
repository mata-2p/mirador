import { execFile } from 'node:child_process';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { basename, join } from 'node:path';

/**
 * RAM and CPU of what Mirador runs, read from /sys and /proc only.
 *
 * - A terminal in its systemd scope (src/terminals/scopes.ts) reports the scope's cgroup:
 *   memory.current, memory.swap.current, memory.peak and cpu.stat usage_usec.
 * - Without a scope, the sum of VmRSS and VmSwap over its process tree: the server's child
 *   whose environment holds HERDR_PANE_ID=<terminal id>, and everything below it. Shared
 *   pages count once per process, so a tree reads a little higher than its cgroup would.
 * - The machine (/proc/meminfo; on macOS `sysctl` and `vm_stat`) and the server's own RSS.
 * - "Outside Mirador": gentle-shell launchers of the same user that are neither in a Mirador
 *   scope nor below this server, each with its folder and its process tree. Only read:
 *   nothing here signals a process.
 *
 * Every figure is in bytes; anything unreadable is null, and sample() never throws.
 *
 * macOS has no /proc, no cgroups and no systemd: the machine's
 * memory comes from `sysctl -n hw.memsize vm.swapusage` and `vm_stat`, every per-process and
 * per-terminal figure is null (not available), and limitsFor() tells the window the limits are off.
 */

/** Where /sys and /proc live; tests pass fake trees. */
export interface ResourceRoots {
  sys: string;
  proc: string;
}

export const DEFAULT_ROOTS: ResourceRoots = { sys: '/sys', proc: '/proc' };

/** /proc/<pid>/stat counts CPU time in clock ticks: USER_HZ, 100 on Linux. */
const CLOCK_TICK_USEC = 10_000;
/** Processes read per sample, at most; a scan that hits it marks the outside list truncated. */
const MAX_PROCESSES = 5000;
/** Outside launchers listed (the heaviest); the count and totals cover them all. */
const MAX_OUTSIDE = 50;
/** Ancestors followed to tell whether a process runs below another. */
const MAX_DEPTH = 64;

const MIRADOR_UNIT = /^mirador-(agent|shell|git|server)-([\w-]+)\.scope$/;

/**
 * The Mirador unit a cgroup path is, from its last segment (`/proc/<pid>/cgroup` lines and
 * bare paths both work): { kind, id } for `mirador-<agent|shell|git|server>-<id>.scope`, else null.
 */
export function miradorScope(cgroupPath: string): { kind: string; id: string } | null {
  const leaf = cgroupPath.trim().split('/').at(-1) ?? '';
  const match = leaf.match(MIRADOR_UNIT);
  return match ? { kind: match[1], id: match[2] } : null;
}

export interface CpuSample {
  usageUsec: number;
  atMs: number;
}

/**
 * CPU % between two samples: CPU time used over wall time passed, of one core (as top
 * shows it, so a busy agent on several cores goes over 100), with one decimal. Null without
 * two samples, without time between them, or when the counter went back.
 */
export function cpuPercent(before: CpuSample | null, after: CpuSample | null): number | null {
  if (!before || !after) return null;
  const wallUsec = (after.atMs - before.atMs) * 1000;
  const used = after.usageUsec - before.usageUsec;
  if (wallUsec <= 0 || used < 0) return null;
  return Math.round((used / wallUsec) * 1000) / 10;
}

/** The cgroup directory of a user scope `unit` (app.slice of the user's manager). */
export function scopeDir(roots: ResourceRoots, uid: number, unit: string): string {
  return join(roots.sys, 'fs/cgroup/user.slice', `user-${uid}.slice`, `user@${uid}.service`, 'app.slice', unit);
}

export interface TerminalUsage {
  id: string;
  kind: string;
  /** 'scope' (its cgroup), 'tree' (its processes) or null when neither could be read. */
  source: 'scope' | 'tree' | null;
  memory: number | null;
  swap: number | null;
  /** Highest memory.current the scope reached; only a scope knows it. */
  peak: number | null;
  /** % of one core since the previous sample; null on the first one. */
  cpu: number | null;
}

export interface OutsideProcess {
  pid: number;
  cwd: string | null;
  memory: number;
  swap: number;
}

export interface ResourceSnapshot {
  at: string;
  /** Milliseconds since the previous sample, which the CPU figures cover; null on the first. */
  cpuWindowMs: number | null;
  machine: MachineMemory;
  server: { rss: number | null; swap: number | null };
  terminals: TerminalUsage[];
  outside: { count: number; memory: number; swap: number; processes: OutsideProcess[]; truncated: boolean };
}

/** A sample with every figure unknown: what a reader that failed outright answers. */
export function emptySnapshot(atMs: number): ResourceSnapshot {
  return {
    at: new Date(atMs).toISOString(),
    cpuWindowMs: null,
    machine: { memTotal: null, memAvailable: null, swapTotal: null, swapFree: null },
    server: { rss: null, swap: null },
    terminals: [],
    outside: { count: 0, memory: 0, swap: 0, processes: [], truncated: false },
  };
}

export interface SamplerOptions extends PlatformOptions {
  roots?: ResourceRoots;
  uid?: number;
  serverPid?: number;
  now?: () => number;
  maxProcesses?: number;
  maxOutside?: number;
}

export interface ProcessEntry {
  pid: number;
  ppid: number;
  uid: number;
  /** The program's name as the kernel keeps it (`Name:`, the comm, at most 15 bytes): never its arguments. */
  name: string | null;
  rss: number | null;
  swap: number | null;
}

const readText = (path: string): Promise<string | null> => readFile(path, 'utf8').catch(() => null);

async function readNumber(path: string): Promise<number | null> {
  const text = await readText(path);
  const value = text === null ? NaN : Number(text.trim());
  return Number.isFinite(value) ? value : null;
}

/** `Key: value kB` lines (meminfo, status) as bytes, keyed by name. */
function kilobytes(text: string | null, keys: string[]): Record<string, number | null> {
  const out: Record<string, number | null> = Object.fromEntries(keys.map((key) => [key, null]));
  for (const line of (text ?? '').split('\n')) {
    const match = line.match(/^(\w+):\s+(\d+)\s*kB/);
    if (match && match[1] in out) out[match[1]] = Number(match[2]) * 1024;
  }
  return out;
}

export interface MachineMemory {
  memTotal: number | null;
  memAvailable: number | null;
  swapTotal: number | null;
  swapFree: number | null;
}

/** Runs `file args…` and resolves with its stdout, or null when it fails; tests pass fixed answers. */
export type Exec = (file: string, args: string[]) => Promise<string | null>;

/** How long one sysctl or vm_stat may take. */
const EXEC_TIMEOUT_MS = 2000;

const execText: Exec = (file, args) =>
  new Promise((resolve) => execFile(file, args, { timeout: EXEC_TIMEOUT_MS }, (error, stdout) => resolve(error ? null : String(stdout))));

/** Where Mirador reads the machine: the platform and how commands run (both injectable for tests). */
export interface PlatformOptions {
  /** See readerPlatform(): darwin reads sysctl and vm_stat, anything else /proc. */
  platform?: NodeJS.Platform;
  exec?: Exec;
}

/**
 * Which reader runs: an explicit `platform` wins; else injected /proc and /sys trees (a Linux
 * layout, as tests pass them) mean the Linux reader, also on a macOS host; else the host's.
 */
export function readerPlatform(options: { platform?: NodeJS.Platform; injected: boolean; host?: NodeJS.Platform }): NodeJS.Platform {
  return options.platform ?? (options.injected ? 'linux' : (options.host ?? process.platform));
}

const UNITS: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** `2048.00M` (vm.swapusage's figures) in bytes, or null. */
function swapFigure(line: string, name: string): number | null {
  const match = line.match(new RegExp(`\\b${name} = ([\\d.]+)([KMGT])`));
  return match ? Math.round(Number(match[1]) * UNITS[match[2]]) : null;
}

/**
 * The machine's memory on macOS from the output of `sysctl -n hw.memsize vm.swapusage` and of
 * `vm_stat`. Available is what macOS can hand out without paging: (free + inactive + speculative)
 * pages × the page size vm_stat names in its first line. Unreadable figures are null, never guessed.
 */
export function parseDarwinMemory(sysctl: string | null, vmStat: string | null): MachineMemory {
  const [memsize = '', swapusage = ''] = (sysctl ?? '').split('\n');
  const total = /^\d+$/.test(memsize.trim()) ? Number(memsize.trim()) : null;
  const pageSize = vmStat?.match(/page size of (\d+) bytes/)?.[1];
  const pages = (name: string) => vmStat?.match(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.?$`, 'm'))?.[1];
  const counts = [pages('free'), pages('inactive'), pages('speculative')];
  const available = pageSize && counts.every((count) => count !== undefined) ? counts.reduce((sum, count) => sum + Number(count), 0) * Number(pageSize) : null;
  return { memTotal: total, memAvailable: available, swapTotal: swapFigure(swapusage, 'total'), swapFree: swapFigure(swapusage, 'free') };
}

/**
 * The machine's memory, in bytes; a figure it cannot read is null. Never throws. On Linux (and
 * anything but macOS) from `<proc>/meminfo`, on macOS from sysctl and vm_stat (parseDarwinMemory).
 * Shared by the resource samples and the launch gate (src/system/memory-gate.ts).
 */
export async function readMachineMemory(proc?: string, options: PlatformOptions = {}): Promise<MachineMemory> {
  if (readerPlatform({ platform: options.platform, injected: proc !== undefined }) === 'darwin') {
    const exec = options.exec ?? execText;
    const run = (file: string, args: string[]) => exec(file, args).catch(() => null);
    const [sysctl, vmStat] = await Promise.all([run('sysctl', ['-n', 'hw.memsize', 'vm.swapusage']), run('vm_stat', [])]);
    return parseDarwinMemory(sysctl, vmStat);
  }
  const machine = kilobytes(await readText(join(proc ?? DEFAULT_ROOTS.proc, 'meminfo')), ['MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree']);
  return { memTotal: machine.MemTotal, memAvailable: machine.MemAvailable, swapTotal: machine.SwapTotal, swapFree: machine.SwapFree };
}

/** Why Mirador cannot limit its terminals' memory here; GET /api/resources carries it as `limits`. */
export interface LimitsInfo {
  available: false;
  reason: 'macos';
}

/** On macOS (no systemd, no cgroups) the limits are not available; elsewhere null, and the answer has no `limits`. */
export function limitsFor(platform: NodeJS.Platform = process.platform): LimitsInfo | null {
  return platform === 'darwin' ? { available: false, reason: 'macos' } : null;
}

function parseStatus(pid: number, text: string): ProcessEntry | null {
  const ppid = text.match(/^PPid:\s+(\d+)/m);
  const uid = text.match(/^Uid:\s+(\d+)/m);
  if (!ppid || !uid) return null;
  const { VmRSS, VmSwap } = kilobytes(text, ['VmRSS', 'VmSwap']);
  const name = text.match(/^Name:\t(.*)$/m)?.[1] ?? null;
  return { pid, ppid: Number(ppid[1]), uid: Number(uid[1]), name, rss: VmRSS, swap: VmSwap };
}

/** utime + stime of /proc/<pid>/stat in microseconds; the name in parentheses may hold anything. */
function parseCpuUsec(text: string | null): number | null {
  if (!text) return null;
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
  const ticks = Number(fields[11]) + Number(fields[12]);
  return Number.isFinite(ticks) ? ticks * CLOCK_TICK_USEC : null;
}

/** node <…>/gentle-shell.mjs, or the script run directly: not an editor or a file named alike. */
function isLauncher(argv: string[]): boolean {
  if (basename(argv[0] ?? '') === 'gentle-shell.mjs') return true;
  return basename(argv[0] ?? '').startsWith('node') && basename(argv[1] ?? '') === 'gentle-shell.mjs';
}

/**
 * One pass over /proc: every process with its parent, owner, name and memory. Also read by idle
 * sleep's background-work check (src/terminals/background-work.ts).
 */
export class ProcessTable {
  readonly byPid = new Map<number, ProcessEntry>();
  readonly children = new Map<number, number[]>();
  truncated = false;
  private readonly proc: string;

  constructor(proc: string) {
    this.proc = proc;
  }

  async load(maxProcesses: number): Promise<void> {
    const names = await readdir(this.proc).catch(() => [] as string[]);
    const pids = names.filter((name) => /^\d+$/.test(name)).map(Number);
    if (pids.length > maxProcesses) this.truncated = true;
    const entries = await Promise.all(
      pids.slice(0, maxProcesses).map(async (pid) => {
        const text = await readText(join(this.proc, String(pid), 'status'));
        return text === null ? null : parseStatus(pid, text);
      }),
    );
    for (const entry of entries) {
      if (!entry) continue;
      this.byPid.set(entry.pid, entry);
      const siblings = this.children.get(entry.ppid) ?? [];
      siblings.push(entry.pid);
      this.children.set(entry.ppid, siblings);
    }
  }

  /** `pid` and every process below it. */
  tree(pid: number): number[] {
    const out: number[] = [];
    const stack = [pid];
    const seen = new Set<number>();
    while (stack.length) {
      const next = stack.pop()!;
      if (seen.has(next) || !this.byPid.has(next)) continue;
      seen.add(next);
      out.push(next);
      stack.push(...(this.children.get(next) ?? []));
    }
    return out;
  }

  /** Whether `pid` runs below a process for which `test` holds. */
  below(pid: number, test: (ancestor: number) => boolean): boolean {
    let current = this.byPid.get(pid)?.ppid;
    for (let depth = 0; current !== undefined && current > 0 && depth < MAX_DEPTH; depth++) {
      if (test(current)) return true;
      current = this.byPid.get(current)?.ppid;
    }
    return false;
  }

  memoryOf(pids: number[]): { memory: number; swap: number } {
    let memory = 0;
    let swap = 0;
    for (const pid of pids) {
      memory += this.byPid.get(pid)?.rss ?? 0;
      swap += this.byPid.get(pid)?.swap ?? 0;
    }
    return { memory, swap };
  }

  async cpuOf(pids: number[]): Promise<number | null> {
    const usages = await Promise.all(pids.map(async (pid) => parseCpuUsec(await readText(join(this.proc, String(pid), 'stat')))));
    return usages.some((usage) => usage === null) ? null : usages.reduce((sum: number, usage) => sum + usage!, 0);
  }

  async argv(pid: number): Promise<string[]> {
    const text = await readText(join(this.proc, String(pid), 'cmdline'));
    return text ? text.split('\0').filter(Boolean) : [];
  }
}

/**
 * Takes resource samples. It keeps the previous CPU counters (only those of the last
 * sample) to turn the next sample's counters into CPU %.
 */
export class ResourceSampler {
  private readonly roots: ResourceRoots;
  private readonly uid: number;
  private readonly serverPid: number;
  private readonly now: () => number;
  private readonly maxProcesses: number;
  private readonly maxOutside: number;
  private readonly platformOptions: PlatformOptions;
  private previous = new Map<string, CpuSample>();
  private previousAt: number | null = null;

  constructor(options: SamplerOptions = {}) {
    this.roots = options.roots ?? DEFAULT_ROOTS;
    this.uid = options.uid ?? process.getuid?.() ?? 0;
    this.serverPid = options.serverPid ?? process.pid;
    this.now = options.now ?? Date.now;
    this.maxProcesses = options.maxProcesses ?? MAX_PROCESSES;
    this.maxOutside = options.maxOutside ?? MAX_OUTSIDE;
    this.platformOptions = { platform: readerPlatform({ platform: options.platform, injected: options.roots !== undefined }), exec: options.exec };
  }

  /** One sample of `terminals` (TerminalInfo or the fields used here), the machine and the outside launchers. */
  async sample(terminals: Array<{ id: string; kind: string; status: string }>): Promise<ResourceSnapshot> {
    const atMs = this.now();
    const table = new ProcessTable(this.roots.proc);
    const [machine, serverStatus] = await Promise.all([
      readMachineMemory(this.roots.proc, this.platformOptions),
      readText(join(this.roots.proc, String(this.serverPid), 'status')),
      table.load(this.maxProcesses),
    ]);
    const counters = new Map<string, CpuSample>();
    const roots = await this.terminalRoots(table);
    const usages = await Promise.all(terminals.map((terminal) => this.terminalUsage(terminal, table, roots, atMs, counters)));
    const server = kilobytes(serverStatus, ['VmRSS', 'VmSwap']);
    const outside = await this.outside(table);
    const snapshot: ResourceSnapshot = {
      at: new Date(atMs).toISOString(),
      cpuWindowMs: this.previousAt === null ? null : atMs - this.previousAt,
      machine,
      server: { rss: server.VmRSS, swap: server.VmSwap },
      terminals: usages,
      outside,
    };
    this.previous = counters;
    this.previousAt = atMs;
    return snapshot;
  }

  private async terminalUsage(
    terminal: { id: string; kind: string; status: string },
    table: ProcessTable,
    roots: Map<string, number>,
    atMs: number,
    counters: Map<string, CpuSample>,
  ): Promise<TerminalUsage> {
    const usage: TerminalUsage = { id: terminal.id, kind: terminal.kind, source: null, memory: null, swap: null, peak: null, cpu: null };
    if (terminal.status !== 'running') return usage;
    const rate = (key: string, usageUsec: number | null) => {
      if (usageUsec === null) return null;
      const now = { usageUsec, atMs };
      counters.set(key, now);
      return cpuPercent(this.previous.get(key) ?? null, now);
    };
    const dir = scopeDir(this.roots, this.uid, `mirador-${terminal.kind}-${terminal.id}.scope`);
    const memory = await readNumber(join(dir, 'memory.current'));
    if (memory !== null) {
      const [swap, peak, stat] = await Promise.all([readNumber(join(dir, 'memory.swap.current')), readNumber(join(dir, 'memory.peak')), readText(join(dir, 'cpu.stat'))]);
      const usec = stat?.match(/^usage_usec (\d+)/m);
      return { ...usage, source: 'scope', memory, swap, peak, cpu: rate(`scope:${terminal.id}`, usec ? Number(usec[1]) : null) };
    }
    const root = roots.get(terminal.id);
    if (root === undefined) return usage;
    const pids = table.tree(root);
    const { memory: rss, swap } = table.memoryOf(pids);
    return { ...usage, source: 'tree', memory: rss, swap, cpu: rate(`tree:${terminal.id}`, await table.cpuOf(pids)) };
  }

  /** Terminal id → the pid of its shell: the server's children, by HERDR_PANE_ID in their environment. */
  private async terminalRoots(table: ProcessTable): Promise<Map<string, number>> {
    const roots = new Map<string, number>();
    await Promise.all(
      (table.children.get(this.serverPid) ?? []).map(async (pid) => {
        const environ = await readText(join(this.roots.proc, String(pid), 'environ'));
        const id = environ?.split('\0').find((entry) => entry.startsWith('HERDR_PANE_ID='))?.slice('HERDR_PANE_ID='.length);
        if (id) roots.set(id, pid);
      }),
    );
    return roots;
  }

  private async outside(table: ProcessTable): Promise<ResourceSnapshot['outside']> {
    const own = [...table.byPid.values()].filter((entry) => entry.uid === this.uid);
    const launchers = new Set<number>();
    await Promise.all(own.map(async (entry) => isLauncher(await table.argv(entry.pid)) && launchers.add(entry.pid)));
    const found: OutsideProcess[] = [];
    for (const pid of launchers) {
      // Below this server, or below another launcher (already in that one's tree).
      if (table.below(pid, (ancestor) => ancestor === this.serverPid || launchers.has(ancestor))) continue;
      const cgroup = await readText(join(this.roots.proc, String(pid), 'cgroup'));
      if (cgroup !== null && miradorScope(cgroup.split('\n').find((line) => line.startsWith('0::')) ?? '')) continue;
      const cwd = await readlink(join(this.roots.proc, String(pid), 'cwd')).catch(() => null);
      found.push({ pid, cwd, ...table.memoryOf(table.tree(pid)) });
    }
    found.sort((a, b) => b.memory + b.swap - (a.memory + a.swap) || a.pid - b.pid);
    return {
      count: found.length,
      memory: found.reduce((sum, p) => sum + p.memory, 0),
      swap: found.reduce((sum, p) => sum + p.swap, 0),
      processes: found.slice(0, this.maxOutside),
      truncated: table.truncated || found.length > this.maxOutside,
    };
  }
}
