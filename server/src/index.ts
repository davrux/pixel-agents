import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/** Version for the startup log: env override, else the release-time version.txt,
 *  else a live `git describe` in dev, else "dev". */
function serverVersion(): string {
  const env = process.env.PIXEL_VERSION?.trim();
  if (env) return env;
  try {
    return readFileSync(fileURLToPath(new URL('../version.txt', import.meta.url)), 'utf8').trim() || 'dev';
  } catch {
    /* no release file — try git, else dev */
  }
  try {
    return (
      execSync('git describe --tags --always --dirty', {
        cwd: fileURLToPath(new URL('.', import.meta.url)),
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim() || 'dev'
    );
  } catch {
    return 'dev';
  }
}

import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import cors from 'cors';
import express, { type Request, type Response, type NextFunction, type RequestHandler } from 'express';

import { WORLD_ROOM, VOXEL_ROOM } from '@pixel/shared';

import { loadAssetBundle } from './assets.js';
import { dataPath } from './paths.js';
import { registerAuth, hasValidSession, hasValidBearerSession } from './auth.js';
import { registerAdminApi } from './adminApi.js';
import { listWorlds } from './voxel/chunkStore.js';
import { migrateItemIds } from './voxel/migrateItemIds.js';
import { arcadeTurnConfigured } from './arcadeTurn.js';
import { arcadeContentDir, getArcadeCatalog } from './arcadeCatalog.js';

// Load the repo-root .env (LIVEKIT_* for conferencing, etc.) if present — uses
// Node's built-in loader (no dependency). Missing file is fine.
try {
  process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
} catch {
  /* no .env present */
}
import { SimRoom } from './rooms/SimRoom.js';
import { VoxelRoom } from './rooms/VoxelRoom.js';
import { attachFeedServer } from './ingest/feedServer.js';
import { startMockDriver } from './ingest/mockDriver.js';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

// Single port for everything: viewer (browser), Colyseus and the agent feed
// (/feed) all share PORT. Follows the old project's PIXEL_STREAM_* convention
// (with PORT as a fallback for local dev).
const PORT = Number(process.env.PIXEL_STREAM_PORT ?? process.env.PORT ?? 2567);
const HOST = process.env.PIXEL_STREAM_HOST?.trim() || '0.0.0.0';
// Admin login token — pass --token <T> at start, or set PIXEL_ADMIN_TOKEN.
// Presenting it at login makes that user an admin (and creates them if new).
// When set, login (user id + password) is required and there is no anonymous
// mode; empty → open dev mode (no login, anonymous viewer). Agents authenticate
// the feed with their own per-user token, not this one.
const ADMIN_TOKEN = arg('--token', process.env.PIXEL_ADMIN_TOKEN ?? '').trim() || null;
const MOCK = Number(process.env.MOCK ?? 0);

const __dirname = dirname(fileURLToPath(import.meta.url));
// Built client (vite). Override with PIXEL_STREAM_CLIENT_DIR for non-standard layouts.
const clientDist = process.env.PIXEL_STREAM_CLIENT_DIR?.trim() || resolve(__dirname, '../../client/dist');

// Narrow cross-origin support for the desktop bearer path (AC-012). The desktop
// app runs from a packaged origin and must be able to send `Authorization` to
// the token/signout endpoints and to probe `/health` cross-origin. This echoes
// the request Origin and allows the `Authorization` header, but deliberately
// does NOT set `Access-Control-Allow-Credentials` — no cross-origin cookie
// surface is opened, so the same-origin cookie flow is unaffected. Same-origin
// requests (no Origin header) pass through untouched. Kept separate from the
// open `cors()` so a future tightening of the base policy leaves this contract
// intact.
const DESKTOP_CORS_PATHS = new Set(['/desktop/token', '/desktop/signout', '/health']);

export function desktopCors(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    // Only cross-origin requests to the desktop-reachable endpoints get headers.
    if (origin && DESKTOP_CORS_PATHS.has(req.path)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      // Intentionally NO Access-Control-Allow-Credentials (AC-012).
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
    }
    next();
  };
}

async function main(): Promise<void> {
  // One-time persistence migration: shift voxel item-id bands +100 (frees block
  // ids for the arcade cabinet). Idempotent; runs before any player can join.
  migrateItemIds();
  console.log('[server] decoding assets…');
  const bundle = await loadAssetBundle();
  console.log(`[server] assets ready (${bundle.messages.length} asset messages)`);

  const app = express();
  app.use(cors());
  // Narrow cross-origin headers for the desktop bearer path (Authorization
  // allowed, no credentialed cookies) — see desktopCors. Applied before the
  // routes so preflight and actual responses carry the contract.
  app.use(desktopCors());
  app.get('/health', (_req, res) => res.json({ ok: true }));
  // Existing voxel world ids — the client validates a persisted "last world" against this
  // before connecting, so an auto-reconnect never resurrects a world that was deleted.
  // When login is enforced, require a valid session (same gate as the rest of the app) so
  // world ids aren't enumerable by anonymous callers.
  app.get('/voxel/worlds', (req, res) => {
    if (ADMIN_TOKEN && !hasValidSession(req.headers.cookie) && !hasValidBearerSession(req.headers.authorization)) {
      return void res.status(401).json({ error: 'unauthorized' });
    }
    res.json({ worlds: ['default', ...listWorlds().filter((w) => w !== 'default')] });
  });

  // Arcade catalog — metadata only (titles/emulator/flags), so it's public (the
  // content files at /arcade/content are auth-gated). Registered before the auth
  // gate so the launcher can populate itself on both browser + desktop.
  app.get('/arcade/catalog', (_req, res) => res.json({ games: getArcadeCatalog() }));

  // Login + cookie-session gate (only when an admin token is configured).
  if (ADMIN_TOKEN) {
    registerAuth(app, ADMIN_TOKEN);
    registerAdminApi(app); // admin-only user/room management REST API (admin.html)
    console.log('[server] login required (--token / PIXEL_ADMIN_TOKEN set)');
  }
  // Arcade content (js-dos bundles, emulator ROMs, …) + its catalog.json are NOT in
  // the image — the operator bind-mounts ARCADE_CONTENT_DIR at runtime. The catalog
  // (metadata only) is public; the files are auth-gated (see auth.ts: /arcade/content
  // is not treated as a public asset). Served BEFORE the client build.
  const contentDir = arcadeContentDir();
  if (contentDir && existsSync(contentDir)) {
    app.use('/arcade/content', express.static(contentDir));
    console.log(`[server] arcade: content dir ${contentDir} (${getArcadeCatalog().length} games in catalog)`);
  } else if (contentDir) {
    console.warn(`[server] arcade: ARCADE_CONTENT_DIR=${contentDir} does not exist — no games available`);
  } else {
    console.log('[server] arcade: no ARCADE_CONTENT_DIR set — no games available');
  }
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
    console.log(`[server] serving client build from ${clientDist}`);
  }

  // TLS: if a cert + key are present in the data dir (alongside the SQLite DB),
  // serve HTTPS/WSS — required for camera/mic/screen-share (secure context) and
  // used for dev + first-step production. Falls back to plain HTTP otherwise
  // (e.g. behind a TLS-terminating reverse proxy). Override paths with
  // PIXEL_TLS_CERT / PIXEL_TLS_KEY (e.g. later for Let's Encrypt).
  const certPath = process.env.PIXEL_TLS_CERT || dataPath('cert.pem');
  const keyPath = process.env.PIXEL_TLS_KEY || dataPath('key.pem');
  const useTls = existsSync(certPath) && existsSync(keyPath);
  const httpServer = useTls
    ? createHttpsServer({ cert: readFileSync(certPath), key: readFileSync(keyPath) }, app)
    : createServer(app);
  // ws-transport defaults maxPayload to 4 KB — far too small for saved layouts
  // (an expanded office with per-tile colours) and asset-editor saves (a single
  // character is ~100 KB of SpriteData). Editor ops are authenticated, so allow
  // up to 8 MB.
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer, maxPayload: 8 * 1024 * 1024 }),
  });
  // Resolve the version once: logged at startup and handed to each room so the
  // client can show it next to the connection status.
  const version = serverVersion();
  // One room type, matchmade per zone: joinOrCreate({ zone }) groups players into
  // the same instance for a zone and a separate instance per other zone.
  // No visitors anywhere: every room + the feed require a logged-in account (a valid
  // session cookie / bearer). Login is served by registerAuth, which needs an admin
  // token to be configured — without one nobody can join (there is no anonymous mode).
  if (!ADMIN_TOKEN) console.warn('[server] NO PIXEL_ADMIN_TOKEN set → login is unavailable and NOBODY can join (no-visitor policy). Set --token / PIXEL_ADMIN_TOKEN.');
  gameServer.define(WORLD_ROOM, SimRoom, { bundle, authRequired: true, version }).filterBy(['zone']);
  // Voxel MMO world: one authoritative instance per world id (multiworld),
  // matchmade by `world`. Persistent chunks + server-authoritative edits.
  gameServer.define(VOXEL_ROOM, VoxelRoom, { authRequired: true, version }).filterBy(['world']);

  // Mount the agent feed (/feed) on the same http server (after Colyseus has
  // registered its upgrade listener, so the dispatcher can delegate to it).
  attachFeedServer(httpServer, { authRequired: true });

  console.log(
    arcadeTurnConfigured()
      ? '[server] arcade IPX: TURN relay configured (NAT-to-NAT play enabled)'
      : '[server] arcade IPX: no TURN configured — set ARCADE_TURN_URLS + ARCADE_TURN_SECRET for internet play behind NAT (STUN-only otherwise)',
  );

  httpServer.listen(PORT, HOST, () => {
    const scheme = useTls ? 'https' : 'http';
    console.log(`[server] pixel-agents ${version}`);
    console.log(`[server] listening on ${scheme}://${HOST}:${PORT} (viewer + Colyseus + /feed)`);
    if (useTls) console.log(`[server] TLS enabled (cert: ${certPath})`);
  });

  if (MOCK > 0) startMockDriver(MOCK);
}

// Only boot the server when run as the entrypoint. Importing this module (e.g.
// to reuse `desktopCors` in tests) must not start Colyseus or load assets.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
