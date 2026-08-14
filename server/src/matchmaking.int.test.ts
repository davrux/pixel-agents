// Matchmaking wiring — integration test.
//
// ============================================================================
// WHY THIS FILE EXISTS
// ----------------------------------------------------------------------------
// The Colyseus 0.16 → 0.17 upgrade silently broke every room join, and nothing
// in the existing suite noticed: the server compiled, booted and logged
// "listening", but `POST /matchmake/*` returned an express 404 and no client
// could connect.
//
// The cause: 0.17's `WebSocketTransport` options extend ws's `ServerOptions`,
// which already contains `server`, so the 0.16-era
// `new WebSocketTransport({ server: httpServer })` still typechecked while no
// longer mounting the matchmaking HTTP routes. 0.17 binds those routes (and
// publishes the global transport the route handler reads) in `listen()` /
// `serverless()`. This server owns its own http server — TLS plus the shared
// /feed upgrade path — so index.ts calls `serverless()` explicitly.
//
// auth.desktop.int.test.ts deliberately mocks the Colyseus transport
// (@mock-boundary: onAuth is called as a pure function), which is exactly why
// that suite stayed green through the breakage. This file takes the opposite
// boundary and asserts against a REAL booted server process.
// ----------------------------------------------------------------------------
//
// TEST BOUNDARIES:
//   @real-dependency: the whole server entrypoint -- Mock? NO.
//       The regression lived in index.ts's own wiring, so a test that rebuilds
//       an equivalent express + Colyseus app by hand would pass even with
//       index.ts broken. We spawn `src/index.ts` the way `pnpm start` does and
//       talk to it over the network.
//   @real-dependency: SQLite session store -- Mock? NO. A throwaway
//       PIXEL_STREAM_DATA_DIR per run keeps it isolated.
//
// NOT covered here (honest absence): state replication correctness (the
// schema-4 encode/decode pair) — that needs a full client SDK in the server
// package, which is not a dependency here. This file proves rooms are
// reachable and gated, not that every synced field decodes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';

/** The room name index.ts registers (shared/protocol.ts WORLD_ROOM). */
const WORLD_ROOM = 'world';
/** Any zone id: these tests assert that the world room is matchmakeable at all,
 *  and an unknown zone resolves to the default one — so naming a real zone here
 *  would only couple the test to whichever zone happens to be the default. */
const ANY_ZONE = 'any-zone';
const ADMIN_TOKEN = 'matchmaking-int-test-token';
/** Asset decoding on boot dominates startup; keep this well clear of it. */
const BOOT_TIMEOUT_MS = 60_000;

let child: ChildProcessWithoutNullStreams;
let dataDir: string;
let baseUrl: string;

/** Claim an ephemeral port, then release it for the server to bind. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

before(async () => {
  const port = await freePort();
  dataDir = mkdtempSync(join(tmpdir(), 'pixel-matchmaking-test-'));
  baseUrl = `http://127.0.0.1:${port}`;
  const serverDir = fileURLToPath(new URL('..', import.meta.url));

  // Boot the real entrypoint. `--token` is passed as an argv flag (index.ts
  // prefers it over the environment) so the run is independent of any operator
  // .env — and process.loadEnvFile never overrides vars already set here.
  child = spawn('node', ['--import', 'tsx', 'src/index.ts', '--token', ADMIN_TOKEN], {
    cwd: serverDir,
    env: {
      ...process.env,
      PIXEL_STREAM_PORT: String(port),
      PIXEL_STREAM_HOST: '127.0.0.1',
      PIXEL_STREAM_DATA_DIR: dataDir,
      MOCK: '0',
    },
  }) as ChildProcessWithoutNullStreams;

  const log: string[] = [];
  child.stdout.on('data', (d: Buffer) => log.push(d.toString()));
  child.stderr.on('data', (d: Buffer) => log.push(d.toString()));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server did not report "listening" in ${BOOT_TIMEOUT_MS}ms:\n${log.join('')}`)),
      BOOT_TIMEOUT_MS,
    );
    const settle = () => {
      if (log.join('').includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', settle);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code}):\n${log.join('')}`));
    });
  });
});

after(() => {
  child?.kill('SIGKILL');
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

/** Ask the matchmaker for a seat, returning status + parsed body. */
async function matchmake(roomName: string, options: object = {}, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}/matchmake/joinOrCreate/${roomName}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(options),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* express error pages are HTML, not JSON — leave body empty */
  }
  return { status: res.status, body, text };
}

// --- The regression itself -------------------------------------------------

test('matchmaking routes are mounted: an undefined room name is answered by Colyseus, not express', async () => {
  // Deliberately an unregistered name: it exercises the route + the published
  // transport without creating a room or starting a simulation.
  const { status, body, text } = await matchmake('no_such_room');

  // A 404 here is the exact regression this file guards: express answered
  // because Colyseus never mounted /matchmake/* (index.ts missing its
  // `serverless()` call). A 500 would mean the route is mounted but the global
  // transport was never published.
  assert.notEqual(status, 404, `/matchmake/* is not mounted — express answered 404 with: ${text.slice(0, 200)}`);
  assert.notEqual(status, 500, `/matchmake/* is mounted but the transport is not published: ${text.slice(0, 200)}`);

  // ErrorCode.MATCHMAKE_NO_HANDLER — proof the matchmaker itself replied.
  assert.equal(status, 520);
  assert.equal(body.code, 520);
  assert.match(String(body.error), /not defined/);
});

test('the world room is matchmakeable: a seat reservation is issued', async () => {
  const { status, body } = await matchmake(WORLD_ROOM, { zone: ANY_ZONE });

  assert.equal(status, 200);
  // The seat reservation the client feeds into its websocket join URL.
  assert.equal(body.name, WORLD_ROOM);
  assert.ok(typeof body.sessionId === 'string' && body.sessionId.length > 0, 'expected a sessionId');
  assert.ok(typeof body.roomId === 'string' && body.roomId.length > 0, 'expected a roomId');
  assert.ok(typeof body.processId === 'string' && body.processId.length > 0, 'expected a processId');
});

// --- The room-entry gate ---------------------------------------------------

/** Mint a bearer session the same way the desktop app does. */
async function mintToken(username: string): Promise<string> {
  const res = await fetch(`${baseUrl}/desktop/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'secret123', token: ADMIN_TOKEN }),
  });
  assert.equal(res.status, 200, 'expected /desktop/token to issue a bearer session');
  return (await res.json()).token as string;
}

/** Complete a websocket join against a reservation; did the server keep us?
 *  Acceptance is "still connected after a settle window", NOT "a frame arrived":
 *  a refused join is sent an error frame and only then closed, so treating the
 *  first message as success would read every rejection as an accept. */
function joinOutcome(url: string): Promise<'accepted' | 'closed'> {
  const SETTLE_MS = 1500;
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let settled = false;
    const done = (outcome: 'accepted' | 'closed') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      resolve(outcome);
    };
    // A rejected join is closed by the server (CloseCode.WITH_ERROR, 4002).
    ws.on('close', () => done('closed'));
    ws.on('error', () => done('closed'));
    const timer = setTimeout(() => done('accepted'), SETTLE_MS);
  });
}

async function joinUrl(token?: string): Promise<string> {
  const { status, body } = await matchmake(WORLD_ROOM, { zone: ANY_ZONE });
  // Assert the reservation first: otherwise a broken matchmaking mount yields a
  // nonsense URL whose socket also closes, and the "refused" cases below would
  // pass for entirely the wrong reason.
  assert.equal(status, 200, 'cannot exercise the entry gate without a seat reservation');
  assert.ok(body.processId && body.roomId && body.sessionId, 'incomplete seat reservation');
  const auth = token ? `&_authToken=${encodeURIComponent(token)}` : '';
  return `ws://127.0.0.1:${new URL(baseUrl).port}/${body.processId}/${body.roomId}?sessionId=${body.sessionId}${auth}`;
}

test('a seat reservation is not entry: 0.17 defers onAuth to the websocket join', async () => {
  // Note the HTTP reservation above succeeds without credentials — unlike 0.16,
  // 0.17 runs onAuth on the websocket join. The no-visitor policy therefore
  // depends on the join being refused, not on matchmaking rejecting anyone.
  assert.equal(await joinOutcome(await joinUrl()), 'closed');
});

test('an invalid bearer token is refused at the websocket join', async () => {
  assert.equal(await joinOutcome(await joinUrl('not-a-real-session-id')), 'closed');
});

test('a valid bearer session is admitted to the world room', async () => {
  const token = await mintToken('matchmaking-int-user');
  assert.equal(await joinOutcome(await joinUrl(token)), 'accepted');
});
