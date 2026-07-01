// Desktop cross-origin auth — integration Test - Design Doc: docs/design/desktop-application-design.md
// PRD AC source: docs/prd/desktop-application-prd.md (AC-005..AC-012)
// Generated: 2026-07-01 | Budget Used: integration 3/3, fixture-e2e 0/3, service-integration-e2e 0/2
//
// ============================================================================
// SKELETON STATUS: comment-only by design.
// ----------------------------------------------------------------------------
// This file intentionally contains NO import statements and NO test-runner
// syntax (describe/it/test). Reasons:
//   1. The implementation under test does not exist yet (server/src/auth.ts
//      bearer helpers, /desktop/token, /desktop/signout, SimRoom.onAuth bearer
//      branch, index.ts CORS). A committed skeleton must stay green under the
//      project's static gates (`tsc --noEmit`, `vite build`) — importing a
//      not-yet-existing module would break `tsc`.
//   2. NO SERVER TEST RUNNER EXISTS IN THIS REPO YET. There is no test
//      framework anywhere (no *.test.* project files, no ESLint, no CI). Before
//      these skeletons can be implemented, a minimal Node test runner must be
//      introduced under server/ (the Design Doc's Quality Assurance Mechanisms
//      table records this as `adopted`: "add a minimal Node test runner").
//      Recommended: Node's built-in `node:test` + `node:assert/strict` (zero new
//      deps, aligns with the repo already using `node:sqlite`/`node:crypto`),
//      wired to a `server` package.json script (e.g. `"test": "node --test"`).
//      The Work Plan MUST include this runner-setup task before Phase "server
//      auth path" implementation.
//   The implementing task adds the executable imports, runner blocks, and
//   assertions alongside the implementation (Red -> Green within one commit).
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
//                               reads context.headers.cookie today; NEW additive
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
//   AuthContext whose headers.cookie carries `pixel_stream_sid=<sid>` (and no
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
