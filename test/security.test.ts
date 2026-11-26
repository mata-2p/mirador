import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LaunchNonces,
  LAUNCH_NONCE_TTL_MS,
  Sessions,
  bearerToken,
  createToken,
  isAllowedHost,
  isAllowedOrigin,
  launchNonceTtlMs,
  protocolToken,
  tokensMatch,
  SessionClosers,
  provideSessionClosers,
  requireSessionClosers,
} from '../src/http/security.ts';

const PORT = 4545;

test('createToken returns distinct url-safe tokens of at least 32 chars', () => {
  const a = createToken();
  const b = createToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{32,}$/);
});

test('tokensMatch compares safely and rejects different lengths', () => {
  assert.equal(tokensMatch('abc', 'abc'), true);
  assert.equal(tokensMatch('abc', 'abd'), false);
  assert.equal(tokensMatch('abc', 'abcd'), false);
  assert.equal(tokensMatch(undefined, 'abc'), false);
});

test('isAllowedHost accepts only loopback names on our port', () => {
  assert.equal(isAllowedHost('127.0.0.1:4545', PORT), true);
  assert.equal(isAllowedHost('localhost:4545', PORT), true);
  assert.equal(isAllowedHost('localhost:9999', PORT), false);
  assert.equal(isAllowedHost('evil.example:4545', PORT), false);
  assert.equal(isAllowedHost(undefined, PORT), false);
});

test('isAllowedOrigin accepts only our own loopback origin', () => {
  assert.equal(isAllowedOrigin('http://127.0.0.1:4545', PORT), true);
  assert.equal(isAllowedOrigin('http://localhost:4545', PORT), true);
  assert.equal(isAllowedOrigin('https://evil.example', PORT), false);
  assert.equal(isAllowedOrigin('http://127.0.0.1:4546', PORT), false);
  assert.equal(isAllowedOrigin('null', PORT), false);
  assert.equal(isAllowedOrigin(undefined, PORT), false);
});

test('a launch nonce works once and only before it expires', () => {
  const nonces = new LaunchNonces(60_000);
  const nonce = nonces.issue(1_000);
  // bin/mirador hands the launch URL to PowerShell inside a single-quoted literal: base64url only.
  assert.match(nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(nonces.consume(nonce, 2_000), true);
  assert.equal(nonces.consume(nonce, 2_000), false);

  const late = nonces.issue(1_000);
  assert.equal(nonces.consume(late, 61_001), false);
  assert.equal(nonces.consume('made-up', 2_000), false);
  assert.equal(nonces.consume(undefined, 2_000), false);
});

test('a launch nonce lives 60 s, enough for a slow WSL2 launch that took 12.7 s before the page opened', () => {
  assert.equal(LAUNCH_NONCE_TTL_MS, 60_000);
  const nonces = new LaunchNonces(LAUNCH_NONCE_TTL_MS);
  assert.equal(nonces.consume(nonces.issue(1_000), 1_000 + 12_700), true);
  assert.equal(nonces.consume(nonces.issue(1_000), 61_001), false);
});

test('a nonce one character off a pending one is refused and does not burn the real one', () => {
  const nonces = new LaunchNonces(60_000);
  const nonce = nonces.issue(1_000);
  const last = nonce.at(-1) === 'A' ? 'B' : 'A';
  assert.equal(nonces.consume(nonce.slice(0, -1) + last, 2_000), false);
  assert.equal(nonces.consume(nonce.slice(0, -1), 2_000), false);
  assert.equal(nonces.consume(`${nonce}x`, 2_000), false);
  assert.equal(nonces.consume(nonce, 2_000), true);
});

test('the launch nonce lifetime can only be shortened from the environment, never lengthened', () => {
  assert.equal(launchNonceTtlMs(undefined), 60_000);
  assert.equal(launchNonceTtlMs(''), 60_000);
  assert.equal(launchNonceTtlMs('1000'), 1_000);
  assert.equal(launchNonceTtlMs('60000'), 60_000);
  for (const value of ['60001', '3600000', '0', '-5', '1.5', 'abc', ' 1000', '1e3', 'Infinity']) {
    assert.equal(launchNonceTtlMs(value), 60_000, value);
  }
});

test('sessions validate their own tokens and forget the oldest past the cap', () => {
  const sessions = new Sessions(2);
  const first = sessions.create();
  const second = sessions.create();
  assert.equal(sessions.has(first), true);
  assert.equal(sessions.has(second), true);
  assert.equal(sessions.has('made-up'), false);
  assert.equal(sessions.has(undefined), false);

  sessions.create();
  assert.equal(sessions.has(first), false);
  assert.equal(sessions.has(second), true);
});

test('a session in use is not the one forgotten when new sessions pass the cap', () => {
  const sessions = new Sessions(2);
  const window = sessions.create();
  const script = sessions.create();
  assert.equal(sessions.has(window), true);

  sessions.create();
  assert.equal(sessions.has(window), true);
  assert.equal(sessions.has(script), false);
});

test('bearerToken reads an Authorization header', () => {
  assert.equal(bearerToken('Bearer abc_123-x'), 'abc_123-x');
  assert.equal(bearerToken('Basic abc'), undefined);
  assert.equal(bearerToken(undefined), undefined);
});

test('protocolToken reads the auth token offered as a WebSocket subprotocol', () => {
  assert.equal(protocolToken(new Set(['mirador.v1', 'auth.abc_123'])), 'abc_123');
  assert.equal(protocolToken(new Set(['mirador.v1'])), undefined);
  assert.equal(protocolToken(undefined), undefined);
});

test('signing out the others forgets every session but the caller\'s and returns the ones it forgot', () => {
  const sessions = new Sessions(32);
  const caller = sessions.create();
  const phone = sessions.create();
  const other = sessions.create();
  assert.deepEqual(new Set(sessions.signOutOthers(caller)), new Set([phone, other]));
  assert.equal(sessions.has(caller), true);
  assert.equal(sessions.has(phone), false);
  assert.equal(sessions.has(other), false);
  assert.deepEqual(sessions.signOutOthers(caller), [], 'nothing left to forget');
  assert.equal(sessions.has(caller), true);
});

test('signing out with an unknown or missing caller forgets nothing', () => {
  const sessions = new Sessions(32);
  const window = sessions.create();
  assert.deepEqual(sessions.signOutOthers('made-up'), []);
  assert.deepEqual(sessions.signOutOthers(undefined), []);
  assert.equal(sessions.has(window), true);
});

test('preserved: after a sign-out the cap still forgets the least recently used session', () => {
  const sessions = new Sessions(2);
  const caller = sessions.create();
  sessions.create();
  sessions.signOutOthers(caller);
  const idle = sessions.create();
  assert.equal(sessions.has(caller), true);
  sessions.create();
  assert.equal(sessions.has(idle), false);
  assert.equal(sessions.has(caller), true);
});

// #69: a stream or socket must register its closer under the string a sign-out looks up.
test('a session answers its stored token, so a closer registers under the same string a sign-out forgets', () => {
  const sessions = new Sessions(8);
  const token = sessions.create();
  assert.equal(sessions.canonical(token), token);
  assert.equal(sessions.canonical('not-a-session'), null);
  assert.equal(sessions.canonical(undefined), null);
  const closers = new SessionClosers();
  let closed = 0;
  closers.add(sessions.canonical(token)!, () => (closed += 1));
  // A second session is the caller of the sign-out; `token` is the one it forgets.
  const caller = sessions.create();
  closers.close(sessions.signOutOthers(caller));
  assert.equal(closed, 1, 'the stored token the sign-out returns runs the closer registered for it');
});

// #69: falling back to a no-op would silently stop ending streams on sign-out.
test('a route that needs the session closers says so when they are not wired', () => {
  const app = {};
  assert.throws(() => requireSessionClosers(app), /not wired/);
  const closers = new SessionClosers();
  provideSessionClosers(app, closers);
  assert.equal(requireSessionClosers(app), closers);
});
