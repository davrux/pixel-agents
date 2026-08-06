// Desktop cross-origin auth — integration Test - Design Doc: docs/design/desktop-application-design.md
// PRD AC source: docs/prd/desktop-application-prd.md (AC-005..AC-012)
// Generated: 2026-07-01 | Budget Used: integration 3/3, fixture-e2e 0/3, service-integration-e2e 0/2
//
// ============================================================================
// STATUS: implemented executable integration tests.
// ----------------------------------------------------------------------------
// This file contains real `node:test` + `node:assert/strict` imports and
// executable tests exercising the desktop cross-origin auth path against a real
// SQLite session/user store. Coverage:
//   - cookie onAuth non-regression (the same-origin browser path is preserved)
//   - bearer token issuance via POST /desktop/token and its equivalence to a
//     cookie session (same store / TTL)
//   - onAuth rejection of invalid/expired bearer tokens
//   - POST /desktop/signout revocation (idempotent)
//   - CORS: Authorization allowed without Access-Control-Allow-Credentials
// Run via the `server` package.json `test` script (`node --test`).
// ----------------------------------------------------------------------------
//
// TEST BOUNDARIES (from Design Doc "Test Boundaries" -> Mock Boundary Decisions):
//   @real-dependency: appStore session store (SQLite)  -- Mock? NO.
//       Use a real temp / in-memory SQLite so token issuance + validation is
//       exercised against the real `sessions(sid, user_id, expires)` schema.
//       Mocks cannot prove the bearer token IS a live session row.
//   @real-dependency: userStore credential verification -- Mock? NO.
//       Same credential logic as /login; verify against the real store to catch
//       schema / scrypt-verification drift. Seed a known user via
//       userStore.createUser before each test.
//   @mock-boundary: Colyseus transport in onAuth  -- Mock? YES (construct
//       AuthContext directly). onAuth is a pure function of
//       (client, options, context); call it with a crafted
//       AuthContext{ token } or { headers: { cookie } } — do NOT spin the full
//       Colyseus transport. `_client` and `_options` are unused by onAuth.
//   NOT covered here (manual / other lanes, honest absence): Electron
//       safeStorage plaintext-absence (AC-020, manual on-disk inspection),
//       getUserMedia/getDisplayMedia/WebGL parity (AC-013..016,021, manual on
//       Linux), renderer connection/sign-in screen journey (AC-001..004,019),
//       packaging (AC-017,018).
//
// Verified against real source (function/route names are accurate targets):
//   server/src/auth.ts        : tokenEquals, userIdFromCookie, hasValidSession,
//                               registerAuth (/login, /logout). NEW to add:
//                               userIdFromBearer(authHeader),
//                               hasValidBearerSession(authHeader),
//                               POST /desktop/token, POST /desktop/signout.
//   server/src/appStore.ts    : createSession(userId)->sid,
//                               getSession(sid)->{userId}|undefined (lazy TTL),
//                               deleteSession(sid). SESSION_TTL_MS = 7 days.
//   server/src/rooms/SimRoom.ts:190-198 : onAuth(_client,_options,context)
//                               reads context.headers.get('cookie') today; NEW additive
//                               bearer branch reads context.token.
//   server/src/index.ts       : open cors(); NEW narrow CORS headers on the
//                               token/signout/health cross-origin responses.
//
// Suggested test execution order (independent, but logically layered):
//   1) AC-010/011 non-regression   2) AC-005 equivalence
//   3) AC-009/008 rejection+revoke 4) AC-005/006 issuance   5) AC-012 CORS
// Each test MUST create its own seeded user + fresh SQLite and clean up (no
// shared session rows, no order dependency).
//
// ============================================================================
// TEST 1  [SELECTED — integration rank 1 of 3, ROI 109]
// ============================================================================
// AC-010: "When a browser user on the server's origin signs in, plays, and signs
//          out, the system shall behave identically to before this change
//          (cookie set/validated/cleared, cookie onAuth join)."
// AC-011: "When a browser user with only the session cookie connects, the system
//          shall still authorize the room join via the cookie path."
// ROI: 109 (BV:10 x Freq:10 + Legal:0 + Defect:9)  -- highest: hard-constraint
//      release gate (FR-3). A regression here breaks every existing browser user.
// Behavior: seed user -> createSession -> onAuth called with a crafted
//   AuthContext whose headers carry cookie `pixel_stream_sid=<sid>` (and no
//   context.token) -> resolves AuthInfo for that user, unchanged from baseline.
// @category: integration
// @lane: integration
// @dependency: appStore (real SQLite), userStore (real), SimRoom.onAuth (direct call)
// @complexity: medium
// Primary failure mode: the additive bearer branch alters or shadows the cookie
//   branch so a cookie-only join stops authorizing (or resolves a different
//   AuthInfo) — the exact browser regression AC-010..012 gate against.
// Proof obligation: the cookie branch is evaluated FIRST and is byte-for-byte
//   unchanged. Assert: (a) onAuth with a valid cookie + NO context.token returns
//   AuthInfo{userId, username, isAdmin} equal to the seeded user's expected
//   values (literal expected values, computed independently of the code under
//   test); (b) the anonymous short-circuit still holds — with authRequired=false,
//   onAuth returns {userId:'', username:'', isAdmin:false} regardless of
//   credentials. Boundary path to traverse: cookie-present-and-valid while
//   context.token is absent (the main bearer path must NOT be the one that
//   authorizes here). Real SQLite + real userStore (no mocks); Colyseus
//   transport mocked by constructing AuthContext directly.
// Verification points / expected results / pass criteria:
//   - VP1: valid cookie, no token -> returns seeded user's AuthInfo (field-equal).
//   - VP2: displayName mapping (UserStore.displayName) unchanged for that user.
//   - VP3: authRequired=false -> anonymous AuthInfo, no throw.
//   - VP4: an unknown/absent cookie with authRequired=true -> throws 'unauthorized'.
//   PASS: all four hold; cookie-path AuthInfo matches a pre-change baseline.
//
// ============================================================================
// TEST 2  [SELECTED — integration rank 2 of 3, ROI 89]
// ============================================================================
// AC-005: "When the user submits valid credentials on the desktop sign-in
//          screen, the system shall obtain a bearer token accepted by onAuth and
//          land in the world." (server-verifiable portion: issued token is
//          accepted by onAuth and resolves the SAME AuthInfo as the cookie path.)
// AC-006: "If credentials are invalid, then the system shall show an
//          authentication error and not connect." (server portion: /desktop/token
//          returns 401 and issues no session for bad creds.)
// ROI: 89 (BV:10 x Freq:8 + Legal:0 + Defect:9)
// Behavior: POST /desktop/token {username,password[,token]} -> verifies creds
//   with the SAME logic as /login -> createSession -> 200 {token: sid}; then that
//   sid, presented via `Authorization: Bearer <sid>` -> context.token -> onAuth
//   bearer branch -> AuthInfo. Bad creds -> 401, no session row created.
// @category: core-functionality
// @lane: integration
// @dependency: appStore (real SQLite), userStore (real), auth.ts token route,
//   SimRoom.onAuth (direct call with AuthContext{token})
// @complexity: high
// Primary failure mode: issuance succeeds but the issued token is NOT accepted by
//   onAuth, OR the bearer branch resolves a DIFFERENT AuthInfo than the cookie
//   path for the same user (auth divergence / privilege drift), OR bad creds
//   still mint a usable token.
// Proof obligation: prove cross-credential equivalence AND the issuance contract.
//   Assert: (a) valid creds -> 200 with a `token` string that is a live session
//   row (appStore.getSession(token) resolves to the seeded userId — real DB
//   read, not a mock); (b) onAuth called with AuthContext{ token } (no cookie)
//   returns AuthInfo FIELD-IDENTICAL to the cookie-branch AuthInfo for the same
//   seeded user (the Output Comparison in the Design Doc — cookie vs bearer,
//   field-by-field equality); (c) admin path: presenting the correct admin token
//   yields isAdmin=true equivalently to /login; (d) bad password / unknown user
//   -> 401 with the generic message and NO new sessions row. Boundary path:
//   the bearer branch (branch 3 of onAuth) while the cookie header is absent.
//   Endpoint mounted only when ADMIN_TOKEN is set (same gate as registerAuth).
//   Real SQLite + real userStore; Colyseus transport mocked via AuthContext.
// Verification points / expected results / pass criteria:
//   - VP1: valid creds -> 200, body.token present, getSession(token).userId == seeded id.
//   - VP2: onAuth(AuthContext{token}) AuthInfo === onAuth(cookie) AuthInfo (all fields).
//   - VP3: correct admin token path -> isAdmin true; no self-registration for normal path.
//   - VP4: bad creds -> 401, generic message, sessions table unchanged (count stable).
//   - VP5: token/password/admin-token never appear in the response body or logs.
//   PASS: all VPs hold; the token minted by the endpoint authorizes at onAuth
//         and is indistinguishable in AuthInfo from a cookie session.
//
// ============================================================================
// TEST 3  [SELECTED — integration rank 3 of 3, ROI ~53 blended]
// ============================================================================
// Consolidates the two distinct high-value negative/lifecycle + contract
// behaviors that would otherwise each need a slot; grouped because they share
// the same real-SQLite session fixture and assert the auth boundary's safety.
//
// --- Part A: rejection + revoke lifecycle ---
// AC-009: "If a stored token is rejected on connect (auth error), then the system
//          shall return to the in-app sign-in screen rather than loop or show a
//          blank world." (server portion: an invalid/expired/deleted token is
//          rejected by onAuth so the client observes the auth error.)
// AC-008: "When the user confirms sign-out, the system shall call the server
//          sign-out endpoint (delete the session), clear the stored token, and
//          return to the sign-in screen." (server portion: /desktop/signout
//          deletes the session; the token no longer authorizes.)
// ROI(A): 56 (BV:8 x Freq:6 + Defect:8) / 36 (AC-008) -> grouped
// --- Part B: CORS contract ---
// AC-012: "When the server CORS/auth changes are deployed and the same-origin
//          browser client operates, the system shall raise no new cross-origin
//          prompt, CORS failure, or login regression." (verifiable slice: the
//          token/signout/health responses allow the Authorization header
//          cross-origin and do NOT set Access-Control-Allow-Credentials.)
// ROI(B): 50 (BV:7 x Freq:6 + Defect:8)
// @category: edge-case
// @lane: integration
// @dependency: appStore (real SQLite), auth.ts (/desktop/signout + bearer helper),
//   SimRoom.onAuth (direct call), index.ts CORS headers
// @complexity: medium
// Primary failure mode (A): a stale/expired/revoked token still authorizes at
//   onAuth (auth bypass), OR onAuth loops / returns a blank AuthInfo instead of
//   throwing 'unauthorized', so the client cannot deterministically fall back to
//   SignIn. Primary failure mode (B): CORS is broadened to set
//   Access-Control-Allow-Credentials (opening a cross-origin cookie surface) or
//   fails to allow the Authorization header — either regresses AC-012.
// Proof obligation:
//   (A) After a session is invalid, onAuth must THROW rather than resolve. Assert
//       with distinct boundary inputs, each on real SQLite:
//         - context.token = a syntactically valid but never-issued sid -> throws.
//         - an expired session (seed a row with expires < now, or advance
//           deterministic time) -> getSession lazy-deletes -> onAuth throws.
//         - after POST /desktop/signout with Authorization: Bearer <sid>
//           (deleteSession) -> getSession(sid) returns undefined -> onAuth with
//           that same token throws 'unauthorized'.
//         - signout is idempotent: a second signout (or signout of an absent sid)
//           returns 204 and never reveals whether the sid existed.
//       Use deterministic time (inject/override the clock) for the expiry case —
//       no real wall-clock sleep (reproducibility).
//   (B) Assert the CORS response contract on a cross-origin request to
//       /desktop/token (and /health): Access-Control-Allow-Headers includes
//       `Authorization`; Access-Control-Allow-Credentials is NOT present in the
//       response headers; the same-origin path is unaffected (existing open
//       cors() behavior for other routes preserved).
// Verification points / expected results / pass criteria:
//   - VP1: never-issued token -> onAuth throws 'unauthorized'.
//   - VP2: expired session -> onAuth throws; row is lazy-deleted from sessions.
//   - VP3: signout deletes the row -> getSession undefined -> onAuth throws.
//   - VP4: signout is idempotent -> 204 on repeat / absent sid, no leak.
//   - VP5: preflight/response allows Authorization header cross-origin.
//   - VP6: response does NOT set Access-Control-Allow-Credentials.
//   PASS: every invalid-token path throws (no bypass, no blank AuthInfo, no loop)
//         and the CORS headers match the contract exactly.
//
// ============================================================================
// NOT SELECTED (budget full at 3; recorded for traceability)
// ============================================================================
// - AC-007 auto-connect-on-restart: the server-side proof (a stored sid within
//   the 7-day TTL still resolves via getSession -> onAuth accepts) is already
//   covered by TEST 2 VP1 + TEST 3 VP2 (TTL boundary). The restart itself is a
//   desktop/renderer concern (safeStorage read after relaunch) -> manual.
// - AC-001..004 connection screen / origin derivation: renderer + preload;
//   pushed down to manual (no browser/Electron test harness in this repo).
//
// ============================================================================
// EXECUTABLE TESTS
// ----------------------------------------------------------------------------
// Scope of THIS file's executable tests (T1.4): TEST 2 issuance VPs
// (VP1/VP3/VP4/VP5) + TEST 3A signout VPs. TEST 2 VP2 (onAuth AuthInfo
// equivalence) and TEST 3A onAuth-rejection assertions depend on the onAuth
// bearer branch (SimRoom.ts) added in T1.5, and TEST 3B CORS depends on
// index.ts headers added in T1.6 — added by those tasks.
//
// The server DB is a process-wide singleton keyed off PIXEL_STREAM_DATA_DIR at
// module load (server/src/db.ts). We point it at a fresh temp dir BEFORE the
// dynamic imports so tests exercise the real sessions/users schema without
// touching a developer's ~/.pixel-agents2. Each test seeds a uniquely-named
// user + cleans up so there is no order dependency (per skeleton isolation
// contract).
// ============================================================================
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const ADMIN_TOKEN = 'test-admin-token-xyz';

let dataDir: string;
let server: Server;
let baseUrl: string;
// Bound after the dynamic imports (kept loose so static imports do not evaluate
// db.ts before PIXEL_STREAM_DATA_DIR is set).
let appStore: typeof import('./appStore.js').appStore;
let userStore: typeof import('./userStore.js').userStore;
let SimRoom: typeof import('./rooms/SimRoom.js').SimRoom;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'pixel-auth-desktop-test-'));
  process.env.PIXEL_STREAM_DATA_DIR = dataDir;

  const express = (await import('express')).default;
  ({ appStore } = await import('./appStore.js'));
  ({ userStore } = await import('./userStore.js'));
  const { registerAuth } = await import('./auth.js');
  ({ SimRoom } = await import('./rooms/SimRoom.js'));
  // Narrow CORS is applied by index.ts before registerAuth; mount it here the
  // same way so the header contract (TEST 3B) is exercised against the real
  // middleware without booting the full server.
  const { desktopCors } = await import('./index.js');

  const app = express();
  app.use(desktopCors());
  app.get('/health', (_req, res) => void res.json({ ok: true }));
  registerAuth(app, ADMIN_TOKEN);

  // Express 5 types the listen callback as `(error?: Error) => void`, so the
  // promise settles explicitly rather than handing `resolve` over directly.
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', (err?: Error) => (err ? reject(err) : resolve()));
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => {
  server?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function sessionCount(): number {
  const store = appStore as unknown as { db: { prepare(sql: string): { get(): unknown } } };
  const row = store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
  return row.n;
}

async function postToken(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/desktop/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// onAuth is a pure function of (client, options, context) that reads only
// `this.authRequired` from the room. We invoke it directly with a crafted
// AuthContext (Colyseus transport mocked) and a minimal `this` — no full
// Colyseus room/transport is spun up (per the @mock-boundary decision).
type AuthInfo = { userId: string; username: string; isAdmin: boolean; role?: string };

function callOnAuth(
  authRequired: boolean,
  context: { token?: string; cookie?: string },
): AuthInfo {
  const authContext = {
    token: context.token,
    // Colyseus 0.17's AuthContext carries a WHATWG `Headers`, not a plain
    // object — the mock mirrors that so onAuth's .get('cookie') is exercised.
    headers: new Headers(context.cookie === undefined ? {} : { cookie: context.cookie }),
    ip: '127.0.0.1',
  };
  // Minimal `this` (mock boundary): the room-entry gate (gateEntry) needs the
  // hosted zone + a zone store; stub it to an unlocked, non-private room so the
  // test exercises identity resolution, not the password/privacy policy.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto = SimRoom.prototype as any;
  const self = {
    authRequired,
    zone: { id: 'office' },
    zones: { isZoneAdmin: () => false, zoneHasPassword: () => false, canEnterPrivateZone: () => true },
    gateEntry: proto.gateEntry,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onAuth = proto.onAuth as (...a: any[]) => AuthInfo;
  return onAuth.call(self, undefined, undefined, authContext);
}

// --- TEST 1: cookie-path non-regression (VP1-VP4) ---

test('TEST 1 VP1/VP2: valid cookie, no token -> seeded user AuthInfo (cookie branch authorizes)', () => {
  const loginId = 't1user';
  userStore.createUser(loginId, 'secret123');
  const sid = appStore.createSession(loginId);

  // Baseline expected values computed independently of the code under test:
  // no free display name was set, so displayName falls back to the login id.
  const expected: AuthInfo = { userId: loginId, username: loginId, isAdmin: false, role: 'user' };

  const info = callOnAuth(true, { cookie: `pixel_stream_sid=${sid}` });
  assert.deepEqual(info, expected);
  // VP2: the display-name mapping (UserStore.displayName) is unchanged.
  assert.equal(info.username, loginId);

  appStore.deleteSession(sid);
  userStore.deleteUser(loginId);
});

test('TEST 1 VP3: authRequired=false -> anonymous AuthInfo, no throw (short-circuit unchanged)', () => {
  // Even with a bogus cookie AND a bogus token, the anonymous short-circuit wins.
  const info = callOnAuth(false, { cookie: 'pixel_stream_sid=bogus', token: 'bogus' });
  assert.deepEqual(info, { userId: '', username: '', isAdmin: false, role: 'user' });
});

test('TEST 1 VP4: unknown/absent cookie with authRequired=true -> throws unauthorized', () => {
  assert.throws(() => callOnAuth(true, { cookie: 'pixel_stream_sid=never-issued' }), /unauthorized/);
  assert.throws(() => callOnAuth(true, {}), /unauthorized/);
});

// --- TEST 2 VP2: onAuth AuthInfo equivalence (cookie vs bearer) ---

test('TEST 2 VP2: onAuth(bearer token) AuthInfo is field-identical to onAuth(cookie) for the same user', () => {
  // A normal (non-admin) user, and an admin user, exercised on both credential
  // forms — the bearer branch must resolve the SAME AuthInfo as the cookie.
  for (const [loginId, isAdmin] of [['t2normal', false], ['t2admin', true]] as const) {
    const user = userStore.createUser(loginId, 'secret123', { isAdmin });
    userStore.setUsername(user.userId, 'Display Name');
    const sid = appStore.createSession(loginId);

    const viaCookie = callOnAuth(true, { cookie: `pixel_stream_sid=${sid}` });
    const viaBearer = callOnAuth(true, { token: sid });

    assert.deepEqual(viaBearer, viaCookie, 'bearer AuthInfo must equal cookie AuthInfo');
    assert.deepEqual(viaBearer, { userId: loginId, username: 'Display Name', isAdmin, role: isAdmin ? 'admin' : 'user' });

    appStore.deleteSession(sid);
    userStore.deleteUser(loginId);
  }
});

// --- TEST 3 Part A: onAuth rejection (invalid/expired/signed-out token) ---

test('TEST 3A onAuth: a never-issued token -> onAuth throws unauthorized', () => {
  assert.throws(() => callOnAuth(true, { token: 'never-issued-but-valid-looking-sid' }), /unauthorized/);
});

test('TEST 3A onAuth: an expired session -> getSession lazy-deletes -> onAuth throws unauthorized', () => {
  const loginId = 't3exp';
  userStore.createUser(loginId, 'secret123');
  // Seed a session row directly with expires in the past (deterministic, no sleep).
  const store = appStore as unknown as {
    db: { prepare(sql: string): { run(...a: unknown[]): void; get(...a: unknown[]): unknown } };
  };
  const sid = 'expired-sid-t3';
  store.db.prepare('INSERT INTO sessions(sid, user_id, expires) VALUES(?, ?, ?)').run(sid, loginId, Date.now() - 1);

  assert.throws(() => callOnAuth(true, { token: sid }), /unauthorized/);
  // The expired row was lazy-deleted by getSession.
  assert.equal(store.db.prepare('SELECT sid FROM sessions WHERE sid = ?').get(sid), undefined);

  userStore.deleteUser(loginId);
});

test('TEST 3A onAuth: a signed-out (deleted) token -> onAuth throws unauthorized', () => {
  const loginId = 't3so';
  userStore.createUser(loginId, 'secret123');
  const sid = appStore.createSession(loginId);
  assert.ok(appStore.getSession(sid), 'precondition: live session');

  appStore.deleteSession(sid);
  assert.equal(appStore.getSession(sid), undefined, 'precondition: session revoked');

  assert.throws(() => callOnAuth(true, { token: sid }), /unauthorized/);

  userStore.deleteUser(loginId);
});

// --- TEST 2: issuance (VP1/VP3/VP4/VP5) ---

test('TEST 2 VP1: valid creds -> 200 with a token that is a live session row', async () => {
  const loginId = 'vp1user';
  const password = 'secret123';
  userStore.createUser(loginId, password);

  const res = await postToken({ username: loginId, password });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { token?: string };
  assert.equal(typeof body.token, 'string');
  assert.ok(body.token && body.token.length > 0);
  // The token IS a live session row resolving to the seeded user (real DB read).
  assert.equal(appStore.getSession(body.token)?.userId, loginId);
  // The desktop endpoint sets no cookie.
  assert.equal(res.headers.get('set-cookie'), null);

  appStore.deleteSession(body.token!);
  userStore.deleteUser(loginId);
});

test('TEST 2 VP3: correct admin token -> isAdmin true; normal path does not self-register', async () => {
  const adminLogin = 'vp3admin';
  const password = 'secret123';

  // Admin path creates + marks admin the account (mirrors /login).
  const adminRes = await postToken({ username: adminLogin, password, token: ADMIN_TOKEN });
  assert.equal(adminRes.status, 200);
  const adminBody = (await adminRes.json()) as { token: string };
  const adminUser = userStore.get(adminLogin);
  assert.ok(adminUser);
  assert.equal(adminUser!.isAdmin, true);

  // Normal path for an unknown user must NOT create it (no self-registration).
  const unknownLogin = 'vp3ghost';
  const ghostRes = await postToken({ username: unknownLogin, password });
  assert.equal(ghostRes.status, 401);
  assert.equal(userStore.get(unknownLogin), undefined);

  appStore.deleteSession(adminBody.token);
  userStore.deleteUser(adminLogin);
});

test('TEST 2 VP4: bad creds -> 401 generic message, no new session row', async () => {
  const loginId = 'vp4user';
  userStore.createUser(loginId, 'secret123');
  const before = sessionCount();

  // Wrong password for an existing user.
  const badPw = await postToken({ username: loginId, password: 'wrongpass' });
  assert.equal(badPw.status, 401);
  assert.deepEqual(await badPw.json(), { error: 'Invalid login id or password.' });

  // Unknown user.
  const unknown = await postToken({ username: 'vp4nobody', password: 'whatever' });
  assert.equal(unknown.status, 401);
  assert.deepEqual(await unknown.json(), { error: 'Invalid login id or password.' });

  // Wrong admin token.
  const badAdmin = await postToken({ username: 'vp4new', password: 'secret123', token: 'not-the-admin-token' });
  assert.equal(badAdmin.status, 401);
  assert.deepEqual(await badAdmin.json(), { error: 'Invalid admin token.' });
  assert.equal(userStore.get('vp4new'), undefined);

  // No session row was minted by any failed attempt.
  assert.equal(sessionCount(), before);

  userStore.deleteUser(loginId);
});

test('TEST 2 VP5: token/password/admin-token never appear in the response body or logs', async () => {
  const loginId = 'vp5user';
  const password = 'super-secret-pw-9';
  userStore.createUser(loginId, password);

  const logged: string[] = [];
  const capture = (...args: unknown[]): void => void logged.push(args.map(String).join(' '));
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  console.info = capture;

  let token: string;
  let rawBody: string;
  try {
    const okRes = await postToken({ username: loginId, password });
    rawBody = await okRes.text();
    token = (JSON.parse(rawBody) as { token: string }).token;
    // A failing admin attempt too (exercises the admin-token log path).
    await postToken({ username: 'vp5x', password, token: ADMIN_TOKEN + 'wrong' });
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
    console.info = orig.info;
  }

  const logs = logged.join('\n');
  assert.equal(logs.includes(password), false, 'password must not be logged');
  assert.equal(logs.includes(ADMIN_TOKEN), false, 'admin token must not be logged');
  assert.equal(logs.includes(token), false, 'issued token must not be logged');
  // The success body carries only the token, not the password/admin token.
  assert.equal(rawBody.includes(password), false);
  assert.equal(rawBody.includes(ADMIN_TOKEN), false);

  appStore.deleteSession(token);
  userStore.deleteUser(loginId);
});

// --- TEST 3 Part A: signout revoke lifecycle ---

test('TEST 3A: signout deletes the session row (getSession undefined afterward)', async () => {
  const loginId = 'so1user';
  userStore.createUser(loginId, 'secret123');
  const sid = appStore.createSession(loginId);
  assert.ok(appStore.getSession(sid), 'precondition: live session');

  const res = await fetch(`${baseUrl}/desktop/signout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${sid}` },
  });
  assert.equal(res.status, 204);
  assert.equal(await res.text(), '');
  assert.equal(appStore.getSession(sid), undefined, 'session revoked');

  userStore.deleteUser(loginId);
});

test('TEST 3A: signout is idempotent -> 204 on repeat and on an absent/missing sid', async () => {
  const sid = 'never-issued-but-syntactically-valid-sid';

  // Absent session.
  const first = await fetch(`${baseUrl}/desktop/signout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${sid}` },
  });
  assert.equal(first.status, 204);

  // Repeat — still 204, no leak of whether the sid existed.
  const second = await fetch(`${baseUrl}/desktop/signout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${sid}` },
  });
  assert.equal(second.status, 204);

  // No Authorization header at all — still 204 (idempotent).
  const noHeader = await fetch(`${baseUrl}/desktop/signout`, { method: 'POST' });
  assert.equal(noHeader.status, 204);
});

// --- TEST 3 Part B: CORS contract (VP5/VP6) ---
// AC-012: cross-origin requests may carry Authorization, but the response must
// NOT set Access-Control-Allow-Credentials (no cross-origin cookie surface).

const DESKTOP_ORIGIN = 'app://pixel-agents';

test('TEST 3B VP5/VP6: /desktop/token cross-origin allows Authorization, no Allow-Credentials', async () => {
  const loginId = 't3buser';
  const password = 'secret123';
  userStore.createUser(loginId, password);

  // Preflight (OPTIONS) — the browser asks whether Authorization may be sent.
  const preflight = await fetch(`${baseUrl}/desktop/token`, {
    method: 'OPTIONS',
    headers: {
      origin: DESKTOP_ORIGIN,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    },
  });
  // VP5: Authorization is allowed cross-origin.
  const allowHeaders = preflight.headers.get('access-control-allow-headers') ?? '';
  assert.match(allowHeaders, /authorization/i, 'preflight must allow the Authorization header');
  // VP6: no credentialed cross-origin cookie surface.
  assert.equal(
    preflight.headers.get('access-control-allow-credentials'),
    null,
    'preflight must NOT set Access-Control-Allow-Credentials',
  );

  // Actual cross-origin POST — same header contract on the real response.
  const res = await fetch(`${baseUrl}/desktop/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: DESKTOP_ORIGIN },
    body: JSON.stringify({ username: loginId, password }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('access-control-allow-headers') ?? '', /authorization/i);
  assert.equal(res.headers.get('access-control-allow-credentials'), null);

  const body = (await res.json()) as { token: string };
  appStore.deleteSession(body.token);
  userStore.deleteUser(loginId);
});

test('TEST 3B VP5/VP6: cross-origin /health allows Authorization, no Allow-Credentials', async () => {
  const res = await fetch(`${baseUrl}/health`, {
    method: 'GET',
    headers: { origin: DESKTOP_ORIGIN, authorization: 'Bearer whatever' },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('access-control-allow-headers') ?? '', /authorization/i);
  assert.equal(res.headers.get('access-control-allow-credentials'), null);
});

test('TEST 3B: same-origin request (no Origin header) gets no CORS headers, base flow intact', async () => {
  // A same-origin browser request carries no Origin header; desktopCors must not
  // inject cross-origin headers (base open cors() behavior for other routes is
  // preserved and no route gains Allow-Credentials).
  const res = await fetch(`${baseUrl}/health`, { method: 'GET' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get('access-control-allow-credentials'), null);
});
