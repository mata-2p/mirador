import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const LOOPBACK_NAMES = ['127.0.0.1', 'localhost'];
const AUTH_PROTOCOL_PREFIX = 'auth.';

export const APP_PROTOCOL = 'mirador.v1';

export function createToken(): string {
  return randomBytes(32).toString('base64url');
}

export function tokensMatch(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Blocks DNS-rebinding: the Host header must name our loopback listener. */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  return !!host && LOOPBACK_NAMES.some((name) => host === `${name}:${port}`);
}

/** Blocks cross-site requests and WebSocket hijacking from other pages. */
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  return !!origin && LOOPBACK_NAMES.some((name) => origin === `http://${name}:${port}`);
}

export function bearerToken(header: string | undefined): string | undefined {
  return header?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
}

/** Browsers cannot set headers on WebSockets, so the page offers its token as a subprotocol. */
export function protocolToken(protocols: Set<string> | undefined): string | undefined {
  for (const protocol of protocols ?? []) {
    if (protocol.startsWith(AUTH_PROTOCOL_PREFIX)) return protocol.slice(AUTH_PROTOCOL_PREFIX.length);
  }
  return undefined;
}

/**
 * How long a launch nonce stays redeemable. The clock starts when the launcher asks for it, before
 * the browser exists: on WSL2 in a VM, starting powershell.exe and Edge alone took 12.7 s. Single
 * use still ends it the moment the window redeems it.
 */
export const LAUNCH_NONCE_TTL_MS = 60_000;

/**
 * The launch nonce lifetime for MIRADOR_LAUNCH_NONCE_TTL_MS, a test seam (test/server.test.ts):
 * a whole number of milliseconds from 1 to LAUNCH_NONCE_TTL_MS shortens it; anything else, unset
 * included, keeps the 60 s. It can never make a link live longer.
 */
export function launchNonceTtlMs(value: string | undefined): number {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return LAUNCH_NONCE_TTL_MS;
  const ms = Number(value);
  return ms <= LAUNCH_NONCE_TTL_MS ? ms : LAUNCH_NONCE_TTL_MS;
}

/**
 * The key a nonce is filed under: its SHA-256 digest, so looking one up never compares the secret
 * itself byte by byte (a timing leak about the digest says nothing about the nonce).
 */
function nonceKey(nonce: string): string {
  return createHash('sha256').update(nonce).digest('base64url');
}

/**
 * Single-use, short-lived nonces that the launcher puts in the window URL.
 * Seeing a used or expired nonce (argv, browser history) grants nothing.
 */
export class LaunchNonces {
  private readonly ttlMs: number;
  /** Digest of each pending nonce (nonceKey) to the time it expires; the nonces themselves are not kept. */
  private readonly pending = new Map<string, number>();

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  issue(now = Date.now()): string {
    for (const [key, expiresAt] of this.pending) if (expiresAt < now) this.pending.delete(key);
    const nonce = createToken();
    this.pending.set(nonceKey(nonce), now + this.ttlMs);
    return nonce;
  }

  consume(nonce: string | undefined, now = Date.now()): boolean {
    if (!nonce) return false;
    const key = nonceKey(nonce);
    const expiresAt = this.pending.get(key);
    this.pending.delete(key);
    return expiresAt !== undefined && now <= expiresAt;
  }

  /**
   * Forgets every link still pending, so none of them opens a session afterwards.
   *
   * "Sign out the other windows" ends what the other sessions hold open; a link already handed out
   * is the same risk one step earlier, and docs/security.md promises the other windows need a new
   * one (#68).
   */
  clear(): void {
    this.pending.clear();
  }
}

/**
 * Session tokens held in page memory (sessionStorage) and sent as a header,
 * never as a cookie: cookies are shared by every port on 127.0.0.1. Past the cap the least recently
 * used token is forgotten, so scripts that open sessions never push out a window still in use.
 */
export class Sessions {
  private readonly cap: number;
  private readonly tokens: string[] = [];

  constructor(cap: number) {
    this.cap = cap;
  }

  create(): string {
    const token = createToken();
    this.tokens.push(token);
    if (this.tokens.length > this.cap) this.tokens.shift();
    return token;
  }

  has(token: string | undefined): boolean {
    if (!token) return false;
    const index = this.tokens.findIndex((known) => tokensMatch(token, known));
    if (index < 0) return false;
    this.tokens.push(...this.tokens.splice(index, 1));
    return true;
  }

  /**
   * "Sign out the other windows": forgets every session but `keep`'s and returns the tokens it
   * forgot, so the server can close what they hold open (SessionClosers). An unknown or missing `keep` forgets
   * nothing, so a caller can never sign itself out this way.
   */
  signOutOthers(keep: string | undefined): string[] {
    if (!keep) return [];
    const index = this.tokens.findIndex((known) => tokensMatch(keep, known));
    if (index < 0) return [];
    const kept = this.tokens[index];
    return this.tokens.splice(0, this.tokens.length, kept).filter((token) => token !== kept);
  }
}

/**
 * What "sign out the other windows" ends at once, per session token: every open terminal socket and
 * inbox stream registers its closer here while it is open. Only a sign-out runs them; a session that
 * only falls out of the 32-session cap keeps what it has open.
 */
export class SessionClosers {
  private readonly byToken = new Map<string, Set<() => void>>();

  /** Runs `close` if `token`'s session is signed out. Returns the unregister, for when it closes by itself. */
  add(token: string, close: () => void): () => void {
    let closers = this.byToken.get(token);
    if (!closers) this.byToken.set(token, (closers = new Set()));
    closers.add(close);
    return () => {
      closers.delete(close);
      if (!closers.size && this.byToken.get(token) === closers) this.byToken.delete(token);
    };
  }

  /** Runs, once, every closer registered for `tokens`. */
  close(tokens: string[]): void {
    for (const token of tokens) {
      const closers = this.byToken.get(token);
      this.byToken.delete(token);
      for (const close of closers ?? []) close();
    }
  }
}

const closersByApp = new WeakMap<object, SessionClosers>();

/** Lets route modules reach the server's SessionClosers through `app` (the terminal registry). */
export function provideSessionClosers(app: object, closers: SessionClosers): void {
  closersByApp.set(app, closers);
}

export function sessionClosers(app: object): SessionClosers | undefined {
  return closersByApp.get(app);
}
